import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, KNOWN_STATUSES, PHARMETIKA_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { isShippedOrLater } from "./src/statuses.js"
import {
  applyWebhook,
  type FulfillmentStatus,
  fetchCatalogItems,
  mapStatus,
  type Payment,
  PharmetikaConsumer,
  sampleRequest,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://pharmetika.mock"
const SECRET = "pmk-webhook-secret"
const TOKEN = "pmk-token-dev"
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TESTOSTERONE = "pharmetika:PMK-TESTCYP-200"

/** A runtime whose webhooks land in an in-memory receiver running our consumer's logic. */
const harness = (settings: Parameters<typeof createRuntime>[0] = {}) => {
  const deliveries: { headers: Headers; body: unknown }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: "http://backend.local/prescriptions/webhooks/pharmetika",
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.json() })
        return Response.json({ received: true }, { status: 202 })
      },
    },
    ...settings,
  })
  const consumer = new PharmetikaConsumer(
    {
      apiUrl: API,
      apiToken: TOKEN,
      practitionerIdentifier: "prac-global-1",
      webhookSecret: SECRET,
      clinicName: "Geviti",
    },
    (request) => runtime.fetch(request),
    () => runtime.clock.now(),
  )
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /** Deliver pending webhooks through `parseWebhook` and apply them to the payments. */
  const receive = async (payments: Payment[]) => {
    await runtime.webhooks.idle()
    const seen: FulfillmentStatus[] = []
    for (const delivery of deliveries.splice(0)) {
      const parsed = consumer.parseWebhook(delivery.headers, delivery.body)
      applyWebhook(payments, parsed)
      seen.push(parsed.fulfillmentStatus)
    }
    return seen
  }
  return { runtime, consumer, deliveries, admin, receive }
}

const paymentFor = (id: string, pharmacyOrderId: string): Payment => ({
  id,
  pharmacyOrderId,
  fulfillmentStatus: "submitted",
  trackingNumber: null,
  pharmacyStatus: "submitted",
})

describe("S12.1 acceptance: our Pharmetika adapter against the mock", () => {
  test("submit → admin transitions → webhooks and polling: submitted → processing → shipped → delivered", async () => {
    const { consumer, admin, receive } = harness()
    const result = await consumer.submit(sampleRequest("pay_1001"))
    expect(result).toMatchObject({ success: true, fulfillmentStatus: "submitted" })
    const id = result.pharmacyOrderId as string
    // The idempotency id is a UUIDv7 our side generated and persisted.
    expect(id).toMatch(UUID_V7)
    expect(consumer.persisted.get("pay_1001")).toBe(id)
    expect(consumer.calls).toEqual([
      "GET /api/v5/provider_portal/clinic/clinic_list",
      "GET /api/v5/provider_portal/provider/patient_list",
      "POST /api/v5/provider_portal/patient/create_new",
      `PUT /api/v5/provider_portal/medication_order/id/${id}/validate`,
      `PUT /api/v5/provider_portal/medication_order/id/${id}/submit`,
    ])
    expect((await consumer.getOrderStatus(id))?.fulfillmentStatus).toBe("submitted")

    const payment = paymentFor("pay_1001", id)
    const seen: FulfillmentStatus[] = []
    expect((await admin(`/orders/${id}/transition`, { to: "data_entry" })).status).toBe(200)
    seen.push(...(await receive([payment])))
    expect(payment.fulfillmentStatus).toBe("processing")
    expect((await consumer.getOrderStatus(id))?.fulfillmentStatus).toBe("processing")

    await admin(`/orders/${id}/transition`, { to: "shipped", tracking_id: "1ZPMK" })
    seen.push(...(await receive([payment])))
    expect(payment).toMatchObject({ fulfillmentStatus: "shipped", trackingNumber: "1ZPMK" })
    const shipped = await consumer.getOrderStatus(id)
    expect(shipped).toMatchObject({ fulfillmentStatus: "shipped", trackingNumber: "1ZPMK" })
    expect(shipped?.canCancel).toBe(false)

    await admin(`/orders/${id}/transition`, { to: "completed" })
    seen.push(...(await receive([payment])))
    expect(payment.fulfillmentStatus).toBe("delivered")
    expect((await consumer.getOrderStatus(id))?.fulfillmentStatus).toBe("delivered")
    expect(seen).toEqual(["processing", "shipped", "delivered"])
  })

  test("the persisted UUIDv7 makes a resubmit idempotent; different contents under it conflict", async () => {
    const { runtime, consumer, admin } = harness()
    const first = await consumer.submit(sampleRequest("pay_2002"))
    // A retry of the same payment rebuilds the payload (new date_issued and entry id) under
    // the same persisted identifier: the pharmacy answers as before, no second order.
    const again = await consumer.submit(sampleRequest("pay_2002"))
    expect(again).toEqual(first)
    const orders = (await (await admin("/orders")).json()) as { orders: unknown[] }
    expect(orders.orders).toHaveLength(1)

    // The same identifier for a different order is refused.
    consumer.persisted.set("pay_2003", first.pharmacyOrderId as string)
    const clash = await consumer.submit(sampleRequest("pay_2003", { catalogId: "PMK-ENCLO-25" }))
    expect(clash.success).toBe(false)
    expect(clash.error).toContain("already being submitted with other contents")
    expect(runtime.instance().orders()).toHaveLength(1)
  })

  test("submitted_but_500: the order exists; the retry under the same identifier succeeds", async () => {
    const { runtime, consumer } = harness()
    runtime.applyPreset("submitted_but_500", "default", { count: 1 })
    const failed = await consumer.submit(sampleRequest("pay_3003"))
    expect(failed).toMatchObject({ success: false, error: "Server Error" })
    const retried = await consumer.submit(sampleRequest("pay_3003"))
    expect(retried).toMatchObject({ success: true, pharmacyOrderId: failed.pharmacyOrderId })
    expect(runtime.instance().orders()).toHaveLength(1)
  })

  test("HTTP 200 with success: 0 is a failure; only true or 1 count as success", async () => {
    const outcome = async (preset: string) => {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default")
      return consumer.submit(sampleRequest(`pay_${preset}`))
    }
    expect(await outcome("validate_success_zero")).toEqual({
      success: false,
      fulfillmentStatus: "error",
      error: "Invalid DEA",
    })
    expect(await outcome("submit_success_zero")).toMatchObject({
      success: false,
      error: "Order could not be submitted.",
    })
    expect(await outcome("validate_422")).toMatchObject({
      success: false,
      error: "Please provide instructions",
    })
    expect(await outcome("success_boolean")).toMatchObject({ success: true })
    // success: "1" is neither true nor 1. The adapter reads the create as a failure but finds
    // the new patient on its second roster read; then validate "fails" with no messages.
    expect(await outcome("success_string")).toEqual({
      success: false,
      fulfillmentStatus: "error",
      error: "Validation failed",
    })
  })

  test("EPCS: a controlled substance is prepared, parks pending_prescriber_approval, and never submits", async () => {
    for (const preset of [undefined, "controlled_count_string", "controlled_nested_requests"]) {
      const { runtime, consumer, admin, receive } = harness()
      if (preset) runtime.applyPreset(preset, "default")
      const result = await consumer.submit(sampleRequest("pay_4004", { catalogId: TESTOSTERONE }))
      expect(result).toMatchObject({
        success: true,
        fulfillmentStatus: "submitted",
        pharmacyStatus: "pending_prescriber_approval",
        pharmacyPortalUrl: API,
      })
      const id = result.pharmacyOrderId as string
      expect(consumer.calls.at(-1)).toBe(`PUT /api/v5/provider_portal/medication_order/id/${id}`)
      expect(consumer.calls.some((call) => call.endsWith("/submit"))).toBe(false)
      expect(runtime.instance().orders()[0]?.workflow_status).toBe("pending_prescriber_approval")

      // A direct submit of the prepared order is refused with success: 0.
      const submit = await runtime.fetch(
        new Request(`${API}/api/v5/provider_portal/medication_order/id/${id}/submit`, {
          method: "PUT",
          headers: { "x-pmk-authentication-token": TOKEN, "content-type": "application/json" },
          body: JSON.stringify({
            clinic_identifier: "clinic-geviti-0001",
            medication_order_identifier: id,
            patient: { identification: { patient_id: 2 } },
            medication_requests: [
              {
                product_identification: { product_identifier: "PMK-TESTCYP-200" },
                quantity_authorized: 1,
                sig: "weekly",
              },
            ],
          }),
        }),
      )
      expect(submit.status).toBe(200)
      expect(((await submit.json()) as { success: number }).success).toBe(0)

      // The prescriber signs in the portal: the pharmacy starts work.
      const payment = paymentFor("pay_4004", id)
      await admin(`/orders/${id}/transition`, { to: "signed" })
      expect(await receive([payment])).toEqual(["processing"])
    }
  })

  test("every webhook variant resolves the order id, status and tracking our receiver reads", async () => {
    for (const variant of ["workflow_status", "status", "flat"] as const) {
      const { consumer, admin, receive, deliveries, runtime } = harness({
        settings: { webhookVariant: variant },
      })
      const { pharmacyOrderId } = await consumer.submit(sampleRequest(`pay_${variant}`))
      const id = pharmacyOrderId as string
      await admin(`/orders/${id}/transition`, { to: "shipped", tracking_id: "1ZVAR" })
      await runtime.webhooks.idle()
      expect(deliveries[0]?.headers.get("x-pharmetika-webhook-secret")).toBe(SECRET)
      const parsed = consumer.parseWebhook(deliveries[0]?.headers as Headers, deliveries[0]?.body)
      expect(parsed).toMatchObject({
        pharmacyOrderId: id,
        fulfillmentStatus: "shipped",
        pharmacyStatus: "shipped",
        trackingNumber: "1ZVAR",
      })
      await receive([])
    }
  })

  test("the receiver rejects a wrong secret (plain equality on x-pharmetika-webhook-secret)", async () => {
    const { consumer, admin, runtime, deliveries } = harness()
    const { pharmacyOrderId } = await consumer.submit(sampleRequest("pay_5005"))
    await admin(`/orders/${pharmacyOrderId}/transition`, { to: "data_entry" })
    await runtime.webhooks.idle()
    const delivery = deliveries[0] as { headers: Headers; body: unknown }
    const forged = new Headers(delivery.headers)
    forged.set("x-pharmetika-webhook-secret", "wrong")
    expect(() => consumer.parseWebhook(forged, delivery.body)).toThrow("Invalid webhook secret")
  })

  test("the status map: every documented workflow status reaches our mapper as the pharmacy spells it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KNOWN_STATUSES), async (to) => {
        const { consumer, admin } = harness()
        const { pharmacyOrderId } = await consumer.submit(sampleRequest("pay_map"))
        await admin(`/orders/${pharmacyOrderId}/transition`, { to })
        const status = await consumer.getOrderStatus(pharmacyOrderId as string)
        const mapped = mapStatus(to)
        // Shipped-or-later statuses carry a tracking id, which promotes submitted/processing.
        const expected =
          isShippedOrLater(to) && (mapped === "submitted" || mapped === "processing")
            ? "shipped"
            : mapped
        expect(status?.fulfillmentStatus).toBe(expected)
        expect(status?.pharmacyStatus).toBe(to)
      }),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  })

  test("cancel through v7 until the order ships; the adapter's strict success === 1 check", async () => {
    const { runtime, consumer, admin } = harness()
    const a = await consumer.submit(sampleRequest("pay_6006"))
    expect(await consumer.cancelOrder(a.pharmacyOrderId as string, "Replacing")).toEqual({
      success: true,
      fulfillmentStatus: "cancelled",
      pharmacyStatus: "cancelled",
    })
    expect((await consumer.getOrderStatus(a.pharmacyOrderId as string))?.fulfillmentStatus).toBe(
      "cancelled",
    )

    const b = await consumer.submit(sampleRequest("pay_6007"))
    await admin(`/orders/${b.pharmacyOrderId}/transition`, { to: "shipped" })
    const refused = await consumer.cancelOrder(b.pharmacyOrderId as string)
    expect(refused.success).toBe(false)
    // Discrepancy: the adapter joins `messages` as strings, but Pharmetika sends
    // [{message, type}] everywhere else, so the cancel error reads "[object Object]".
    expect(refused.error).toBe("[object Object]")

    // cancel answers success: true under the preset; the adapter's cancel accepts only 1.
    const c = await consumer.submit(sampleRequest("pay_6008"))
    runtime.applyPreset("cancel_success_true", "default", { count: 1 })
    expect((await consumer.cancelOrder(c.pharmacyOrderId as string)).success).toBe(false)
  })

  test("patient resolution: roster match, duplicate adoption, and a failed create", async () => {
    const found = harness()
    await found.admin("/patients", {
      patient_id: 100,
      demographics: {
        first_name: "ada",
        last_name: "LOVELACE",
        DOB: "1985-02-14",
        phone_primary: "6025550142",
      },
    })
    expect((await found.consumer.submit(sampleRequest("pay_7001"))).success).toBe(true)
    expect(found.consumer.calls.some((c) => c.includes("create_new"))).toBe(false)
    expect(found.runtime.instance().orders()[0]?.patient_id).toBe(100)

    const duplicate = harness()
    duplicate.runtime.applyPreset("patient_create_duplicate", "default", { count: 1 })
    // The roster read happens first and finds nothing; the create is refused as a duplicate
    // and the adapter adopts the named patient.
    expect((await duplicate.consumer.submit(sampleRequest("pay_7002"))).success).toBe(true)

    const broken = harness()
    broken.runtime.applyPreset("patient_create_500", "default", { count: 1 })
    expect(await broken.consumer.submit(sampleRequest("pay_7003"))).toMatchObject({
      success: false,
      error: "Pharmetika patient could not be resolved",
    })
  })

  test("clinic resolution by PHARMETIKA_CLINIC_NAME, from an array or a keyed object", async () => {
    for (const preset of [undefined, "clinic_list_keyed"]) {
      const { runtime } = harness()
      if (preset) runtime.applyPreset(preset, "default")
      const consumer = new PharmetikaConsumer(
        {
          apiUrl: API,
          apiToken: TOKEN,
          practitionerIdentifier: "p",
          webhookSecret: null,
          clinicName: "Geviti West",
        },
        (r) => runtime.fetch(r),
      )
      expect((await consumer.submit(sampleRequest("pay_c"))).success).toBe(true)
      expect(runtime.instance().orders()[0]?.clinic_identifier).toBe("clinic-geviti-west-0002")
    }
  })

  test("the order lookup's success: 0 and a revoked token both read as no status", async () => {
    const { runtime, consumer } = harness()
    const { pharmacyOrderId } = await consumer.submit(sampleRequest("pay_8008"))
    runtime.applyPreset("lookup_success_zero", "default", { count: 1 })
    expect(await consumer.getOrderStatus(pharmacyOrderId as string)).toBeNull()
    runtime.applyPreset("unauthorized", "default", { count: 1 })
    expect(await consumer.getOrderStatus(pharmacyOrderId as string)).toBeNull()
    expect(await consumer.getOrderStatus(pharmacyOrderId as string)).not.toBeNull()
  })

  test("the medication-template catalog: token, then Basic, then no credentials", async () => {
    const { runtime, admin } = harness()
    const send = (r: Request) => runtime.fetch(r)
    const byToken = await fetchCatalogItems({ apiUrl: API, apiToken: TOKEN }, send)
    expect(byToken.map((i) => i.vendorMedicationCode)).toContain("PMK-SERM-15")
    expect(byToken.find((i) => i.vendorMedicationCode === "PMK-SERM-15")?.strength).toBe("15 mg")
    const byBasic = await fetchCatalogItems(
      { apiUrl: API, username: "pmk-user", password: "pmk-pass" },
      send,
    )
    expect(byBasic).toEqual(byToken)
    expect(await fetchCatalogItems({ apiUrl: API }, send)).toEqual(byToken)

    await admin(
      "/settings",
      { anonymousCatalog: false, basic: [{ username: "pmk-user", password: "pmk-pass" }] },
      "PUT",
    )
    expect(
      await fetchCatalogItems({ apiUrl: API, username: "pmk-user", password: "pmk-pass" }, send),
    ).toEqual(byToken)
    await expect(fetchCatalogItems({ apiUrl: API }, send)).rejects.toThrow("401")
    await expect(
      fetchCatalogItems({ apiUrl: API, username: "pmk-user", password: "nope" }, send),
    ).rejects.toThrow("401")
  })

  test("tokens: any by default, an allow-list when set", async () => {
    const { runtime, admin } = harness()
    await admin("/settings", { tokens: [TOKEN] }, "PUT")
    const stranger = new PharmetikaConsumer(
      { apiUrl: API, apiToken: "stolen", practitionerIdentifier: "p", webhookSecret: null },
      (r) => runtime.fetch(r),
    )
    // The clinic list 401s (the body is not a clinic list), so the clinic never resolves.
    expect(await stranger.submit(sampleRequest("pay_x"))).toMatchObject({
      success: false,
      error: "Pharmetika clinic identifier could not be resolved",
    })
  })

  test("namespaces by token isolate parallel workers, and the journal holds no PHI", async () => {
    const { runtime } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "token-a": "a", "token-b": "b" } }),
      }),
    )
    const worker = (token: string) =>
      new PharmetikaConsumer(
        { apiUrl: API, apiToken: token, practitionerIdentifier: "p", webhookSecret: null },
        (r) => runtime.fetch(r),
      )
    const a = worker("token-a")
    const placed = await a.submit(sampleRequest("pay_9009"))
    expect(await a.getOrderStatus(placed.pharmacyOrderId as string)).not.toBeNull()
    expect(await worker("token-b").getOrderStatus(placed.pharmacyOrderId as string)).toBeNull()
    expect(runtime.instance("a").orders()).toHaveLength(1)
    const journal = (await (
      await runtime.fetch(
        new Request(`${API}/__admin/requests?namespace=a&operationId=SubmitMedicationOrder`),
      )
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.orderId).toBe(placed.pharmacyOrderId as string)
    const all = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).text()
    expect(all).not.toContain("Lovelace")
    expect(all).not.toContain("Inject 300 mcg")
    // Orders keep ids and statuses only, never demographics or sigs.
    expect(JSON.stringify(runtime.instance("a").orders())).not.toContain("Lovelace")
  })

  test("autoAdvance walks orders along a path on the mock clock (EPCS orders wait)", async () => {
    const { runtime, consumer, deliveries } = harness({
      settings: { autoAdvance: { afterMs: 60_000, path: ["data_entry", "shipped", "completed"] } },
    })
    const order = await consumer.submit(sampleRequest("pay_a1"))
    const epcs = await consumer.submit(sampleRequest("pay_a2", { catalogId: TESTOSTERONE }))
    const id = order.pharmacyOrderId as string
    runtime.clock.advance(60_000)
    expect((await consumer.getOrderStatus(id))?.fulfillmentStatus).toBe("processing")
    runtime.clock.advance(120_000)
    expect((await consumer.getOrderStatus(id))?.fulfillmentStatus).toBe("delivered")
    expect((await consumer.getOrderStatus(epcs.pharmacyOrderId as string))?.pharmacyStatus).toBe(
      "pending_prescriber_approval",
    )
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(3)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(PHARMETIKA_PRESETS)).toEqual(
      expect.arrayContaining([
        "validate_success_zero",
        "submit_success_zero",
        "prepare_success_zero",
        "lookup_success_zero",
        "validate_422",
        "success_boolean",
        "success_string",
        "cancel_success_true",
        "submitted_but_500",
        "patient_create_duplicate",
        "patient_create_500",
        "clinic_list_keyed",
        "controlled_count_string",
        "controlled_nested_requests",
        "unauthorized",
        "server_error",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })
})

describe("contract", () => {
  test("/health, admin error shape, and namespaces by header and by /ns/ prefix", async () => {
    const { runtime, admin } = harness()
    const health = await runtime.fetch(new Request(`${API}/health`))
    expect(((await health.json()) as { status: string; service: string }).service).toBe(
      "pharmetika",
    )
    const missing = await admin("/orders/nope/transition", { to: "shipped" })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { type: string } }).error.type).toBe(
      "mockingbird_admin",
    )
    const viaHeader = new PharmetikaConsumer(
      { apiUrl: API, apiToken: TOKEN, practitionerIdentifier: "p", webhookSecret: null },
      (r) => {
        const request = new Request(r)
        request.headers.set("x-mockingbird-namespace", "worker-h")
        return runtime.fetch(request)
      },
    )
    const viaPrefix = new PharmetikaConsumer(
      {
        apiUrl: `${API}/ns/worker-p`,
        apiToken: TOKEN,
        practitionerIdentifier: "p",
        webhookSecret: null,
      },
      (r) => runtime.fetch(r),
    )
    expect((await viaHeader.submit(sampleRequest("pay_h"))).success).toBe(true)
    expect((await viaPrefix.submit(sampleRequest("pay_p"))).success).toBe(true)
    expect(runtime.instance("worker-h").orders()).toHaveLength(1)
    expect(runtime.instance("worker-p").orders()).toHaveLength(1)
    expect(runtime.instance().orders()).toHaveLength(0)
  })
})

describe("served over HTTP", () => {
  test("the adapter works against the node server, and auto-advance fires webhooks on its own", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("x-pharmetika-webhook-secret") === SECRET) {
          received.push(await request.json())
        }
        return Response.json({ received: true }, { status: 202 })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}/prescriptions/webhooks/pharmetika`,
        secret: SECRET,
      },
      settings: { autoAdvance: { afterMs: 50, path: ["compounding", "shipped"] } },
    })
    try {
      const consumer = new PharmetikaConsumer(
        { apiUrl: server.url, apiToken: TOKEN, practitionerIdentifier: "p", webhookSecret: SECRET },
        (r) => fetch(r),
      )
      const placed = await consumer.submit(sampleRequest("pay_http"))
      expect(placed.success).toBe(true)
      const deadline = Date.now() + 3_000
      while (received.length < 2 && Date.now() < deadline) await Bun.sleep(25)
      const statuses = received.map((r) =>
        consumer.parseWebhook(new Headers({ "x-pharmetika-webhook-secret": SECRET }), r),
      )
      expect(statuses.map((s) => s.fulfillmentStatus)).toEqual(["processing", "shipped"])
      expect(statuses[0]?.pharmacyOrderId).toBe(placed.pharmacyOrderId as string)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^pharmetika@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
