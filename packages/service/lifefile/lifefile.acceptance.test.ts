import { expect, test } from "bun:test"
import { createRuntime, LifeFileAPI } from "./src/index.js"
import { createServer } from "./src/server.js"
import { call, headers, orderBody, submit } from "./test/consumer.js"

test("message id replay returns the same order without another push; metadata-only order journal", async () => {
  const runtime = createRuntime()
  const send = (r: Request) => runtime.fetch(r)
  const a = await submit(send)
  expect(a.envelope?.type).toBe("success")
  expect((await submit(send)).envelope?.data?.orderId).toBe(a.envelope?.data?.orderId)
  const rows = await (await call(send, "/__admin/orders", "GET")).json()
  expect(rows.orders).toHaveLength(1)
  expect(runtime.webhooks.messages()).toHaveLength(1)
  for (const path of ["/__admin/orders", "/__admin/requests", "/__admin/state"]) {
    const raw = await (await call(send, path, "GET")).text()
    expect(raw).not.toContain("Synthetic fixture")
    expect(raw).not.toContain("Synthetic test only")
  }
})

test("auth, integer headers, body validation, and pharmacy-specific state refusals never create orders", async () => {
  const runtime = createRuntime({
    settings: { accounts: [{ username: "test", password: "test" }], refusedShippingStates: ["CA"] },
  })
  const send = (r: Request) => runtime.fetch(r)
  expect((await call(send, "/order", "POST", orderBody(), { authorization: "" })).status).toBe(401)
  expect(
    (
      await call(send, "/order", "POST", orderBody(), {
        authorization: `Basic ${btoa("test:wrong")}`,
      })
    ).status,
  ).toBe(401)
  for (const key of ["X-Vendor-ID", "X-Location-ID", "X-API-Network-ID"]) {
    for (const value of ["", "no", "1.5", "-1", "2147483648"])
      expect((await call(send, "/order", "POST", orderBody(), { [key]: value })).status).toBe(400)
  }
  expect((await call(send, "/order", "POST", {})).status).toBe(400)
  expect((await submit(send, orderBody(1, "ref", "CA"))).envelope?.type).toBe("error")
  expect(runtime.instance().state.orders.count()).toBe(0)
  expect(runtime.webhooks.messages()).toHaveLength(0)
  expect((await submit(send, orderBody(2, "ref", "CA"))).envelope?.type).toBe("error")
  // No vendor-wide prohibition: a different pharmacy fixture may accept California.
  expect(
    (await submit((r) => createRuntime().fetch(r), orderBody(1, "ref", "CA"))).envelope?.type,
  ).toBe("success")
})

test("cancel is explicitly unsupported until configured, unknown codes do not mutate, repeated cancel is idempotent", async () => {
  const runtime = createRuntime()
  const send = (r: Request) => runtime.fetch(r)
  const id = (await submit(send)).envelope?.data?.orderId
  const original = runtime.instance().state.orders.get(id as string)
  expect(
    (await call(send, `/order/${id}/status`, "PUT", { status: "cancel-fixture" })).status,
  ).toBe(501)
  expect(runtime.instance().state.orders.get(id as string)).toEqual(original)
  expect(
    (await call(send, "/order/missing/status", "PUT", { status: "cancel-fixture" })).status,
  ).toBe(404)
  await call(send, "/__admin/settings", "PUT", { cancelStatus: "cancel-fixture" })
  expect((await call(send, `/order/${id}/status`, "PUT", { status: "unknown" })).status).toBe(501)
  expect(runtime.instance().state.orders.get(id as string)).toEqual(original)
  for (let i = 0; i < 2; i++)
    expect(
      (await call(send, `/order/${id}/status`, "PUT", { status: "cancel-fixture" })).status,
    ).toBe(200)
  expect(runtime.instance().state.orders.get(id as string)?.status).toBe("Cancelled")
  expect(runtime.webhooks.messages()).toHaveLength(2)
})

test("global and per-reference reject, 500, malformed, and timeout faults preserve unrelated orders", async () => {
  for (const rule of [
    { preset: "reject" },
    { preset: "server_error" },
    { preset: "malformed" },
    { preset: "timeout", timeout: "1ms" },
  ]) {
    for (const scoped of [false, true]) {
      const runtime = createRuntime()
      const send = (r: Request) => runtime.fetch(r)
      const fault = {
        ...rule,
        count: 1,
        ...(scoped ? { requestBody: { "order.general.referenceId": "target" } } : {}),
      }
      const admin = await call(send, "/__admin/faults", "POST", fault)
      expect(admin.status).toBe(201)
      if (scoped) expect((await submit(send, orderBody(2, "other"))).envelope?.type).toBe("success")
      let failed = false
      try {
        const result = await submit(send, orderBody(1, "target"))
        failed = !result.ok || result.envelope === null || result.envelope.type === "error"
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
      expect(runtime.instance().state.orders.count()).toBe(scoped ? 1 : 0)
    }
  }
})

test("Data Push supports pre-response delivery, duplicate and bad Basic auth, both wire formats, and journal", async () => {
  for (const format of ["consumer", "vendor"] as const) {
    const received: { auth: string | null; body: unknown }[] = []
    let responseReturned = false
    const runtime = createRuntime({
      settings: { pushFormat: format, pushBeforeResponse: true },
      webhooks: {
        url: "https://sink.test/push",
        username: "sink",
        password: "fixture",
        fetch: async (request) => {
          expect(responseReturned).toBe(false)
          received.push({ auth: request.headers.get("authorization"), body: await request.json() })
          return new Response(null, {
            status:
              request.headers.get("authorization") === `Basic ${btoa("sink:fixture")}` ? 200 : 401,
          })
        },
      },
    })
    const send = (r: Request) => runtime.fetch(r)
    await call(send, "/__admin/faults", "POST", { preset: "duplicate_push", count: 1 })
    const id = (await submit(send)).envelope?.data?.orderId
    expect(received).toHaveLength(2)
    expect(received[0]?.auth).toBe(`Basic ${btoa("sink:fixture")}`)
    expect(received[0]?.body).toEqual(
      format === "consumer"
        ? { orderId: id, referenceId: "reference-1", status: "Received" }
        : [
            {
              orderId: id,
              referenceId: "reference-1",
              rxStatus: "Received",
              rxStatusDateTime: runtime.instance().state.orders.get(id as string)?.updatedAt,
            },
          ],
    )
    await call(send, `/__admin/orders/${id}/push`, "POST", {
      status: "Shipping",
      badCredentials: true,
      duplicate: true,
    })
    expect(received).toHaveLength(4)
    expect(received[2]?.auth).toBe(`Basic ${btoa("invalid:invalid")}`)
    expect(runtime.webhooks.deliveries().filter((d) => d.state === "failed")).toHaveLength(2)
    expect((await call(send, "/__admin/webhooks/events", "GET")).status).toBe(200)
    responseReturned = true
  }
})

test("namespace carriers isolate orders; reset clears orders and keeps initial settings", async () => {
  const runtime = createRuntime({ settings: { cancelStatus: "fixture" } })
  const send = (r: Request) => runtime.fetch(r)
  await submit(send)
  const other = await call(send, "/__admin/ns/other/__admin/orders", "GET")
  expect((await other.json()).orders).toHaveLength(0)
  await call(send, "/__admin/credentials", "PUT", { credentials: { alice: "other" } })
  await call(send, "/order", "POST", orderBody(), { authorization: `Basic ${btoa("alice:test")}` })
  expect(runtime.instance("other").state.orders.count()).toBe(1)
  await runtime.reset()
  expect(runtime.instance().state.orders.count()).toBe(0)
  expect(runtime.instance().state.current().cancelStatus).toBe("fixture")
})

test("served HTTP order delivers Data Push to a real sink", async () => {
  const received: unknown[] = []
  const sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push(await request.json())
      return new Response(null, { status: 200 })
    },
  })
  const server = await createServer({
    settings: { pushBeforeResponse: true },
    webhooks: { url: `http://127.0.0.1:${sink.port}/push`, username: "sink", password: "fixture" },
  })
  try {
    const response = await fetch(`${server.url}/order`, {
      method: "POST",
      headers,
      body: JSON.stringify(orderBody()),
    })
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
  } finally {
    await server.close()
    sink.stop(true)
  }
})

test("direct API request validation requires a JSON body without retaining malformed data", async () => {
  const api = new LifeFileAPI()
  expect(
    (
      await api.fetch(
        new Request("https://mock.lifefile.local/order", { method: "POST", headers, body: "{" }),
      )
    ).status,
  ).toBe(400)
  expect(api.state.orders.count()).toBe(0)
})
