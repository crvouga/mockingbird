import { expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const path = "/api/2010-04-01/Accounts/ACfixture/Messages.json"
const payload = { To: "+15550000001", From: "+15550000002", Body: "Fixture" }
const success = { sid: "SMvendor" }
const send = (namespace = "default") =>
  new Request(`http://mock${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-mockingbird-namespace": namespace,
    },
    body: new URLSearchParams(payload),
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
  const before = runtime.instance().state.messages.list()
  expect((await runtime.fetch(admin("default", "forward"))).status).toBe(200)
  const response = await runtime.fetch(send())
  expect(response.status).toBe(202)
  expect(response.headers.get("x-vendor")).toBe("retained")
  expect(await response.json()).toEqual(success)
  expect(requests[0]?.url).toBe(
    "https://vendor.example/base/2010-04-01/Accounts/ACfixture/Messages.json",
  )
  expect(requests[0]?.redirect).toBe("manual")
  expect(requests[0]?.headers.get("authorization")).toBe("forward-secret-fixture")
  expect(requests[0]?.headers.has("x-mockingbird-namespace")).toBe(false)
  expect(runtime.instance().state.outbox.list()).toHaveLength(1)
  expect(runtime.instance().state.outbox.list()[0]).toMatchObject({
    upstream: true,
    sentForReal: true,
  })
  expect(runtime.instance().state.messages.list()).toEqual(before)
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
  expect(runtime.instance().state.messages.list()).toEqual(before)
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

test("Verify accepts a vendor receipt without inventing a code or local verification", async () => {
  let url = ""
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://verify.example",
      mode: "forward",
      fetch: (request) => {
        url = request.url
        return Response.json({ sid: "VEvendor" })
      },
    },
  })
  await runtime.fetch(
    new Request("https://verify.twilio.com/v2/Services/VAfixture/Verifications", {
      method: "POST",
      body: new URLSearchParams({ To: "+15550000001", Channel: "sms" }),
    }),
  )
  expect(url).toBe("https://verify.example/v2/Services/VAfixture/Verifications")
  expect(runtime.instance().state.outbox.list()[0]).toMatchObject({
    kind: "verify",
    sentForReal: true,
  })
  expect(runtime.instance().state.outbox.list()[0]?.code).toBeUndefined()
  expect(runtime.instance().state.verifications.list()).toHaveLength(0)
})
