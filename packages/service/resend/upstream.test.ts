import { expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const path = "/emails"
const payload = {
  from: "sender@example.test",
  to: "person@example.test",
  subject: "Hello",
  text: "Fixture",
}
const success = { id: "vendor-email" }
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
  const before = runtime.instance().state.received.list()
  expect((await runtime.fetch(admin("default", "forward"))).status).toBe(200)
  const response = await runtime.fetch(send())
  expect(response.status).toBe(202)
  expect(response.headers.get("x-vendor")).toBe("retained")
  expect(await response.json()).toEqual(success)
  expect(requests[0]?.url).toBe("https://vendor.example/base/emails")
  expect(requests[0]?.redirect).toBe("manual")
  expect(requests[0]?.headers.get("authorization")).toBe("forward-secret-fixture")
  expect(requests[0]?.headers.has("x-mockingbird-namespace")).toBe(false)
  expect(runtime.instance().state.outbox.list()).toHaveLength(1)
  expect(runtime.instance().state.outbox.list()[0]).toMatchObject({
    upstream: true,
    sentForReal: true,
  })
  expect(runtime.instance().state.received.list()).toEqual(before)
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
  expect(runtime.instance().state.received.list()).toEqual(before)
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

test("batch receipts are paired with their own payload and do not invoke local send hooks", async () => {
  let hooks = 0
  const runtime = createRuntime({
    forwardToInbox: {
      url: "http://inbox.test",
      fetch: async () => {
        hooks++
        return Response.json({ id: "copy" })
      },
    },
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => Response.json({ data: [{ id: "one" }, { id: "two" }] }),
    },
  })
  await runtime.fetch(
    new Request("http://mock/emails/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([payload, { ...payload, to: "second@example.test" }]),
    }),
  )
  expect(
    runtime
      .instance()
      .state.outbox.list()
      .map((item) => item.to),
  ).toEqual([["person@example.test"], ["second@example.test"]])
  expect(hooks).toBe(0)
  await runtime.fetch(admin("default", "emulated"))
  const emulated = send()
  emulated.headers.set("authorization", "Bearer re_fixture")
  expect((await runtime.fetch(emulated)).status).toBe(200)
  expect(hooks).toBe(1)
})
