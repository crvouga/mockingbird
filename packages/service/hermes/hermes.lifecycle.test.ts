import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, document, type HermesRuntime } from "./src/index.js"

const call = (runtime: HermesRuntime, path: string, body?: unknown, namespace = "a", key = "") =>
  runtime.fetch(
    new Request(`http://hermes.mock${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-mockingbird-namespace": namespace,
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const start = async (runtime: HermesRuntime, key = "", namespace = "a") => {
  const response = await call(runtime, "/v1/runs", { input: "synthetic" }, namespace, key)
  expect(response.status).toBe(202)
  return (await response.json()) as { run_id: string; status: string; replayed: boolean }
}
const observe = (runtime: HermesRuntime, id: string, body: unknown, namespace = "a") =>
  call(runtime, `/__admin/hermes/runs/${id}/observe`, body, namespace)
const poll = async (runtime: HermesRuntime, id: string, namespace = "a") => {
  const response = await call(runtime, `/v1/runs/${id}`, undefined, namespace)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}
const stop = (runtime: HermesRuntime, id: string, namespace = "a") =>
  call(runtime, `/v1/runs/${id}/stop`, {}, namespace)
const restart = (runtime: HermesRuntime, owner = "stale", namespace = "a") =>
  call(runtime, "/__admin/hermes/restart", { owner }, namespace)

test("stop acceptance preserves active work until scripted cancellation, failure or winning completion", async () => {
  const runtime = createRuntime()
  for (const outcome of ["cancelled", "failed", "completed"] as const) {
    const { run_id: id } = await start(runtime, outcome)
    await observe(runtime, id, { status: "running" })
    for (let i = 0; i < 2; i++) {
      const response = await stop(runtime, id)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ run_id: id, status: "stopping" })
      expect(await poll(runtime, id)).toMatchObject({
        status: "stopping",
        last_event: "run.stopping",
      })
    }
    expect((await start(runtime, outcome)).status).toBe("stopping")
    const fields =
      outcome === "completed"
        ? { output: "synthetic result" }
        : outcome === "failed"
          ? { error: "synthetic failure" }
          : {}
    expect((await observe(runtime, id, { status: outcome, ...fields })).status).toBe(200)
    const terminal = await poll(runtime, id)
    expect(terminal).toMatchObject({ status: outcome, last_event: `run.${outcome}`, ...fields })
    const response = await stop(runtime, id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(terminal)
  }
})

test("queued stop remains stopping until cancellation and missing or foreign runs use404", async () => {
  const runtime = createRuntime()
  const { run_id: id } = await start(runtime)
  expect((await stop(runtime, id)).status).toBe(200)
  expect(await poll(runtime, id)).toMatchObject({ status: "stopping" })
  await observe(runtime, id, { status: "cancelled" })
  for (const [runId, namespace] of [
    ["missing", "a"],
    [id, "b"],
  ] as const) {
    const response = await stop(runtime, runId, namespace)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: `Run not found: ${runId}`,
        type: "invalid_request_error",
        param: null,
        code: "run_not_found",
      },
    })
  }
})

test("stale-owner restart interrupts keyed work lazily, preserves terminal runs and loses keyless work", async () => {
  const clock = createClock(() => 1_700_000_000_000)
  clock.freeze()
  const runtime = createRuntime({ clock })
  const unfinished = await start(runtime, "unfinished")
  await observe(runtime, unfinished.run_id, {
    status: "waiting_for_approval",
    approval: { command: "synthetic" },
  })
  const terminal = await start(runtime, "terminal")
  await observe(runtime, terminal.run_id, { status: "completed", output: "saved" })
  const before = await poll(runtime, terminal.run_id)
  const keyless = await start(runtime)
  await call(runtime, "/__admin/clock", { advance: 1000 })
  expect((await restart(runtime)).status).toBe(200)
  await call(runtime, "/__admin/clock", { advance: 1000 })
  const interrupted = await poll(runtime, unfinished.run_id)
  expect(interrupted).toMatchObject({
    status: "interrupted",
    error: "The gateway restarted before this run settled.",
    last_event: "run.interrupted",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_002,
    approval: { command: "synthetic" },
  })
  expect(await start(runtime, "unfinished")).toEqual({
    run_id: unfinished.run_id,
    status: "interrupted",
    replayed: true,
  })
  expect((await start(runtime, "replacement")).run_id).not.toBe(unfinished.run_id)
  expect((await observe(runtime, unfinished.run_id, { status: "running" })).status).toBe(409)
  expect(await (await stop(runtime, unfinished.run_id)).json()).toEqual(interrupted)
  expect(await poll(runtime, terminal.run_id)).toEqual(before)
  expect((await start(runtime, "terminal")).status).toBe("completed")
  expect((await call(runtime, `/v1/runs/${keyless.run_id}`)).status).toBe(404)
  await restart(runtime)
  expect(await poll(runtime, unfinished.run_id)).toEqual(interrupted)
})

test("live foreign owner retains its status but cannot be stopped by the restarted gateway", async () => {
  const runtime = createRuntime()
  const run = await start(runtime, "live")
  await observe(runtime, run.run_id, { status: "running" })
  const before = await poll(runtime, run.run_id)
  expect((await restart(runtime, "alive")).status).toBe(200)
  expect(await poll(runtime, run.run_id)).toEqual(before)
  const response = await stop(runtime, run.run_id)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: {
      message: `Run is not active in this gateway process: ${run.run_id}`,
      type: "invalid_request_error",
      param: null,
      code: "run_not_active",
    },
  })
  expect(await start(runtime, "live")).toEqual({
    run_id: run.run_id,
    status: "running",
    replayed: true,
  })
  // An explicit observation can model the original owner's later completion.
  await observe(runtime, run.run_id, { status: "completed", output: "foreign completion" })
  expect(await (await stop(runtime, run.run_id)).json()).toEqual(await poll(runtime, run.run_id))
})

test("restart is namespace scoped and Timeline restores ownership and dedup with state", async () => {
  const runtime = createRuntime()
  const a = await start(runtime, "a")
  const b = await start(runtime, "b", "b")
  const response = await call(runtime, "/__admin/checkpoints", {})
  const { id } = (await response.json()) as { id: string }
  expect((await restart(runtime, "unknown")).status).toBe(400)
  expect((await restart(runtime)).status).toBe(200)
  expect((await start(runtime, "a")).status).toBe("interrupted")
  expect(await poll(runtime, b.run_id, "b")).toMatchObject({ status: "queued" })
  expect((await call(runtime, "/__admin/branches/main/checkout", { checkpoint: id })).status).toBe(
    200,
  )
  expect((await start(runtime, "a")).status).toBe("queued")
  expect((await stop(runtime, a.run_id)).status).toBe(200)
})

test("stop responses conform to declared200,404 and409 schemas", async () => {
  const runtime = createRuntime()
  const run = await start(runtime, "contract")
  const check = async (response: Response, expected: number) => {
    expect(response.status).toBe(expected)
    const operation = findOperation(document, "RunStop")
    if (!operation) throw new Error("missing RunStop")
    const schema = responseForStatus(operation.responses, response.status)?.content?.[
      "application/json"
    ]?.schema
    if (!schema) throw new Error(`missing schema${response.status}`)
    expect(validateValue(document, schema, await response.json())).toEqual([])
  }
  await check(await stop(runtime, run.run_id), 200)
  await restart(runtime, "alive")
  await check(await stop(runtime, run.run_id), 409)
  await check(await stop(runtime, "missing"), 404)
  await restart(runtime)
  await check(await stop(runtime, run.run_id), 200)
})

test("restart preserves every terminal state and interrupts every unfinished state", async () => {
  const runtime = createRuntime()
  const unfinished = ["queued", "running", "waiting_for_approval", "stopping"] as const
  const terminal = ["completed", "failed", "cancelled", "interrupted"] as const
  const runs = new Map<string, Record<string, unknown>>()
  for (const state of [...unfinished, ...terminal]) {
    const { run_id } = await start(runtime, state)
    if (state !== "queued") await observe(runtime, run_id, { status: state })
    runs.set(state, await poll(runtime, run_id))
  }
  expect((await call(runtime, "/__admin/hermes/restart", { owner: ["alive"] })).status).toBe(400)
  await restart(runtime)
  for (const state of unfinished) {
    const old = runs.get(state)
    if (!old) throw new Error(`Missing fixture ${state}`)
    expect(await start(runtime, state)).toEqual({
      run_id: String(old.run_id),
      status: "interrupted",
      replayed: true,
    })
  }
  for (const state of terminal) {
    const old = runs.get(state)
    if (!old) throw new Error(`Missing fixture ${state}`)
    expect(await poll(runtime, String(old.run_id))).toEqual(old)
  }
})
