import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createRuntime, document, type HermesRuntime } from "./src/index.js"

const call = (r: HermesRuntime, path: string, body?: unknown, key = "", ns = "default") =>
  r.fetch(
    new Request(`http://hermes.mock${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "x-mockingbird-namespace": ns,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const preset = async (r: HermesRuntime, name: string) => {
  expect((await call(r, "/__admin/faults", { preset: name })).status).toBe(201)
}

test("accepted response loss retains exactly one keyed run, journal and restorable history", async () => {
  const r = createRuntime()
  const before = r.checkpoint()
  await preset(r, "hermes_submit_accepted_drop")
  const failure = await call(r, "/v1/runs", { input: "synthetic" }, "delivery").then(
    () => null,
    (error) => error,
  )
  expect(failure).toBeInstanceOf(TypeError)
  const head = r.timeline().head("main")
  if (!head) throw new Error("Missing accepted checkpoint")
  expect(head.id).not.toBe(before.id)
  expect(r.instance().runs.records.count()).toBe(1)
  const journal = r.journal.list({ operationId: "RunCreate" })
  expect(journal).toMatchObject([
    { status: 0, accepted: true, checkpoint: head.id, ids: { runId: expect.any(String) } },
  ])
  const retry = await call(r, "/v1/runs", { input: "synthetic" }, "delivery")
  expect(retry.status).toBe(202)
  expect(retry.headers.get("Idempotency-Replayed")).toBe("true")
  const run = await retry.json()
  expect(run).toMatchObject({ replayed: true, status: "queued" })
  expect(r.instance().runs.records.count()).toBe(1)
  expect((await call(r, `/v1/runs/${run.run_id}`, undefined, "", "other")).status).toBe(404)
  r.checkout(before.id)
  expect((await call(r, `/v1/runs/${run.run_id}`)).status).toBe(404)
  r.checkout(head.id)
  expect(await (await call(r, "/v1/runs", { input: "synthetic" }, "delivery")).json()).toEqual(run)
})

test("pinned throttle and draining envelopes reject before admission and are one-shot", async () => {
  for (const [name, status, type, code, message] of [
    [
      "hermes_throttled",
      429,
      "rate_limit_error",
      "rate_limit_exceeded",
      "Too many concurrent runs (max 10)",
    ],
    [
      "hermes_draining",
      503,
      "invalid_request_error",
      "gateway_draining",
      "Gateway is draining existing work; retry shortly.",
    ],
  ] as const) {
    const r = createRuntime()
    const before = r.checkpoint()
    await preset(r, name)
    const response = await call(r, "/v1/runs", { input: "synthetic" }, "key")
    expect(response.status).toBe(status)
    expect(response.headers.get("Retry-After")).toBe("1")
    const body = await response.json()
    expect(body).toEqual({ error: { type, code, message, param: null } })
    const operation = findOperation(document, "RunCreate")
    if (!operation) throw new Error("Missing submission operation")
    const schema = responseForStatus(operation.responses, status)?.content?.["application/json"]
      ?.schema
    if (!schema) throw new Error("Missing fault response schema")
    expect(validateValue(document, schema, body)).toEqual([])
    expect(r.instance().runs.records.count()).toBe(0)
    expect(r.timeline().head("main")?.id).toBe(before.id)
    expect(r.journal.list({ operationId: "RunCreate" })).toMatchObject([{ status }])
    expect((await call(r, "/v1/runs", { input: "synthetic" }, "key")).status).toBe(202)
  }
})

test("scripted executor failure is a pollable failed run and replay preserves the failure", async () => {
  const r = createRuntime()
  const run = await (await call(r, "/v1/runs", { input: "synthetic" }, "failed")).json()
  expect(
    (
      await call(r, `/__admin/hermes/runs/${run.run_id}/observe`, {
        status: "failed",
        error: "synthetic executor failure",
      })
    ).status,
  ).toBe(200)
  const poll = await call(r, `/v1/runs/${run.run_id}`)
  expect(poll.status).toBe(200)
  expect(await poll.json()).toMatchObject({
    object: "hermes.run",
    status: "failed",
    error: "synthetic executor failure",
  })
  expect(await (await call(r, "/v1/runs", { input: "synthetic" }, "failed")).json()).toEqual({
    run_id: run.run_id,
    status: "failed",
    replayed: true,
  })
})

test("accepted-drop effect cannot turn validation failure into acceptance", async () => {
  const r = createRuntime()
  const before = r.checkpoint()
  await preset(r, "hermes_submit_accepted_drop")
  const response = await call(r, "/v1/runs", { input: "" }, "invalid")
  expect(response.status).toBe(400)
  expect(r.instance().runs.records.count()).toBe(0)
  expect(r.timeline().head("main")?.id).toBe(before.id)
  expect(r.journal.list({ operationId: "RunCreate" })[0]?.accepted).toBeUndefined()
})
