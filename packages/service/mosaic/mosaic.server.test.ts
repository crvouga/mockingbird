import { expect, test } from "bun:test"
import { createServer } from "./src/server.js"
import { consumer, orderBody } from "./test/consumer.js"

test("standalone HTTP serves admin health and vendor calls through ordinary fetch", async () => {
  const server = await createServer({ adminKey: "admin-test-value" })
  try {
    const client = consumer(fetch, server.url)
    const health = await fetch(`${server.url}/__admin/health`, {
      headers: { "x-mockingbird-admin-key": "admin-test-value" },
    })
    expect(health.status).toBe(200)
    expect(await health.text()).toContain("mosaic")
    const patientId = await client.id(await client.createPatient())
    const orderId = await client.id(await client.createOrder(orderBody(patientId)))
    const response = await client.request("/API/SALESORDERLINES", "GET", undefined, {
      patientaccountid: patientId,
    })
    expect(response.headers.get("x-mockingbird")).toStartWith("mosaic@")
    expect((await response.json()).data[0]).toMatchObject({ orderId, statusId: 4 })
  } finally {
    await server.close()
  }
})
