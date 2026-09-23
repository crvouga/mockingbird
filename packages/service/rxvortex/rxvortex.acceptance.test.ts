import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { CUSTOM_CREAM_ANCHOR_PRESET_ID, createRuntime, RXVORTEX_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type FulfillmentStatus,
  mapStatus,
  RxVortexConsumer,
  receiveWebhook,
  samplePayload,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://rxvortex.mock"
const SECRET = "rxv-webhook-secret"
const TESTOSTERONE = "1c0b7f7e-3c5f-4d57-9d0a-0d8f1d3a2b10"

/** A runtime whose webhooks land in an in-memory receiver running our consumer's logic. */
const harness = () => {
  const deliveries: { headers: Headers; body: unknown }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: "http://backend.local/prescriptions/webhooks/rxvortex",
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.json() })
        return Response.json({ received: true }, { status: 202 })
      },
    },
  })
  const consumer = new RxVortexConsumer(
    API,
    { clientId: "geviti-dev", clientSecret: "s3cret" },
    (request) => runtime.fetch(request),
  )
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, consumer, deliveries, admin }
}

describe("S3.9 acceptance: our consumer's logic against the mock", () => {
  test("submit → Shipping with tracking → Delivered: webhooks verify and statuses progress", async () => {
    const { runtime, consumer, deliveries, admin } = harness()
    const submitted = await consumer.submit("pay_1001", samplePayload("pay_1001", TESTOSTERONE))
    expect(submitted.success).toBe(true)
    const id = submitted.pharmacyOrderId as string
    expect((await consumer.status(id))?.fulfillmentStatus).toBe("submitted")

    const seen: FulfillmentStatus[] = []
    const receive = async () => {
      await runtime.webhooks.idle()
      for (const delivery of deliveries.splice(0)) {
        const outcome = receiveWebhook(SECRET, delivery.headers, delivery.body, (o) => o === id)
        expect(outcome.accepted).toBe(true)
        if (outcome.accepted && "status" in outcome) seen.push(outcome.status)
      }
    }
    expect((await admin(`/orders/${id}/transition`, { to: "Fill" })).status).toBe(200)
    await receive()
    expect(
      (
        await admin(`/orders/${id}/transition`, {
          to: "Shipping",
          trackingnumber: "1ZTEST",
          shippingcarrier: "UPS",
        })
      ).status,
    ).toBe(200)
    await receive()
    const shipped = await consumer.status(id)
    expect(shipped?.fulfillmentStatus).toBe("shipped")
    expect(shipped?.trackingNumber).toBe("1ZTEST")
    expect(shipped?.canCancel).toBe(false)
    await admin(`/orders/${id}/transition`, { to: "Delivered" })
    await receive()
    expect((await consumer.status(id))?.fulfillmentStatus).toBe("delivered")
    expect(seen).toEqual(["processing", "shipped", "delivered"])
  })

  test("created_but_500: the submit fails, recovery by paymentId finds the order", async () => {
    const { runtime, consumer } = harness()
    runtime.applyPreset("created_but_500", "default", { count: 1 })
    const result = await consumer.submit("pay_2002", samplePayload("pay_2002", TESTOSTERONE))
    expect(result.success).toBe(true)
    expect(result.pharmacyOrderId).toMatch(/^RXV-/)
    expect((await consumer.status(result.pharmacyOrderId as string))?.fulfillmentStatus).toBe(
      "submitted",
    )
  })

  test("a duplicate sender_order_id is a 409 that recovery turns into success", async () => {
    const { consumer } = harness()
    const first = await consumer.submit("pay_3003", samplePayload("pay_3003", TESTOSTERONE))
    const again = await consumer.submit("pay_3003", samplePayload("pay_3003", TESTOSTERONE))
    expect(again).toEqual(first)
  })

  test("numeric_tracking_id: our client refuses a number", async () => {
    const { runtime, consumer } = harness()
    runtime.applyPreset("numeric_tracking_id", "default", { count: 1 })
    const result = await consumer.submit("pay_4004", samplePayload("pay_4004", TESTOSTERONE))
    expect(result).toEqual({ success: false, error: "Response missing order_tracking_id" })
  })

  test("validation presets produce each error-body shape our extractor branches on", async () => {
    const expected: Record<string, string> = {
      validation_errors_array: "RxVortex API failed: 422 (1 validation errors)",
      validation_errors_object: "RxVortex API failed: 422 invalid fields=patient.phone",
      // The catalog says an empty array gives the plain message; our extractor actually
      // falls through to the object branch (an empty array is a truthy object).
      validation_errors_empty: "RxVortex API failed: 422 invalid fields=",
    }
    for (const [preset, message] of Object.entries(expected)) {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      // The preset answers before creating, so recovery finds nothing: the error surfaces.
      expect(await consumer.submit(`pay_${preset}`, samplePayload("pay_x", TESTOSTERONE))).toEqual({
        success: false,
        error: message,
      })
    }
  })

  test("a real schema violation is a Laravel-style 422 naming the fields", async () => {
    const { consumer } = harness()
    const payload = samplePayload("pay_5005", TESTOSTERONE)
    payload.patient.phone = "6025550142"
    const result = await consumer.submit("pay_5005", payload)
    expect(result).toEqual({
      success: false,
      error: "RxVortex API failed: 422 invalid fields=patient.phone",
    })
  })

  test("tokens last 24 h on the mock clock (no 401 refresh in our client); token_expired fires early", async () => {
    const { runtime, consumer } = harness()
    const submitted = await consumer.submit("pay_6006", samplePayload("pay_6006", TESTOSTERONE))
    const id = submitted.pharmacyOrderId as string
    runtime.clock.advance(23 * 3_600_000)
    expect(await consumer.status(id)).not.toBeNull()
    runtime.clock.advance(3_600_000)
    expect(await consumer.status(id)).toBeNull()
    const fresh = harness()
    const again = await fresh.consumer.submit("pay_6007", samplePayload("pay_6007", TESTOSTERONE))
    fresh.runtime.applyPreset("token_expired", "default", { count: 1 })
    expect(await fresh.consumer.status(again.pharmacyOrderId as string)).toBeNull()
    expect(await fresh.consumer.status(again.pharmacyOrderId as string)).not.toBeNull()
  })

  test("cancel works until shipped, then the vendor refuses", async () => {
    const { consumer, admin } = harness()
    const a = await consumer.submit("pay_7007", samplePayload("pay_7007", TESTOSTERONE))
    expect(await consumer.cancel(a.pharmacyOrderId as string)).toEqual({ success: true })
    expect((await consumer.status(a.pharmacyOrderId as string))?.fulfillmentStatus).toBe(
      "cancelled",
    )
    const b = await consumer.submit("pay_7008", samplePayload("pay_7008", TESTOSTERONE))
    await admin(`/orders/${b.pharmacyOrderId}/transition`, { to: "Shipping" })
    const refused = await consumer.cancel(b.pharmacyOrderId as string)
    expect(refused).toEqual({ success: false, error: "RxVortex API failed: 409" })
  })

  test("autoAdvance walks orders along a path on the mock clock", async () => {
    const { runtime, consumer, admin, deliveries } = harness()
    await admin(
      "/settings",
      { autoAdvance: { afterMs: 60_000, path: ["Fill", "Shipping", "Delivered"] } },
      "PUT",
    )
    const order = await consumer.submit("pay_8008", samplePayload("pay_8008", TESTOSTERONE))
    const id = order.pharmacyOrderId as string
    runtime.clock.advance(60_000)
    expect((await consumer.status(id))?.fulfillmentStatus).toBe("processing")
    runtime.clock.advance(120_000)
    expect((await consumer.status(id))?.fulfillmentStatus).toBe("delivered")
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(3)
  })

  test("the catalog carries the custom-cream anchor preset, and the client-side filter keeps active rows", async () => {
    const { runtime } = harness()
    const token = await new RxVortexConsumer(API, { clientId: "c", clientSecret: "s" }, (r) =>
      runtime.fetch(r),
    ).getAccessToken()
    const response = await runtime.fetch(
      new Request(`${API}/api/v1/preset-catalog-items`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    const payload = (await response.json()) as Record<string, unknown>
    // Our client takes an array, or the first array-valued property of an object.
    const rows = Object.values(payload).find(Array.isArray) as {
      catalog_id: string
      status: string
    }[]
    const active = rows.filter((row) => !row.status || row.status.toLowerCase() === "active")
    expect(active.map((row) => row.catalog_id)).toContain(CUSTOM_CREAM_ANCHOR_PRESET_ID)
    expect(active.length).toBeLessThan(rows.length)
  })

  test("namespaces by client id isolate parallel workers", async () => {
    const { runtime } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "worker-a": "a", "worker-b": "b" } }),
      }),
    )
    const worker = (clientId: string) =>
      new RxVortexConsumer(API, { clientId, clientSecret: "x" }, (r) => runtime.fetch(r))
    const a = worker("worker-a")
    const b = worker("worker-b")
    const placed = await a.submit("pay_9009", samplePayload("pay_9009", TESTOSTERONE))
    expect(await a.recover("pay_9009")).toBe(placed.pharmacyOrderId as string)
    expect(await b.recover("pay_9009")).toBeNull()
    const journal = (await (
      await runtime.fetch(
        new Request(`${API}/__admin/requests?namespace=a&operationId=CreateOrder`),
      )
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.orderId).toBe(placed.pharmacyOrderId as string)
    // The journal never holds request bodies (patient PHI).
    expect(JSON.stringify(journal)).not.toContain("Lovelace")
  })

  test("every vendor status our mapper recognises is reachable through a transition", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "Fill",
          "PV1 Complete",
          "Out of Stock",
          "On Hold",
          "Compound",
          "Shipping",
          "Delivered",
          "Cancelled",
          "Rejected",
          "Created",
        ),
        async (to) => {
          const { consumer, admin } = harness()
          const order = await consumer.submit("pay_p", samplePayload("pay_p", TESTOSTERONE))
          await admin(`/orders/${order.pharmacyOrderId}/transition`, { to })
          const status = (await consumer.status(order.pharmacyOrderId as string))?.fulfillmentStatus
          const expected =
            to === "Shipping" ? "shipped" : to === "Rejected" ? "error" : mapStatus(to)
          expect(status).toBe(expected)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(RXVORTEX_PRESETS)).toEqual(
      expect.arrayContaining([
        "duplicate_sender_order_id",
        "created_but_500",
        "numeric_tracking_id",
        "token_expired",
        "stale_error_with_delivered_date",
        "validation_errors_array",
        "validation_errors_object",
        "validation_errors_empty",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("the consumer works against the node server, and auto-advance fires webhooks on its own", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("x-rxvortex-webhook-secret") === SECRET) {
          received.push(await request.json())
        }
        return Response.json({ received: true }, { status: 202 })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}/prescriptions/webhooks/rxvortex`,
        secret: SECRET,
      },
      settings: { autoAdvance: { afterMs: 50, path: ["Fill", "Shipping"] } },
    })
    try {
      const consumer = new RxVortexConsumer(server.url, { clientId: "c", clientSecret: "s" }, (r) =>
        fetch(r),
      )
      const placed = await consumer.submit(
        "pay_http",
        samplePayload("pay_http", CUSTOM_CREAM_ANCHOR_PRESET_ID),
      )
      expect(placed.success).toBe(true)
      const deadline = Date.now() + 3_000
      while (received.length < 2 && Date.now() < deadline) await Bun.sleep(25)
      expect(received.map((r) => (r as { rxstatus: string }).rxstatus)).toEqual([
        "Fill",
        "Fulfillment Complete",
      ])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^rxvortex@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
