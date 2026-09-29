import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, document, type HermesRuntime } from "./src/index.js"

const send = (runtime: HermesRuntime, path: string, body?: unknown, namespace = "a") =>
  runtime.fetch(
    new Request(`http://hermes.mock${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const start = async (
  runtime: HermesRuntime,
  body: unknown = { input: "synthetic prompt" },
  ns = "a",
) => {
  const response = await send(runtime, "/v1/runs", body, ns)
  expect(response.status).toBe(202)
  const result = (await response.json()) as { run_id: string; status: string; replayed: boolean }
  expect(result).toEqual({
    run_id: expect.stringMatching(/^run_[0-9a-f]{32}$/),
    status: "started",
    replayed: false,
  })
  expect(response.headers.get("Idempotency-Replayed")).toBeNull()
  return result.run_id
}
const poll = async (runtime: HermesRuntime, id: string, ns = "a") => {
  const response = await send(runtime, `/v1/runs/${id}`, undefined, ns)
  expect(response.status).toBe(200)
  return response.json()
}
const observe = (runtime: HermesRuntime, id: string, body: unknown, ns = "a") =>
  send(runtime, `/__admin/hermes/runs/${id}/observe`, body, ns)

test("admission returns started while repeated polling preserves queued state and identity", async () => {
  const clock = createClock(() => 1_700_000_000_125)
  clock.freeze()
  const runtime = createRuntime({ clock })
  const id = await start(runtime)
  const expected = {
    object: "hermes.run",
    run_id: id,
    status: "queued",
    created_at: 1_700_000_000.125,
    updated_at: 1_700_000_000.125,
    session_id: id,
    model: "hermes-agent",
  }
  expect(await poll(runtime, id)).toEqual(expected)
  expect(await poll(runtime, id)).toEqual(expected)
  expect(await start(runtime)).not.toBe(id)
})

test("submission preserves session and model without using them as run identity", async () => {
  const runtime = createRuntime()
  const body = {
    input: [{ role: "assistant", content: "synthetic text" }],
    model: "synthetic-model",
    session_id: "synthetic-session",
    previous_response_id: "missing-is-ignored",
    conversation_history: [{ role: 1, content: null }],
  }
  const first = await start(runtime, body)
  const second = await start(runtime, body)
  expect(first).not.toBe(second)
  expect(await poll(runtime, first)).toMatchObject({
    session_id: body.session_id,
    model: body.model,
  })
  const response = await runtime.fetch(
    new Request("http://hermes.mock/ns/a/v1/runs", {
      method: "POST",
      headers: { "X-Hermes-Session-Key": "synthetic-memory", "content-type": "text/plain" },
      body: JSON.stringify({ input: "synthetic input" }),
    }),
  )
  expect(response.status).toBe(202)
  expect(response.headers.get("X-Hermes-Session-Key")).toBe("synthetic-memory")
  const { run_id } = (await response.json()) as { run_id: string }
  expect(await poll(runtime, run_id)).toMatchObject({ session_id: run_id })
})

test("known validation errors use the pinned envelope and do not admit a run", async () => {
  const runtime = createRuntime()
  const cases: [unknown, string][] = [
    [{}, "Missing 'input' field"],
    [{ input: [] }, "Missing 'input' field"],
    [{ input: {} }, "Missing 'input' field"],
    [{ input: 1 }, "No user message found in input"],
    [{ input: [{ role: "user", content: "" }] }, "No user message found in input"],
    [
      { input: "ok", conversation_history: "bad" },
      "'conversation_history' must be an array of message objects",
    ],
    [
      { input: "ok", conversation_history: [{}] },
      "conversation_history[0] must have 'role' and 'content' fields",
    ],
  ]
  for (const [body, message] of cases) {
    const response = await send(runtime, "/v1/runs", body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { message, type: "invalid_request_error", param: null, code: null },
    })
  }
  const malformed = await runtime.fetch(
    new Request("http://hermes.mock/ns/a/v1/runs", { method: "POST", body: "{" }),
  )
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toEqual({
    error: { message: "Invalid JSON", type: "invalid_request_error", param: null, code: null },
  })
  // Validation did not consume the deterministic identity sequence.
  expect(await start(runtime)).toBe(await start(createRuntime()))
})

test("unverified malformed and unimplemented feature paths fail explicitly without invented vendor errors", async () => {
  const runtime = createRuntime()
  for (const body of [null, [], { input: [null] }, { input: "x", hosted_room_dispatch: {} }]) {
    const response = await send(runtime, "/v1/runs", body)
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { type: "mockingbird_unsupported" } })
  }
})

test("scripted observations preserve timestamps, remove approval on resume, and settle synthetic output", async () => {
  const clock = createClock(() => 1_700_000_000_000)
  clock.freeze()
  const runtime = createRuntime({ clock })
  const id = await start(runtime)
  await send(runtime, "/__admin/clock", { advance: 1250 })
  expect((await observe(runtime, id, { status: "running" })).status).toBe(200)
  expect(await poll(runtime, id)).toMatchObject({
    status: "running",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001.25,
  })
  expect(
    (
      await observe(runtime, id, {
        status: "waiting_for_approval",
        approval: { command: "synthetic-command" },
      })
    ).status,
  ).toBe(200)
  expect(await poll(runtime, id)).toMatchObject({
    status: "waiting_for_approval",
    last_event: "approval.request",
    approval: { command: "synthetic-command" },
  })
  await observe(runtime, id, { status: "running" })
  expect(await poll(runtime, id)).not.toHaveProperty("approval")
  const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
  expect(
    (await observe(runtime, id, { status: "completed", output: "synthetic-result", usage })).status,
  ).toBe(200)
  const settled = await poll(runtime, id)
  expect(settled).toMatchObject({
    status: "completed",
    last_event: "run.completed",
    output: "synthetic-result",
    usage,
  })
  expect((await observe(runtime, id, { status: "running" })).status).toBe(409)
  expect(await poll(runtime, id)).toEqual(settled)
})

test("scripted failure, cancellation, interruption and stopping remain distinct observations", async () => {
  const runtime = createRuntime()
  for (const status of ["failed", "cancelled", "interrupted"] as const) {
    const id = await start(runtime)
    expect((await observe(runtime, id, { status: "stopping" })).status).toBe(200)
    expect(await poll(runtime, id)).toMatchObject({ status: "stopping" })
    const error = status === "cancelled" ? {} : { error: "synthetic failure" }
    expect((await observe(runtime, id, { status, ...error })).status).toBe(200)
    expect(await poll(runtime, id)).toMatchObject({ status, last_event: `run.${status}`, ...error })
    expect(await poll(runtime, id)).not.toHaveProperty("output")
  }
})

test("observation controls reject invalid payloads atomically", async () => {
  const runtime = createRuntime()
  const id = await start(runtime)
  const initial = await poll(runtime, id)
  for (const body of [
    { status: "unknown" },
    { status: "completed", usage: { total_tokens: -1 } },
    { status: "running", output: "bad" },
    { status: "running", run_id: "replacement" },
  ]) {
    expect((await observe(runtime, id, body)).status).toBe(400)
    expect(await poll(runtime, id)).toEqual(initial)
  }
})

test("namespace isolation, reset and Timeline apply to real run state; journals exclude prompt and output", async () => {
  const runtime = createRuntime()
  const id = await start(runtime)
  const missing = await send(runtime, `/v1/runs/${id}`, undefined, "b")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({
    error: {
      message: `Run not found: ${id}`,
      type: "invalid_request_error",
      param: null,
      code: "run_not_found",
    },
  })
  expect((await observe(runtime, id, { status: "running" }, "b")).status).toBe(404)
  const checkpoint = (await (await send(runtime, "/__admin/checkpoints", {})).json()) as {
    id: string
  }
  await observe(runtime, id, { status: "completed", output: "synthetic-result-private" })
  await poll(runtime, id)
  const journal = JSON.stringify(runtime.journal.list({ namespace: "a" }))
  expect(journal).not.toContain("synthetic prompt")
  expect(journal).not.toContain("synthetic-result-private")
  expect(
    (await send(runtime, "/__admin/branches/main/checkout", { checkpoint: checkpoint.id })).status,
  ).toBe(200)
  expect(await poll(runtime, id)).toMatchObject({ status: "queued" })
  expect(await poll(runtime, id)).not.toHaveProperty("output")
  const other = await start(runtime, { input: "other" }, "b")
  expect((await send(runtime, "/__admin/reset", {})).status).toBe(200)
  expect((await send(runtime, `/v1/runs/${id}`)).status).toBe(404)
  expect(await poll(runtime, other, "b")).toMatchObject({ status: "queued" })
})

test("public submission, polling and errors conform to the annotated contract", async () => {
  const runtime = createRuntime()
  const check = async (response: Response, operationId: string) => {
    const operation = findOperation(document, operationId)
    if (!operation) throw new Error(`Missing operation ${operationId}`)
    const schema = responseForStatus(operation.responses, response.status)?.content?.[
      "application/json"
    ]?.schema
    if (!schema) throw new Error(`Missing schema ${operationId} ${response.status}`)
    const value = await response.json()
    expect(validateValue(document, schema, value)).toEqual([])
    return value
  }
  const accepted = (await check(
    await send(runtime, "/v1/runs", { input: "synthetic" }),
    "RunCreate",
  )) as { run_id: string }
  await check(await send(runtime, `/v1/runs/${accepted.run_id}`), "RunGet")
  await observe(runtime, accepted.run_id, { status: "completed" })
  await check(await send(runtime, `/v1/runs/${accepted.run_id}`), "RunGet")
  await check(await send(runtime, "/v1/runs", {}), "RunCreate")
  await check(await send(runtime, "/v1/runs", null), "RunCreate")
  await check(await send(runtime, "/v1/runs/missing"), "RunGet")
})

test("the pinned model key default distinguishes absent from explicitly falsy values", async () => {
  const runtime = createRuntime()
  expect(await poll(runtime, await start(runtime))).toMatchObject({ model: "hermes-agent" })
  for (const model of [null, "", false, 0, [], {}]) {
    const id = await start(runtime, { input: "synthetic", model })
    expect(await poll(runtime, id)).toMatchObject({ model })
  }
  const id = await start(runtime, { input: "synthetic", model: "synthetic-model" })
  expect(await poll(runtime, id)).toMatchObject({ model: "synthetic-model" })
})
