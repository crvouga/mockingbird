import { expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const path = "/api/chat.postMessage"
const payload = { channel: "Cfixture", text: "Fixture" }
const success = { ok: true, ts: "1.001", channel: "Cfixture" }
const send = (namespace = "default") =>
  new Request(`http://mock${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
    body: JSON.stringify(payload),
  })
const admin = (namespace: string, mode: string) =>
  new Request("http://mock/__admin/upstream", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
    body: JSON.stringify({ mode }),
  })

test("forward sends retain a marked outbox without mutating business state or leaking rewritten auth", async () => {
  const requests: Request[] = []
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://vendor.example/base",
      fetch: (request) => {
        requests.push(request)
        return Response.json(success, { status: 202, headers: { "x-vendor": "retained" } })
      },
      rewriteAuth: (request) => {
        request.headers.set("authorization", "forward-secret-fixture")
        return request
      },
    },
  })
  const before = runtime.instance().state.channels.list()
  expect((await runtime.fetch(admin("default", "forward"))).status).toBe(200)
  const response = await runtime.fetch(send())
  expect(response.status).toBe(202)
  expect(response.headers.get("x-vendor")).toBe("retained")
  expect(await response.json()).toEqual(success)
  expect(requests[0]?.url).toBe("https://vendor.example/base/api/chat.postMessage")
  expect(requests[0]?.redirect).toBe("manual")
  expect(requests[0]?.headers.get("authorization")).toBe("forward-secret-fixture")
  expect(requests[0]?.headers.has("x-mockingbird-namespace")).toBe(false)
  expect(runtime.instance().state.outbox.list()).toHaveLength(1)
  expect(runtime.instance().state.outbox.list()[0]).toMatchObject({
    upstream: true,
    sentForReal: true,
  })
  expect(runtime.instance().state.channels.list()).toEqual(before)
  const snapshot = runtime.snapshots.create()
  expect(JSON.stringify(runtime.snapshots.export(snapshot.id))).not.toContain(
    "forward-secret-fixture",
  )
  expect(
    JSON.stringify(await (await runtime.fetch(new Request("http://mock/__admin/requests"))).json()),
  ).not.toContain("forward-secret-fixture")
  await runtime.fetch(send("isolated"))
  expect(requests).toHaveLength(1)
  await runtime.fetch(admin("default", "emulated"))
  expect(runtime.instance().state.channels.list()).toEqual(before)
  await runtime.reset()
  expect(runtime.instance().state.outbox.list()).toHaveLength(0)
  expect(
    (await (await runtime.fetch(new Request("http://mock/__admin/upstream"))).json()).mode,
  ).toBe("emulated")
})

test("failed upstream sends do not create sent-for-real entries", async () => {
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => Response.json(success, { status: 429 }),
    },
  })
  expect((await runtime.fetch(send())).status).toBe(429)
  expect(runtime.instance().state.outbox.list()).toHaveLength(0)
})

test("Slack logical errors remain errors even with HTTP 200", async () => {
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => Response.json({ ok: false, error: "channel_not_found" }),
    },
  })
  expect(await (await runtime.fetch(send())).json()).toEqual({
    ok: false,
    error: "channel_not_found",
  })
  expect(runtime.instance().state.outbox.list()).toHaveLength(0)
})

test("incoming webhooks retain success receipts without creating channels", async () => {
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://hooks.example",
      mode: "forward",
      fetch: () => new Response("ok"),
    },
  })
  await runtime.fetch(
    new Request("http://mock/services/Tfixture/Bfixture/fixture", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify({ text: "Fixture" }) }),
    }),
  )
  expect(runtime.instance().state.outbox.list()[0]).toMatchObject({
    source: "webhook",
    text: "Fixture",
    sentForReal: true,
  })
})
