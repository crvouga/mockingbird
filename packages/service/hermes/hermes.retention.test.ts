import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, type HermesRuntime } from "./src/index.js"

const base = 1_700_000_000_000
const setup = () => {
  const clock = createClock(() => base)
  clock.freeze()
  return { clock, runtime: createRuntime({ clock }) }
}
const call = (runtime: HermesRuntime, path: string, body?: unknown, key = "", ns = "a") =>
  runtime.fetch(
    new Request(`http://hermes.mock${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-mockingbird-namespace": ns,
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const start = async (runtime: HermesRuntime, key = "", ns = "a") => {
  const r = await call(runtime, "/v1/runs", { input: "synthetic" }, key, ns)
  expect(r.status).toBe(202)
  return (await r.json()) as { run_id: string; status: string; replayed: boolean }
}
const observe = (runtime: HermesRuntime, id: string, body: unknown, ns = "a") =>
  call(runtime, `/__admin/hermes/runs/${id}/observe`, body, "", ns)
const get = (runtime: HermesRuntime, id: string, ns = "a") =>
  call(runtime, `/v1/runs/${id}`, undefined, "", ns)
const sweep = (runtime: HermesRuntime) => call(runtime, "/__admin/hermes/sweep", {})

test("cache sweep retains exact hour equality and expires only completed failed cancelled", async () => {
  const { clock, runtime } = setup()
  const ids = new Map<string, string>()
  for (const status of ["completed", "failed", "cancelled", "interrupted", "running"]) {
    const run = await start(runtime)
    ids.set(status, run.run_id)
    await observe(runtime, run.run_id, { status })
  }
  clock.advance(3_600_000)
  expect((await sweep(runtime)).status).toBe(200)
  for (const id of ids.values()) expect((await get(runtime, id)).status).toBe(200)
  clock.advance(1)
  await sweep(runtime)
  for (const [status, id] of ids) {
    const response = await get(runtime, id)
    expect(response.status).toBe(["interrupted", "running"].includes(status) ? 200 : 404)
    if (response.status === 404)
      expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } })
  }
})

test("scheduled cache cleanup uses 60 second ticks instead of expiring between ticks", async () => {
  const { clock, runtime } = setup()
  const run = await start(runtime)
  await observe(runtime, run.run_id, { status: "completed" })
  clock.advance(3_600_001)
  expect((await get(runtime, run.run_id)).status).toBe(200)
  clock.advance(59_999)
  expect((await get(runtime, run.run_id)).status).toBe(404)
})

test("GET hydrates expired cache without pruning durable records beyond 24 hours", async () => {
  const { clock, runtime } = setup()
  const run = await start(runtime, "retained")
  await observe(runtime, run.run_id, { status: "completed", output: "synthetic saved" })
  clock.advance(86_400_001)
  const response = await get(runtime, run.run_id)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: "completed", output: "synthetic saved" })
  // Only admission with a nonempty key triggers durable pruning.
  await start(runtime)
  expect((await get(runtime, run.run_id)).status).toBe(200)
  await start(runtime, "trigger")
  // Recently hydrated cache can outlive its now-pruned durable reservation.
  expect((await get(runtime, run.run_id)).status).toBe(200)
  await sweep(runtime)
  expect((await get(runtime, run.run_id)).status).toBe(404)
  const replacement = await start(runtime, "retained")
  expect(replacement.replayed).toBe(false)
  expect(replacement.run_id).not.toBe(run.run_id)
})

test("durable terminal reservations retain 24 hour equality then allow a new admission", async () => {
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
    const { clock, runtime } = setup()
    const run = await start(runtime, status)
    await observe(runtime, run.run_id, { status })
    clock.set(base + 86_400_000)
    expect(await start(runtime, status)).toEqual({ run_id: run.run_id, status, replayed: true })
    clock.advance(1)
    const replacement = await start(runtime, status)
    expect(replacement.replayed).toBe(false)
    expect(replacement.run_id).not.toBe(run.run_id)
  }
})

test("active reservations never expire by age and progress timestamps stay independent", async () => {
  const { clock, runtime } = setup()
  const run = await start(runtime, "active")
  await observe(runtime, run.run_id, { status: "running", last_event: "run.started" })
  clock.advance(172_800_000)
  await observe(runtime, run.run_id, { status: "running", last_event: "tool.started" })
  expect((await start(runtime, "active")).replayed).toBe(true)
  expect(await (await get(runtime, run.run_id)).json()).toMatchObject({
    last_event: "tool.started",
    updated_at: (base + 172_800_000) / 1000,
  })
  await call(runtime, "/__admin/hermes/restart", { owner: "alive" })
  // Same-status progress does not persist; restart hydrates the prior durable payload.
  expect(await (await get(runtime, run.run_id)).json()).toMatchObject({
    status: "running",
    last_event: "run.started",
    updated_at: base / 1000,
  })
  await observe(runtime, run.run_id, { status: "completed" })
  clock.advance(86_400_000)
  expect((await start(runtime, "active")).replayed).toBe(true)
  clock.advance(1)
  expect((await start(runtime, "active")).replayed).toBe(false)
})

test("interrupted cache survives durable expiry but logical restart cannot resurrect a pruned row", async () => {
  const { clock, runtime } = setup()
  const run = await start(runtime, "interrupted")
  await call(runtime, "/__admin/hermes/restart", { owner: "stale" })
  expect((await start(runtime, "interrupted")).status).toBe("interrupted")
  clock.advance(86_400_001)
  const replacement = await start(runtime, "interrupted")
  expect(replacement.replayed).toBe(false)
  await sweep(runtime)
  expect(await (await get(runtime, run.run_id)).json()).toMatchObject({ status: "interrupted" })
  await call(runtime, "/__admin/hermes/restart", { owner: "stale" })
  expect((await get(runtime, run.run_id)).status).toBe(404)
  expect((await start(runtime, "interrupted")).run_id).toBe(replacement.run_id)
})

test("Timeline restores cache, durable reservation, scheduler and clock together", async () => {
  const { clock, runtime } = setup()
  const run = await start(runtime, "timeline")
  await observe(runtime, run.run_id, { status: "completed" })
  const other = await start(runtime, "other", "b")
  const cp = (await (await call(runtime, "/__admin/checkpoints", {})).json()) as { id: string }
  clock.advance(86_400_001)
  await start(runtime, "timeline")
  await sweep(runtime)
  expect((await get(runtime, run.run_id)).status).toBe(404)
  expect(
    (await call(runtime, "/__admin/branches/main/checkout", { checkpoint: cp.id })).status,
  ).toBe(200)
  expect(clock.now()).toBe(base)
  expect(await start(runtime, "timeline")).toEqual({
    run_id: run.run_id,
    status: "completed",
    replayed: true,
  })
  clock.advance(3_600_000)
  await sweep(runtime)
  expect((await get(runtime, run.run_id)).status).toBe(200)
  expect((await get(runtime, other.run_id, "b")).status).toBe(200)
})

test("a conflicting keyed request still commits pruning of other expired reservations", async () => {
  const { clock, runtime } = setup()
  const expired = await start(runtime, "expired")
  await observe(runtime, expired.run_id, { status: "completed" })
  await start(runtime, "active-conflict")
  clock.advance(86_400_001)
  expect((await call(runtime, "/v1/runs", { input: "different" }, "active-conflict")).status).toBe(
    409,
  )
  await call(runtime, "/__admin/hermes/restart", { owner: "alive" })
  expect((await get(runtime, expired.run_id)).status).toBe(404)
  expect((await start(runtime, "active-conflict")).replayed).toBe(true)
})

test("invalid keyed input returns validation errors without pruning durable history", async () => {
  const { clock, runtime } = setup()
  const expired = await start(runtime, "invalid-expired")
  await observe(runtime, expired.run_id, { status: "completed" })
  await start(runtime, "invalid-active")
  clock.advance(86_400_001)
  for (const key of ["invalid-active", "invalid-expired", "invalid-new"]) {
    const response = await call(runtime, "/v1/runs", { input: "" }, key)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { message: "Missing 'input' field" } })
  }
  await call(runtime, "/__admin/hermes/restart", { owner: "alive" })
  const retained = await get(runtime, expired.run_id)
  expect(retained.status).toBe(200)
  expect(await retained.json()).toMatchObject({ status: "completed" })
})
