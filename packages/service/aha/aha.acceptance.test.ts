import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { AHA_PRESETS, type AhaWebhook, createRuntime } from "./src/index.js"
import type { Settings } from "./src/state.js"
import {
  AhaLabProviderConsumer,
  AhaServiceConsumer,
  AhaWebhookReceiver,
  bloodworkOrderRequest,
  mapAhaStatusToInternal,
  partnerSequenceFromIdempotencyKey,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://aha.mock"
const API_KEY = "acme_aha_test"
const API_SECRET = "aha-secret-for-tests"
const WEBHOOK_SECRET = "aha-webhook-secret"

const USER = {
  id: 4242,
  firstName: "Ada",
  lastName: "Lovelace",
  sex: "female",
  dob: "1985-12-10",
  phoneNumber: "+1 (602) 555-0142",
  email: "ada@example.com",
}
const ADDRESS = { line1: "1 Main St", city: "Phoenix", state: "AZ", zip: "85004" }
const PRACTITIONER = { firstName: "Grace", lastName: "Hopper", npiNumber: "1234567893" }
const TESTS = [{ test_code: "CMP", test_description: "Comprehensive metabolic panel" }]

/** A runtime whose webhooks land in a receiver running our backend's handler logic. */
const harness = (settings: Partial<Settings> = {}) => {
  const deliveries: { headers: Headers; body: AhaWebhook }[] = []
  const runtime = createRuntime({
    settings: { credentials: [{ apiKey: API_KEY, apiSecret: API_SECRET }], ...settings },
    webhooks: {
      url: "http://backend.local/bloodwork/aha-webhook",
      secret: WEBHOOK_SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: (await request.json()) as AhaWebhook })
        return Response.json({ success: true, message: "Webhook received" }, { status: 201 })
      },
    },
  })
  const send = (request: Request) => runtime.fetch(request)
  const service = new AhaServiceConsumer(
    { apiUrl: API, apiKey: API_KEY, apiSecret: API_SECRET },
    send,
  )
  const labProvider = new AhaLabProviderConsumer(
    { apiUrl: API, apiKey: API_KEY, apiSecret: API_SECRET },
    send,
  )
  const receiver = new AhaWebhookReceiver(WEBHOOK_SECRET)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /** Deliver every pending webhook to the receiver; returns what arrived. */
  const deliver = async () => {
    await runtime.webhooks.idle()
    const arrived = deliveries.splice(0)
    for (const delivery of arrived) {
      const outcome = receiver.receive(delivery.headers, delivery.body as Record<string, unknown>)
      expect(outcome.http).toBe(201)
    }
    return arrived.map((d) => d.body)
  }
  /** The checkout path: `createAhaOrderFromLabResult`, then the DB row it saves. */
  const checkout = async (sequence: number) => {
    const placed = await service.createOrUpdateOrder(
      bloodworkOrderRequest(sequence, USER, ADDRESS, PRACTITIONER, TESTS),
    )
    expect(placed.success).toBe(true)
    if (!placed.success) throw new Error("create-order failed")
    receiver.track(sequence, placed.ahaOrderNumber)
    return placed
  }
  return { runtime, service, labProvider, receiver, admin, deliver, checkout, deliveries }
}

describe("S10.6 acceptance: our consumer's logic against the mock", () => {
  test("checkout → create-order; Scheduled books the EMR appointment; Check Out + Sample Collected marks drawn", async () => {
    const { admin, deliver, checkout, receiver } = harness()
    const placed = await checkout(101)
    expect(placed.partnerOrderId).toBe("AC-101")
    expect(placed.ahaOrderNumber).toMatch(/^AHA-/)

    const scheduledAt = "2026-10-01T16:30:00.000Z"
    const moved = await admin("/orders/AC-101/transition", {
      status: "Scheduled",
      scheduledAt,
      timeZone: "America/Denver",
    })
    expect(moved.status).toBe(200)
    const [scheduled] = await deliver()
    // The trap fields: moment-parsable local time + IANA zone, alongside the DTO's fields.
    expect(scheduled).toMatchObject({
      status: "Scheduled",
      partnerOrderId: "AC-101",
      ahaOrderId: placed.ahaOrderNumber,
      scheduleServiceTime: "2026-10-01T10:30:00",
      scheduleServiceTimeZone: "America/Denver",
      scheduledServiceDate: "2026-10-01",
      scheduledServiceTime: "10:30",
    })
    const order = receiver.orders.get(101)
    expect(order?.appointment).toEqual({ at: scheduledAt, status: "booked" })
    expect(order?.hasScheduledInitialBloodwork).toBe(true)
    expect(order?.storefrontStatus).toBe("bloodwork.Awaiting Draw")

    await admin("/orders/AC-101/transition", { status: "Check In" })
    await admin("/orders/AC-101/transition", {
      status: "Check Out",
      drawStatus: "Sample Collected",
    })
    const [checkIn, checkOut] = await deliver()
    expect(checkIn).toMatchObject({ checkInTimeZone: "America/Denver" })
    expect(checkIn?.checkInDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(checkOut).toMatchObject({ drawStatus: "Sample Collected" })
    expect(checkOut?.drawStatusTime).toMatch(/^\d{2}:\d{2}$/)
    expect(receiver.orders.get(101)?.vitalBloodDrawn).toBe(true)
    expect(receiver.orders.get(101)?.storefrontStatus).toBe("bloodwork.Results Pending")
    expect(receiver.log).toEqual([])
  })

  test("Rescheduled moves the appointment; Cancelled cancels the test and the appointment", async () => {
    const { admin, deliver, checkout, receiver } = harness()
    await checkout(202)
    await admin("/orders/AC-202/transition", {
      status: "scheduled",
      scheduledAt: "2026-10-02T15:00:00Z",
      timeZone: "America/New_York",
    })
    await admin("/orders/AC-202/transition", {
      status: "RESCHEDULED",
      scheduledAt: "2026-10-05T18:00:00Z",
    })
    const [first, second] = await deliver()
    expect(first?.status).toBe("Scheduled")
    expect(second?.status).toBe("Rescheduled")
    expect(second?.scheduleServiceTime).toBe("2026-10-05T14:00:00")
    expect(receiver.orders.get(202)?.appointment).toEqual({
      at: "2026-10-05T18:00:00.000Z",
      status: "rescheduled",
    })
    await admin("/orders/AC-202/transition", { status: "Cancelled" })
    await deliver()
    expect(receiver.orders.get(202)?.isTestCancelled).toBe(true)
    expect(receiver.orders.get(202)?.appointment?.status).toBe("cancelled")
  })

  test("every status / drawStatus combination in the table reaches its handler branch", async () => {
    const table: [string, string | undefined, string | null][] = [
      ["Scheduled", undefined, "scheduled"],
      ["Rescheduled", undefined, "rescheduled"],
      ["Cancelled", undefined, "cancelled"],
      ["Check In", undefined, "checked_in"],
      ["Check Out", "Sample Collected", "draw_completed"],
      ["Check Out", "Completed", "draw_completed"],
      ["Check Out", "Patient Refused", "draw_failed_refused"],
      ["Check Out", "UTO", "draw_failed_uto"],
      ["Check Out", "Patient Not Home", "draw_failed_not_home"],
      ["Check Out", "Patient Rescheduled", "draw_failed_rescheduled"],
      ["Check Out", "Order Cancelled", "draw_failed_cancelled"],
      ["Check Out", "Others", "draw_failed_other"],
      ["Check Out", "Patient Asked to Reschedule", "draw_failed_other"],
      ["Lab Testing In Progress", undefined, "lab_testing"],
      // The handler's `null ?? normalizedOrder` turns "ignored" into an unknown-status no-op.
      ["Non Scheduled Update", undefined, "non_scheduled_update"],
    ]
    for (const [status, draw, internal] of table) {
      const { admin, deliver, checkout, receiver } = harness()
      await checkout(7)
      await admin("/orders/AC-7/transition", { status: "Scheduled" })
      await deliver()
      await admin("/orders/AC-7/transition", { status, ...(draw ? { drawStatus: draw } : {}) })
      const [event] = await deliver()
      expect(event?.status).toBe(status)
      expect(mapAhaStatusToInternal(String(event?.status), event?.drawStatus).internalStatus).toBe(
        internal,
      )
      const order = receiver.orders.get(7)
      if (internal?.startsWith("draw_failed_")) {
        expect(order?.isTestCancelled).toBe(true)
        expect(order?.slack.at(-1)).toEqual({ messageType: "incident", incident: true })
        expect(order?.storefrontStatus).toBe("bloodwork.Cancelled")
      }
      if (internal === "non_scheduled_update") {
        expect(receiver.log).toEqual(["Unknown internal status: non_scheduled_update"])
      } else {
        expect(receiver.log).toEqual([])
      }
    }
  })

  test("Check Out without a drawStatus defaults to Sample Collected (never the unknown check_out branch)", async () => {
    const { admin, deliver, checkout, receiver } = harness()
    await checkout(8)
    await admin("/orders/AC-8/transition", { status: "check_out" })
    const [event] = await deliver()
    expect(event).toMatchObject({ status: "Check Out", drawStatus: "Sample Collected" })
    expect(receiver.orders.get(8)?.vitalBloodDrawn).toBe(true)
  })

  test("webhooks carry Authorization: Token <AHA_WEBHOOK_SECRET>, which the guard accepts", async () => {
    const { admin, runtime, checkout, deliveries } = harness()
    await checkout(9)
    await admin("/orders/AC-9/transition", { status: "Check In" })
    await runtime.webhooks.idle()
    expect(deliveries[0]?.headers.get("authorization")).toBe(`Token ${WEBHOOK_SECRET}`)
    const wrongSecret = new AhaWebhookReceiver("other-secret")
    expect(
      wrongSecret.receive(deliveries[0]?.headers as Headers, deliveries[0]?.body as never).http,
    ).toBe(403)
  })

  test("a scheduled event without an explicit time uses the order's preferred slot and zone", async () => {
    const { service, admin, deliver, receiver } = harness()
    const request = {
      ...bloodworkOrderRequest(11, USER, ADDRESS, PRACTITIONER, TESTS),
      preferred_schedule_date: "2026-11-03",
      preferred_schedule_time: "08:15",
      patient_timezone: "America/Phoenix",
    }
    const placed = await service.createOrUpdateOrder(request)
    if (!placed.success) throw new Error("create failed")
    receiver.track(11, placed.ahaOrderNumber)
    await admin("/orders/AC-11/transition", { status: "Scheduled" })
    const [event] = await deliver()
    expect(event).toMatchObject({
      scheduleServiceTime: "2026-11-03T08:15:00",
      scheduleServiceTimeZone: "America/Phoenix",
    })
    expect(receiver.orders.get(11)?.appointment?.at).toBe("2026-11-03T15:15:00.000Z")
  })

  test("create-order is create-or-update: the same partner_order_id keeps its order_number", async () => {
    const { service } = harness()
    const request = bloodworkOrderRequest(12, USER, ADDRESS, PRACTITIONER, TESTS)
    const first = await service.createOrUpdateOrder(request)
    const again = await service.createOrUpdateOrder({
      ...request,
      patient_timezone: "America/Chicago",
    })
    expect(first.success && again.success).toBe(true)
    if (first.success && again.success) {
      expect(again.ahaOrderNumber).toBe(first.ahaOrderNumber)
      expect(again.message).toBe("Order updated successfully")
    }
  })

  test("autoSchedule emits Scheduled N ms after create on the mock clock", async () => {
    const { runtime, admin, deliver, checkout, receiver } = harness()
    await admin("/settings", { autoSchedule: { afterMs: 60_000 } }, "PUT")
    runtime.clock.freeze()
    runtime.clock.set(Date.UTC(2026, 8, 21, 14, 0, 0))
    await checkout(13)
    runtime.clock.advance(59_000)
    expect((await (await admin("/tick", {})).json()) as { applied: number }).toEqual({ applied: 0 })
    runtime.clock.advance(1_000)
    expect((await (await admin("/tick", {})).json()) as { applied: number }).toEqual({ applied: 1 })
    const [event] = await deliver()
    expect(event?.status).toBe("Scheduled")
    const appointment = receiver.orders.get(13)?.appointment
    expect(appointment?.status).toBe("booked")
    // Default lead: 24 h after creation.
    expect(Date.parse(appointment?.at as string) - runtime.clock.now()).toBe(86_400_000 - 60_000)
    expect((await (await admin("/tick", {})).json()) as { applied: number }).toEqual({ applied: 0 })
  })
})

describe("auth: HMAC and legacy modes", () => {
  test("a wrong secret is a 401 that AhaService reports as AHA_API_ERROR", async () => {
    const { runtime } = harness()
    const wrong = new AhaServiceConsumer(
      { apiUrl: API, apiKey: API_KEY, apiSecret: "not-the-secret" },
      (r) => runtime.fetch(r),
    )
    const result = await wrong.createOrUpdateOrder(
      bloodworkOrderRequest(20, USER, ADDRESS, PRACTITIONER, TESTS),
    )
    expect(result).toMatchObject({
      success: false,
      error: { code: "AHA_API_ERROR", message: "AHA API returned 401" },
    })
    if (!result.success) expect(String(result.error.details)).toContain("Invalid signature")
  })

  test("the signature covers the path only: a /ns/<name> prefix on AHA_API_URL still verifies", async () => {
    const { runtime } = harness()
    const scoped = new AhaServiceConsumer(
      { apiUrl: `${API}/ns/worker-1`, apiKey: API_KEY, apiSecret: API_SECRET },
      (r) => runtime.fetch(r),
    )
    const result = await scoped.createOrUpdateOrder(
      bloodworkOrderRequest(21, USER, ADDRESS, PRACTITIONER, TESTS),
    )
    expect(result.success).toBe(true)
    expect(runtime.instance("worker-1").orders()).toHaveLength(1)
    expect(runtime.instance().orders()).toHaveLength(0)
  })

  test("a stale X-TIMESTAMP is rejected; the tolerance is configurable", async () => {
    const { runtime, admin } = harness()
    const stale = new AhaServiceConsumer(
      { apiUrl: API, apiKey: API_KEY, apiSecret: API_SECRET },
      (r) => runtime.fetch(r),
      () => Date.now() - 10 * 60_000,
    )
    const order = bloodworkOrderRequest(22, USER, ADDRESS, PRACTITIONER, TESTS)
    expect((await stale.createOrUpdateOrder(order)).success).toBe(false)
    await admin("/settings", { timestampToleranceMs: 0 }, "PUT")
    expect((await stale.createOrUpdateOrder(order)).success).toBe(true)
  })

  test("bad_signature forces a 401 even for a correct signature", async () => {
    const { runtime, service } = harness()
    runtime.applyPreset("bad_signature", "default", { count: 1 })
    const order = bloodworkOrderRequest(23, USER, ADDRESS, PRACTITIONER, TESTS)
    expect(await service.createOrUpdateOrder(order)).toMatchObject({
      success: false,
      error: { code: "AHA_API_ERROR", message: "AHA API returned 401" },
    })
    expect((await service.createOrUpdateOrder(order)).success).toBe(true)
  })

  test("legacy mode (X-Acme-Auth-Key) works, and can be switched off", async () => {
    const { runtime, admin } = harness()
    const legacy = new AhaServiceConsumer(
      { apiUrl: API, apiKey: API_KEY, useLegacyAuth: true },
      (r) => runtime.fetch(r),
    )
    const order = bloodworkOrderRequest(24, USER, ADDRESS, PRACTITIONER, TESTS)
    expect((await legacy.createOrUpdateOrder(order)).success).toBe(true)
    const unknownKey = new AhaServiceConsumer(
      { apiUrl: API, apiKey: "acme_aha_other", useLegacyAuth: true },
      (r) => runtime.fetch(r),
    )
    expect((await unknownKey.createOrUpdateOrder(order)).success).toBe(false)
    await admin("/settings", { allowLegacy: false }, "PUT")
    expect(await legacy.createOrUpdateOrder(order)).toMatchObject({
      success: false,
      error: { code: "AHA_API_ERROR" },
    })
  })
})

describe("envelopes (G-A1) and the lab-provider port", () => {
  test("raw envelope suits AhaService and breaks the lab provider; wrapped is the reverse", async () => {
    const lab = {
      patient: {
        firstName: "Ada",
        lastName: "Lovelace",
        providerPatientId: "e2e-patient-1",
        sex: "female" as const,
        dob: "1985-12-10",
      },
      address: ADDRESS,
      orderingPhysician: { npi: "1234567893", fullName: "Grace Hopper" },
      providerProductIds: ["CMP"],
    }
    const raw = harness()
    expect(
      (
        await raw.service.createOrUpdateOrder(
          bloodworkOrderRequest(30, USER, ADDRESS, PRACTITIONER, TESTS),
        )
      ).success,
    ).toBe(true)
    expect(await raw.labProvider.placeOrder({ ...lab, idempotencyKey: "k-raw" })).toMatchObject({
      ok: false,
      error: { message: "Unexpected AHA create response", code: "upstream" },
    })

    const wrapped = harness()
    await wrapped.admin("/settings", { envelope: "wrapped" }, "PUT")
    expect(
      await wrapped.service.createOrUpdateOrder(
        bloodworkOrderRequest(31, USER, ADDRESS, PRACTITIONER, TESTS),
      ),
    ).toMatchObject({ success: false, error: { code: "INVALID_RESPONSE" } })
    const placed = await wrapped.labProvider.placeOrder({ ...lab, idempotencyKey: "k-wrapped" })
    expect(placed).toMatchObject({ ok: true, status: "placed" })
    if (placed.ok) {
      expect(placed.partnerOrderId).toBe(`AC-${partnerSequenceFromIdempotencyKey("k-wrapped")}`)
      expect(placed.providerOrderId).toMatch(/^AHA-/)
      // The lab provider cancels with the order_number in partner_order_id; the mock resolves it.
      expect(
        await wrapped.labProvider.cancelOrder({ providerOrderId: placed.providerOrderId }),
      ).toEqual({ ok: true, status: "cancelled" })
    }
  })

  test("X-Idempotency-Key replays the stored response; a changed body is a 409", async () => {
    const { runtime, labProvider, admin } = harness({ envelope: "wrapped" })
    const lab = {
      idempotencyKey: "checkout-777",
      patient: {
        firstName: "Ada",
        lastName: "Lovelace",
        providerPatientId: "e2e-patient-2",
        sex: "female" as const,
        dob: "1985-12-10",
      },
      address: ADDRESS,
      orderingPhysician: { npi: "1234567893", fullName: "Grace Hopper" },
      providerProductIds: ["CMP"],
    }
    const first = await labProvider.placeOrder(lab)
    const again = await labProvider.placeOrder(lab)
    expect(again).toEqual(first)
    expect(runtime.instance().orders()).toHaveLength(1)
    const changed = await labProvider.placeOrder({ ...lab, providerProductIds: ["LIPID"] })
    expect(changed).toMatchObject({ ok: false, error: { code: "upstream", retryable: true } })
    if (!changed.ok) expect(changed.error.message).toStartWith("AHA HTTP 409")
    expect((await admin("/orders")).status).toBe(200)
  })

  test("429 maps to rate_limit (retryable); an inner ERROR status is an upstream error", async () => {
    const { runtime, labProvider, service } = harness({ envelope: "wrapped" })
    const lab = {
      idempotencyKey: "k-429",
      patient: {
        firstName: "Ada",
        lastName: "Lovelace",
        providerPatientId: "e2e-patient-3",
        sex: "other" as const,
        dob: "1985-12-10",
      },
      address: ADDRESS,
      orderingPhysician: { npi: "1234567893", fullName: "Grace Hopper" },
      providerProductIds: ["CMP"],
    }
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect(await labProvider.placeOrder(lab)).toMatchObject({
      ok: false,
      error: { code: "rate_limit", retryable: true },
    })
    runtime.applyPreset("order_error", "default", { count: 1 })
    const failed = await labProvider.placeOrder({ ...lab, idempotencyKey: "k-error" })
    expect(failed).toMatchObject({ ok: false, error: { code: "upstream" } })
    if (!failed.ok) expect(failed.error.message).toContain("could not be verified")
    // AhaService never checks the inner status: with the raw envelope it reports success
    // with an empty order number (a consumer gap worth knowing about).
    await runtime.fetch(
      new Request(`${API}/__admin/settings`, {
        method: "PUT",
        body: JSON.stringify({ envelope: "raw" }),
      }),
    )
    runtime.applyPreset("order_error", "default", { count: 1 })
    expect(
      await service.createOrUpdateOrder(
        bloodworkOrderRequest(40, USER, ADDRESS, PRACTITIONER, TESTS),
      ),
    ).toMatchObject({ success: true, ahaOrderNumber: "" })
  })

  test("invalid_response and server_error surface as INVALID_RESPONSE / AHA_API_ERROR", async () => {
    const { runtime, service } = harness()
    const order = bloodworkOrderRequest(41, USER, ADDRESS, PRACTITIONER, TESTS)
    runtime.applyPreset("invalid_response", "default", { count: 1 })
    expect(await service.createOrUpdateOrder(order)).toMatchObject({
      success: false,
      error: { code: "INVALID_RESPONSE" },
    })
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect(await service.createOrUpdateOrder(order)).toMatchObject({
      success: false,
      error: { code: "AHA_API_ERROR", message: "AHA API returned 500" },
    })
  })
})

describe("cancel", () => {
  test("AhaService cancel succeeds, emits Cancelled, and our handler cancels the test", async () => {
    const { service, admin, deliver, checkout, receiver } = harness()
    await checkout(50)
    await admin("/orders/AC-50/transition", { status: "Scheduled" })
    await deliver()
    expect(await service.cancelOrder(50, "member asked")).toEqual({
      success: true,
      message: "Order cancelled successfully",
      status: "SUCCESS",
    })
    const [event] = await deliver()
    expect(event?.status).toBe("Cancelled")
    expect(receiver.orders.get(50)?.isTestCancelled).toBe(true)
    expect((await service.cancelOrder(50)).success).toBe(true)
  })

  test("an unknown order is a 404; a drawn order cannot be cancelled (inner ERROR)", async () => {
    const { service, admin, checkout } = harness()
    expect(await service.cancelOrder(999)).toMatchObject({
      success: false,
      error: { code: "AHA_API_ERROR", message: "AHA API returned 404" },
    })
    await checkout(51)
    await admin("/orders/AC-51/transition", { status: "Check Out", drawStatus: "Completed" })
    expect(await service.cancelOrder(51)).toMatchObject({ success: true, status: "ERROR" })
  })

  test("cancelWebhook: false cancels silently", async () => {
    const { service, checkout, runtime, deliveries, admin } = harness()
    await admin("/settings", { cancelWebhook: false }, "PUT")
    await checkout(52)
    expect((await service.cancelOrder(52)).success).toBe(true)
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(0)
    expect(runtime.instance().orders()[0]?.cancelled).toBe(true)
  })
})

describe("contract", () => {
  test("namespaces by API key isolate parallel workers; the journal holds no PHI", async () => {
    const { runtime } = harness({ credentials: [] })
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        body: JSON.stringify({ credentials: { acme_aha_worker_a: "a" } }),
      }),
    )
    const worker = new AhaServiceConsumer(
      { apiUrl: API, apiKey: "acme_aha_worker_a", useLegacyAuth: true },
      (r) => runtime.fetch(r),
    )
    const placed = await worker.createOrUpdateOrder(
      bloodworkOrderRequest(60, USER, ADDRESS, PRACTITIONER, TESTS),
    )
    expect(placed.success).toBe(true)
    expect(runtime.instance("a").orders()).toHaveLength(1)
    expect(runtime.instance().orders()).toHaveLength(0)
    const journal = (await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.partnerOrderId).toBe("AC-60")
    const text = JSON.stringify(journal)
    for (const phi of ["Lovelace", "1985-12-10", "Main St", "ada@example.com"]) {
      expect(text).not.toContain(phi)
    }
    // Nor does the mock's own state.
    expect(JSON.stringify(runtime.instance("a").orders())).not.toContain("Lovelace")
  })

  test("admin validation: unknown order 404, bad zone 400, settings mask secrets", async () => {
    const { admin, checkout } = harness()
    expect((await admin("/orders/AC-1/transition", { status: "Scheduled" })).status).toBe(404)
    await checkout(70)
    expect(
      (await admin("/orders/AC-70/transition", { status: "Scheduled", timeZone: "Mars/Olympus" }))
        .status,
    ).toBe(400)
    expect((await admin("/orders/AC-70/transition", { nope: 1 })).status).toBe(400)
    const settings = (await (await admin("/settings")).json()) as Settings
    expect(JSON.stringify(settings)).not.toContain(API_SECRET)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(AHA_PRESETS)).toEqual(
      expect.arrayContaining([
        "bad_signature",
        "rate_limited",
        "server_error",
        "order_error",
        "invalid_response",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })

  test("webhook_duplicate delivers twice; our handler is idempotent on repeats", async () => {
    const { runtime, admin, deliver, checkout, receiver } = harness()
    await checkout(80)
    runtime.applyPreset("webhook_duplicate", "default", { count: 1 })
    await admin("/orders/AC-80/transition", {
      status: "Scheduled",
      scheduledAt: "2026-12-01T17:00:00Z",
    })
    expect(await deliver()).toHaveLength(2)
    expect(receiver.orders.get(80)?.appointment?.at).toBe("2026-12-01T17:00:00.000Z")
  })

  test("any scheduledAt and zone round-trip through moment.tz in our handler", async () => {
    const zones = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 11, 31) }),
        fc.constantFrom(...zones),
        async (instant, zone) => {
          const at = Math.floor(instant / 60_000) * 60_000
          const { admin, deliver, checkout, receiver } = harness()
          await checkout(90)
          await admin("/orders/AC-90/transition", {
            status: "Scheduled",
            scheduledAt: at,
            timeZone: zone,
          })
          await deliver()
          const booked = receiver.orders.get(90)?.appointment?.at
          // Inside a DST fold the local time is ambiguous; moment picks the earlier instant.
          const delta = Date.parse(booked as string) - at
          expect(delta === 0 || delta === -3_600_000).toBe(true)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  }, 60_000)
})
