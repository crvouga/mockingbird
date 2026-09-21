import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const AUTH = { authorization: "Bearer any-token", "content-type": "application/json" }
const at = (namespace: string) => ({ ...AUTH, "x-mockingbird-namespace": namespace })

test("/health answers without credentials; vendor routes still require them", async () => {
  const runtime = createRuntime()
  const health = await runtime.fetch(new Request("http://mock.local/health"))
  expect(health.status).toBe(200)
  expect(await health.json()).toMatchObject({ status: "ok", service: "genebygene" })
  const vendor = await runtime.fetch(
    new Request("http://mock.local/api/v2/orders", { method: "POST" }),
  )
  expect(vendor.status).toBe(401)
})

test("namespaces isolate writes, and reset clears only its own", async () => {
  const runtime = createRuntime()
  const created = await runtime.fetch(
    new Request("http://mock.local/api/v2/orders", {
      headers: at("a"),
      body: JSON.stringify({ productId: "product_default", quantity: 1 }),
      method: "POST",
    }),
  )
  expect(created.status).toBeLessThan(300)
  const id = (await created.json()) as { id?: string; orderId?: string }
  const key = id.id ?? id.orderId
  const path = `/api/v2/orders/${key}`
  expect(
    (await runtime.fetch(new Request(`http://mock.local${path}`, { headers: at("a") }))).status,
  ).toBe(200)
  expect(
    (await runtime.fetch(new Request(`http://mock.local${path}`, { headers: at("b") }))).status,
  ).toBe(404)
  await runtime.reset("a")
  expect(
    (await runtime.fetch(new Request(`http://mock.local${path}`, { headers: at("a") }))).status,
  ).toBe(404)
})

test("an injected fault fires once, then the operation recovers", async () => {
  const runtime = createRuntime()
  runtime.faults.add({
    id: "outage",
    method: "POST",
    pathPrefix: "/api/v2/orders",
    status: 503,
    count: 1,
  })
  const request = () =>
    new Request("http://mock.local/api/v2/orders", {
      headers: AUTH,
      body: JSON.stringify({ productId: "product_default", quantity: 1 }),
      method: "POST",
    })
  expect((await runtime.fetch(request())).status).toBe(503)
  expect((await runtime.fetch(request())).status).toBeLessThan(300)
  expect(runtime.metrics.report().faults).toBe(1)
})
