import { expect, test } from "bun:test"
import { createRuntime, HermesAPI, type HermesRuntime } from "./src/index.js"

const submit = (
  runtime: { fetch(request: Request): Promise<Response> },
  key = "delivery",
  raw = '{"input":"synthetic"}',
  headers: Record<string, string> = {},
) =>
  runtime.fetch(
    new Request("http://hermes.mock/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key, ...headers },
      body: raw,
    }),
  )
const admin = (runtime: HermesRuntime, path: string, body: unknown) =>
  runtime.fetch(
    new Request(`http://hermes.mock/__admin/hermes${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
const json = async (response: Response, status = 202) => {
  expect(response.status).toBe(status)
  return (await response.json()) as { run_id: string; status: string; replayed: boolean }
}

test("identical submissions replay one run and changed payloads conflict without replacing it", async () => {
  const runtime = createRuntime()
  const first = await json(await submit(runtime))
  expect(first).toMatchObject({ status: "started", replayed: false })
  const response = await submit(runtime)
  expect(response.headers.get("Idempotency-Replayed")).toBe("true")
  expect(await json(response)).toEqual({ run_id: first.run_id, status: "queued", replayed: true })
  const conflict = await submit(runtime, "delivery", '{"input":"different"}')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({
    error: {
      message: "Idempotency-Key was already used with a different request payload",
      type: "invalid_request_error",
      param: null,
      code: "idempotency_key_conflict",
    },
  })
  expect((await json(await submit(runtime))).run_id).toBe(first.run_id)
  expect(runtime.instance().runs.records.count()).toBe(1)
})

test("concurrent identical submissions reserve exactly once across API facades", async () => {
  const runtime = createRuntime()
  const api = runtime.instance()
  const other = new HermesAPI({ sqlite: api.sqlite, namespace: api.namespace })
  const responses = await Promise.all(
    Array.from({ length: 24 }, (_, i) => submit(i % 2 ? api : other)),
  )
  const values = await Promise.all(responses.map((r) => json(r)))
  expect(new Set(values.map((v) => v.run_id)).size).toBe(1)
  expect(values.filter((v) => !v.replayed)).toHaveLength(1)
  expect(api.runs.records.count()).toBe(1)
})

test("full canonical payload includes unknown fields, array order and memory key, not property order", async () => {
  const runtime = createRuntime()
  const a = await json(
    await submit(runtime, "a", '{"input":"synthetic","extra":{"b":2,"a":1},"items":[1,2]}', {
      "X-Hermes-Session-Key": "memory",
    }),
  )
  const b = await submit(
    runtime,
    "a",
    '{"items":[1,2],"extra":{"a":1,"b":2},"input":"synthetic"}',
    { "X-Hermes-Session-Key": "memory" },
  )
  expect(await json(b)).toMatchObject({ run_id: a.run_id, replayed: true })
  expect(b.headers.get("X-Hermes-Session-Key")).toBe("memory")
  for (const raw of [
    '{"input":"synthetic","extra":{"a":1,"b":3},"items":[1,2]}',
    '{"input":"synthetic","extra":{"a":1,"b":2},"items":[2,1]}',
  ])
    expect((await submit(runtime, "a", raw, { "X-Hermes-Session-Key": "memory" })).status).toBe(409)
  expect(
    (
      await submit(runtime, "a", '{"input":"synthetic","extra":{"b":2,"a":1},"items":[1,2]}', {
        "X-Hermes-Session-Key": "different",
      })
    ).status,
  ).toBe(409)
})

test("raw numeric forms follow Python integer/float distinctions and equivalent float spellings", async () => {
  const runtime = createRuntime()
  for (const [left, right, same] of [
    ["1", "1.0", false],
    ["1.0", "1e0", true],
    ["-0", "0", true],
    ["-0.0", "0.0", false],
    ["9007199254740992", "9007199254740993", false],
    ["1e20", "100000000000000000000.0", true],
  ] as const) {
    const key = `n-${left}`
    await json(await submit(runtime, key, `{"input":"x","n":${left}}`))
    const response = await submit(runtime, key, `{"input":"x","n":${right}}`)
    expect(response.status).toBe(same ? 202 : 409)
  }
})

test("explicit synthetic scope isolates keys and run visibility; bearer text and session IDs do not grant a new scope", async () => {
  const runtime = createRuntime()
  const first = await json(await submit(runtime))
  expect(
    (await submit(runtime, "delivery", '{"input":"synthetic","session_id":"other"}')).status,
  ).toBe(409)
  expect(
    await json(
      await submit(runtime, "delivery", undefined, { authorization: "Bearer synthetic-a" }),
    ),
  ).toMatchObject({ run_id: first.run_id, replayed: true })
  expect(
    (await admin(runtime, "/scope", { profile: "other", identity: "synthetic-listener" })).status,
  ).toBe(200)
  const second = await json(await submit(runtime))
  expect(second.run_id).not.toBe(first.run_id)
  expect(
    (await runtime.fetch(new Request(`http://hermes.mock/v1/runs/${first.run_id}`))).status,
  ).toBe(404)
  expect(
    (
      await admin(runtime, "/scope", {
        profile: "default",
        identity: "unauthenticated-test-listener",
      })
    ).status,
  ).toBe(200)
  expect(await json(await submit(runtime))).toMatchObject({ run_id: first.run_id, replayed: true })
})

test("key validation trims, treats empty as unkeyed, and failed submissions reserve nothing", async () => {
  const runtime = createRuntime()
  const a = await json(await submit(runtime, " delivery "))
  expect(await json(await submit(runtime))).toMatchObject({ run_id: a.run_id, replayed: true })
  expect((await json(await submit(runtime, " "))).run_id).not.toBe(
    (await json(await submit(runtime, ""))).run_id,
  )
  for (const key of ["a b", "x".repeat(256), "é"]) {
    const response = await submit(runtime, key)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_idempotency_key" } })
  }
  expect((await submit(runtime, "fresh", "{}")).status).toBe(400)
  expect((await json(await submit(runtime, "fresh"))).replayed).toBe(false)
})

test("terminal replay survives adapter reconstruction in shared storage and reset clears reservations", async () => {
  const runtime = createRuntime()
  const a = await json(await submit(runtime))
  expect(
    (
      await admin(runtime, `/runs/${a.run_id}/observe`, {
        status: "completed",
        output: "synthetic-output",
      })
    ).status,
  ).toBe(200)
  const api = runtime.instance()
  const reopened = new HermesAPI({ sqlite: api.sqlite, namespace: api.namespace })
  expect(await json(await submit(reopened))).toEqual({
    run_id: a.run_id,
    status: "completed",
    replayed: true,
  })
  await api.reset()
  expect((await json(await submit(reopened))).replayed).toBe(false)
  const journal = JSON.stringify(runtime.journal.list())
  expect(journal).not.toContain("synthetic-output")
  expect(journal).not.toContain('"input":"synthetic"')
})

test("Python header trimming, validation precedence and Hono raw JSON entry remain faithful", async () => {
  const runtime = createRuntime()
  const first = await json(await submit(runtime, "\u0085delivery\u0085"))
  expect(await json(await submit(runtime))).toMatchObject({ run_id: first.run_id, replayed: true })
  const malformed = await submit(runtime, "invalid key", "{")
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ error: { message: "Invalid JSON", code: null } })
  const api = new HermesAPI()
  const request = (raw: string) =>
    new Request("http://hermes.mock/v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "hono" },
      body: raw,
    })
  expect((await api.app.fetch(request('{"input":"synthetic","n":1}'))).status).toBe(202)
  expect((await api.app.fetch(request('{"input":"synthetic","n":1.0}'))).status).toBe(409)
})

test("scope and reservations participate in Timeline checkout and namespace isolation", async () => {
  const runtime = createRuntime()
  const first = await json(await submit(runtime))
  const checkpoint = await runtime.fetch(
    new Request("http://hermes.mock/__admin/checkpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  )
  const { id } = (await checkpoint.json()) as { id: string }
  await admin(runtime, "/scope", { profile: "other", identity: "synthetic" })
  expect(
    (await admin(runtime, `/runs/${first.run_id}/observe`, { status: "running" })).status,
  ).toBe(404)
  await json(await submit(runtime))
  expect(
    (
      await runtime.fetch(
        new Request("http://hermes.mock/__admin/branches/main/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ checkpoint: id }),
        }),
      )
    ).status,
  ).toBe(200)
  expect(await json(await submit(runtime))).toMatchObject({ run_id: first.run_id, replayed: true })
  const other = await json(
    await submit(runtime, "delivery", undefined, { "x-mockingbird-namespace": "other" }),
  )
  expect(other.replayed).toBe(false)
  expect(other.run_id).not.toBe(first.run_id)
})
