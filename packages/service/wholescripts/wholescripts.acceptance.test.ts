import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, MEDPAX_BOX_SKU, WHOLESCRIPTS_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  BackendWholescriptsClient,
  fetchEmrProductList,
  MakorWholescriptsAdapter,
  MakorWholescriptsClient,
  mapWsStatus,
  sampleMakorOrder,
  VendorPermanentError,
  VendorTimeoutError,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://wholescripts.mock"
const CREDS = { username: "geviti-dev", password: "s3cret" }

const harness = (credentials = CREDS) => {
  const runtime = createRuntime()
  const fetch = (request: Request) => runtime.fetch(request)
  const makor = new MakorWholescriptsAdapter(new MakorWholescriptsClient(API, credentials, fetch))
  const backend = new BackendWholescriptsClient(API, credentials, fetch)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, makor, backend, admin, fetch }
}

const address = {
  FName: "Ada",
  LName: "Lovelace",
  Address1: "1 Main St",
  City: "Phoenix",
  State: "AZ",
  Zip: "85004",
  Email: "ada@example.com",
}

describe("S12.3 acceptance: our consumers' logic against the mock", () => {
  test("Makor: submit → Processing with tracking → Complete, observed by polling", async () => {
    const { makor, admin } = harness()
    const placed = await makor.placeOrder(sampleMakorOrder())
    expect(placed.status).toBe("placed")
    const id = placed.vendor_order_id
    const seen = [(await makor.getOrderStatus(id)).status]

    await admin(`/orders/${id}/transition`, { to: "Processing" })
    seen.push((await makor.getOrderStatus(id)).status)
    await admin(`/orders/${id}/transition`, {
      to: "Processing",
      trackingNumber: "1ZTEST",
      carrier: "UPS",
    })
    const shipped = await makor.getOrderStatus(id)
    seen.push(shipped.status)
    await admin(`/orders/${id}/transition`, { to: "Complete" })
    const complete = await makor.getOrderStatus(id)
    seen.push(complete.status)

    // The catalog's acceptance reads submitted → processing → shipped → delivered, but our
    // consumers cannot express that for Wholescripts: Makor's _map_ws_status maps Pending and
    // Processing (no tracking) to "placed", Processing-with-tracking and "Complete" (carrier
    // hand-off, per its own comment) to "shipped", and has no delivered state; the backend and
    // EMR have no status mapper at all. We assert what the consumer really does.
    expect(seen).toEqual(["placed", "placed", "shipped", "shipped"])
    expect(complete.raw_status).toBe("Complete")
    expect(complete.metadata?.sales_order).toBe(`SO${id}`)
    // Makor types tracking_numbers as list[str] but passes the vendor's tracking objects
    // (the backend zod shape {trackingNumber, carrier, trackingUrl}) through unchanged.
    expect(shipped.tracking_numbers).toEqual([
      {
        trackingNumber: "1ZTEST",
        carrier: "UPS",
        trackingUrl: "https://www.ups.com/track?tracknum=1ZTEST",
      },
    ])
  })

  test("Makor builds a MedPax box under the box SKU; the order is priced from the catalog", async () => {
    const { makor, runtime } = harness()
    const placed = await makor.placeOrder(sampleMakorOrder())
    const order = runtime.instance().orders()[0]
    expect(order?.items.map((i) => i.sku)).toEqual([MEDPAX_BOX_SKU, "MPVD001", "MP001", "SKU002"])
    const status = await makor.getOrderStatus(placed.vendor_order_id)
    // 30 × 0.12 (MPVD001's medPaxDetails price) + 30 × 19.99 (MP001, Test Product 1's MedPax
    // SKU, no medPaxDetails) + 1 × 29.99 (SKU002), plus 9.95 ground shipping.
    expect(status.metadata).toMatchObject({
      sub_total: 633.29,
      ship_charge: 9.95,
      order_total: 643.24,
    })
  })

  test("backend: private-label restructure, place, then read the status back", async () => {
    const { backend, runtime } = harness()
    const placed = await backend.placeOrder({
      ShippingAddress: address,
      Items: [
        { Sku: "SKU001", Quantity: 1 },
        { Sku: "VD001", Quantity: 2 },
      ],
      ShippingMethod: "Ground",
    })
    expect(placed.success).toBe(true)
    const order = runtime.instance().orders()[0]
    // Restructured into the first carton (PLC001) with every item as an AM pill.
    expect(order?.items.map((i) => i.sku)).toEqual(["PLC001", "SKU001", "VD001"])
    const status = await backend.getOrderStatus(placed.orderNumber)
    expect(status?.status).toBe("Pending")
    expect(status?.tracking).toEqual([])

    const again = await backend.processSupplementOrder({
      shippingAddress: address,
      lineItems: [{ Sku: "MP001", Quantity: 30, ItemTime: "PM" }],
      shippingMethod: "Ground",
    })
    expect(again.orderNumber).not.toBe(placed.orderNumber)
  })

  test("cancel works before shipping; once tracking exists the vendor refuses", async () => {
    const { makor, admin } = harness()
    const a = await makor.placeOrder(sampleMakorOrder())
    expect(await makor.cancelOrder(a.vendor_order_id)).toEqual({
      success: true,
      message: `Order ${a.vendor_order_id} cancelled`,
    })
    expect((await makor.getOrderStatus(a.vendor_order_id)).status).toBe("cancelled")
    const b = await makor.placeOrder(sampleMakorOrder())
    await admin(`/orders/${b.vendor_order_id}/transition`, {
      to: "Processing",
      trackingNumber: "1ZX",
    })
    const refused = await makor.cancelOrder(b.vendor_order_id)
    expect(refused.success).toBe(false)
    expect(refused.message).toContain("has shipped")
    // An unknown order is a 404, which Makor surfaces as a permanent vendor error.
    await expect(makor.cancelOrder("999999")).rejects.toBeInstanceOf(VendorPermanentError)
  })

  test("an Error status maps to failed; an unknown order polls as unknown", async () => {
    const { makor, admin } = harness()
    const placed = await makor.placeOrder(sampleMakorOrder())
    await admin(`/orders/${placed.vendor_order_id}/transition`, {
      to: "Error",
      message: "Payment authorization failed",
    })
    const status = await makor.getOrderStatus(placed.vendor_order_id)
    expect(status.status).toBe("failed")
    expect(status.metadata?.message).toBe("Payment authorization failed")
    expect((await makor.getOrderStatus("123")).status).toBe("unknown")
  })

  test("EMR: ProductList?instockonly=true drops out-of-stock rows and passes its zod schema", async () => {
    const { fetch } = harness()
    const products = await fetchEmrProductList(API, CREDS, fetch)
    expect(products.map((p) => p.sku)).not.toContain("PP001")
    expect(products.map((p) => p.sku)).toContain("SKU001")
    const all = await new MakorWholescriptsClient(API, CREDS, fetch).getProductList()
    expect(all.map((p) => p.sku)).toContain("PP001")
    const searched = await new MakorWholescriptsClient(API, CREDS, fetch).getProductList(
      "vitamin d",
    )
    expect(searched.map((p) => p.sku)).toEqual(["VD001", "VD002"])
  })

  test("Makor check_stock reads medPaxDetails.quantity for MedPax SKUs", async () => {
    const { makor } = harness()
    expect(await makor.checkStock(["SKU001", "PP001", "MPVD001", "MPCA001"])).toEqual({
      SKU001: true,
      PP001: false,
      MPVD001: true,
      MPCA001: false,
    })
  })

  test("unknown SKU and invalid body are 200 {success:false}; both consumers reject them", async () => {
    const { makor, backend } = harness()
    const order = sampleMakorOrder()
    order.context.fulfillment_items = [
      { product_id: "NOPE", quantity: 1, fulfillment: "individual" },
    ]
    await expect(makor.placeOrder(order)).rejects.toThrow(
      "WholeScripts rejected order: Invalid SKU: NOPE",
    )
    await expect(
      backend.placeOrder({
        ShippingAddress: { ...address, Zip: "ABC" },
        Items: [{ Sku: "SKU001", Quantity: 1 }],
        ShippingMethod: "Ground",
      }),
    ).rejects.toThrow(/Order submission failed: Invalid order: ShippingAddress.Zip/)
  })

  test("presets: submit_rejected, submit_timeout, status_empty, status_schema_drift, server_error, unauthorized", async () => {
    const h = harness()
    h.runtime.applyPreset("submit_rejected", "default", { count: 1 })
    await expect(h.makor.placeOrder(sampleMakorOrder())).rejects.toThrow(
      "WholeScripts rejected order: Payment authorization failed",
    )

    h.runtime.applyPreset("submit_timeout", "default", { count: 1 })
    await expect(h.makor.placeOrder(sampleMakorOrder())).rejects.toBeInstanceOf(VendorTimeoutError)
    // The order was placed even though the caller never heard back.
    const orphan = h.runtime.instance().orders().at(-1)
    expect(orphan?.status).toBe("Pending")

    const placed = await h.backend.placeOrder({
      ShippingAddress: address,
      Items: [{ Sku: "SKU001", Quantity: 1 }],
      ShippingMethod: "Ground",
    })
    h.runtime.applyPreset("status_empty", "default", { count: 1 })
    expect(await h.backend.getOrderStatus(placed.orderNumber)).toBeNull()
    h.runtime.applyPreset("status_schema_drift", "default", { count: 1 })
    expect(await h.backend.getOrderStatus(placed.orderNumber)).toBeNull()
    expect(h.backend.schemaErrors.length).toBe(1)
    expect(await h.backend.getOrderStatus(placed.orderNumber)).not.toBeNull()

    h.runtime.applyPreset("server_error", "default", { count: 3 })
    // Makor retries 5xx up to 3 times, then gives up with a temporary error.
    await expect(h.makor.getOrderStatus(placed.orderNumber)).rejects.toThrow("WholeScripts 500")
    h.runtime.applyPreset("unauthorized", "default", { count: 1 })
    await expect(h.makor.getOrderStatus(placed.orderNumber)).rejects.toBeInstanceOf(
      VendorPermanentError,
    )
  })

  test("Basic auth: missing credentials are 401; configured accounts reject other pairs", async () => {
    const { runtime, admin } = harness()
    const bare = await runtime.fetch(new Request(`${API}/api/Orders/PrivateLabelProductList`))
    expect(bare.status).toBe(401)
    expect(await bare.json()).toEqual({
      Message: "Authorization has been denied for this request.",
    })
    await admin("/settings", { accounts: [CREDS] }, "PUT")
    const wrong = new MakorWholescriptsClient(API, { username: "x", password: "y" }, (r) =>
      runtime.fetch(r),
    )
    await expect(wrong.getPrivateLabelProductList()).rejects.toThrow("WholeScripts 401")
    const right = new MakorWholescriptsClient(API, CREDS, (r) => runtime.fetch(r))
    expect((await right.getPrivateLabelProductList()).privateLabelCartons).toHaveLength(1)
  })

  test("namespaces by Basic username isolate parallel workers; the journal holds no PHI", async () => {
    const { runtime } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "worker-a": "a", "worker-b": "b" } }),
      }),
    )
    const worker = (username: string) =>
      new MakorWholescriptsAdapter(
        new MakorWholescriptsClient(API, { username, password: "x" }, (r) => runtime.fetch(r)),
      )
    const placed = await worker("worker-a").placeOrder(sampleMakorOrder())
    expect((await worker("worker-a").getOrderStatus(placed.vendor_order_id)).status).toBe("placed")
    expect((await worker("worker-b").getOrderStatus(placed.vendor_order_id)).status).toBe("unknown")
    const journal = (await (
      await runtime.fetch(
        new Request(`${API}/__admin/requests?namespace=a&operationId=SubmitOrder`),
      )
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.orderNumber).toBe(placed.vendor_order_id)
    const text = JSON.stringify(journal)
    expect(text).not.toContain("Lovelace")
    expect(text).not.toContain("1 Main St")
    // The stored order keeps SKUs and quantities only.
    expect(JSON.stringify(runtime.instance("a").orders())).not.toContain("Lovelace")
  })

  test("PUT /__admin/catalog replaces the catalog for the namespace", async () => {
    const { admin, makor } = harness()
    const response = await admin(
      "/catalog",
      { products: [], medPaxPills: [], privateLabelCartons: [] },
      "PUT",
    )
    expect(response.status).toBe(200)
    await expect(makor.placeOrder(sampleMakorOrder())).rejects.toThrow("Invalid SKU")
  })

  test("autoAdvance walks orders along a path on the mock clock", async () => {
    const { runtime, makor, admin } = harness()
    await admin(
      "/settings",
      { autoAdvance: { afterMs: 60_000, path: ["Processing", "Complete"] } },
      "PUT",
    )
    const placed = await makor.placeOrder(sampleMakorOrder())
    runtime.clock.advance(60_000)
    expect((await makor.getOrderStatus(placed.vendor_order_id)).raw_status).toBe("Processing")
    runtime.clock.advance(60_000)
    const done = await makor.getOrderStatus(placed.vendor_order_id)
    expect(done.status).toBe("shipped")
    expect(done.tracking_numbers).toHaveLength(1)
  })

  test("every status our Makor mapper recognises is reachable through a transition", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("Pending", "Processing", "Complete", "Cancelled", "Error", "On Hold"),
        fc.boolean(),
        async (to, withTracking) => {
          const { makor, admin } = harness()
          const placed = await makor.placeOrder(sampleMakorOrder())
          await admin(`/orders/${placed.vendor_order_id}/transition`, {
            to,
            ...(withTracking ? { trackingNumber: "1ZP" } : {}),
          })
          const status = await makor.getOrderStatus(placed.vendor_order_id)
          expect(status.status).toBe(mapWsStatus(to, status.tracking_numbers))
          expect(status.raw_status).toBe(to)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(WHOLESCRIPTS_PRESETS).sort()).toEqual(
      [
        "server_error",
        "status_empty",
        "status_schema_drift",
        "submit_rejected",
        "submit_timeout",
        "unauthorized",
      ].sort(),
    )
  })
})

describe("served over HTTP", () => {
  test("the consumers work against the node server, and auto-advance runs on its own", async () => {
    const server = await createServer({
      settings: { autoAdvance: { afterMs: 50, path: ["Processing", "Complete"] } },
    })
    try {
      const makor = new MakorWholescriptsAdapter(
        new MakorWholescriptsClient(server.url, CREDS, (r) => fetch(r)),
      )
      const placed = await makor.placeOrder(sampleMakorOrder())
      const deadline = Date.now() + 3_000
      let status = await makor.getOrderStatus(placed.vendor_order_id)
      while (status.raw_status !== "Complete" && Date.now() < deadline) {
        await Bun.sleep(25)
        status = await makor.getOrderStatus(placed.vendor_order_id)
      }
      expect(status.status).toBe("shipped")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^wholescripts@/)

      // A dropped submit destroys the socket: plain fetch rejects, the order still exists.
      server.runtime.applyPreset("submit_timeout", "default", { count: 1 })
      await expect(makor.placeOrder(sampleMakorOrder())).rejects.toBeInstanceOf(VendorTimeoutError)
      expect(server.runtime.instance().orders()).toHaveLength(2)
    } finally {
      await server.close()
    }
  })
})
