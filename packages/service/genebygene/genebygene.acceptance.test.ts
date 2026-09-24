import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import addressParity from "./corpus/address-parity.json" with { type: "json" }
import { createRuntime, GENEBYGENE_PRESETS, type GeneByGeneRuntime } from "./src/index.js"
import {
  buildQuantityOnlyCreateOrderBody,
  buildShippedCreateOrderBody,
  cancelOrder,
  demographicsToKitAttributes,
  extractGxgOrderIdFromWebhookBody,
  fetchResultPayload,
  fetchShippingOptions,
  GxgAuthService,
  GxgClient,
  GxgHttpClient,
  GxgKitAttributesPatchError,
  GxgWebhookReceiver,
  patchKitDemographics,
  patchOutboundShipmentAddress,
  placeOrder,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://gxg.mock"
const CALLBACK = "http://backend.local/webhooks/gene-by-gene"
const BUNDLE = "0d52219e-30a5-4a0d-b96d-0fe9a46d95e5"
const LAB_ONLY_BUNDLE = "16c26d93-f4f4-4ea1-8f2e-9991d0ef938a"
const CLIENT_ID = "febc7057-2904-4747-a076-55467fcece6f"
const ADDRESS = {
  isCommercial: false,
  recipientName: "Ada Lovelace",
  addressLine1: "400 N 5th St",
  addressLine2: null,
  city: "Phoenix",
  stateOrRegion: "AZ",
  postalCode: "85004",
  countryCode: "US",
  email: "ada@example.com",
  phone: "+16025550142",
}

/**
 * A runtime, our consumer's transport over it, and our webhook receiver fed by the hub. The
 * receiver's secrets are what our backend stores in KV: the one POST notificationSubscriptions
 * returned.
 */
const harness = async (options: { subscribe?: boolean; runtime?: GeneByGeneRuntime } = {}) => {
  const secrets: string[] = []
  const receiver = new GxgWebhookReceiver(() => secrets)
  const runtime =
    options.runtime ??
    createRuntime({
      webhooks: {
        fetch: (request) =>
          request.url === CALLBACK
            ? receiver.receive(request)
            : Promise.resolve(new Response("", { status: 404 })),
      },
    })
  const fetch = (request: Request) => runtime.fetch(request)
  const auth = new GxgAuthService({
    tokenUrl: `${API}/connect/token`,
    clientId: CLIENT_ID,
    clientSecret: "staging-secret",
    fetch,
  })
  const client = new GxgClient(new GxgHttpClient(API, auth, fetch))
  if (options.subscribe !== false) {
    const { secret } = await client.createNotificationSubscription(CALLBACK, [
      "GxG.Nucleus.Order.Created",
      "GxG.Nucleus.Order.KitNumbersGenerated",
      "GxG.Nucleus.Order.Shipped",
      "GxG.Nucleus.Kit.Received",
      "GxG.Nucleus.Kit.Completed",
      "GxG.Nucleus.Kit.Error",
      "GxG.Nucleus.Kit.KitOrderLine.Canceled",
    ])
    secrets.push(secret)
  }
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const settle = async () => {
    await runtime.webhooks.idle()
    return receiver.events.splice(0)
  }
  const place = async (placer = "geviti:238307:478b5ca52b7c91fb") => {
    const placed = await placeOrder(client, {
      productId: BUNDLE,
      placerOrderNumber: placer,
      address: ADDRESS,
    })
    if (!placed.ok) throw new Error(placed.message)
    return placed
  }
  return { runtime, client, auth, receiver, admin, settle, place, secrets }
}

describe("S2.9 acceptance: our consumer's logic against the mock", () => {
  test("order → Received → Completed: signed webhooks verify, and one scoped sync surfaces the results", async () => {
    const { runtime, client, admin, settle, place } = await harness()
    const placed = await place()
    expect(placed.placement).toBe("shipped")
    expect(placed.kitNumbers).toHaveLength(1)
    const kit = placed.kitNumbers[0] as string

    // Deliveries run concurrently (as GxG's do), so arrival order is not guaranteed.
    const created = (await settle()).sort((a, b) =>
      String(a.eventType).localeCompare(String(b.eventType)),
    )
    expect(created.map((e) => e.eventType)).toEqual([
      "GxG.Nucleus.Order.Created",
      "GxG.Nucleus.Order.KitNumbersGenerated",
    ])
    expect(created.every((e) => e.status === "verified")).toBe(true)
    // Known receiver bug, reproduced on purpose: Order.Created carries OrderGuid, not OrderId.
    expect(created[0]?.body.OrderGuid).toBe(placed.orderId)
    expect(created[0]?.orderId).toBeNull()
    expect(created[1]?.orderId).toBe(placed.orderId)
    expect(created[1]?.kitNumbers).toEqual([kit])

    expect((await admin(`/orders/${placed.orderId}/ship`, {})).status).toBe(200)
    const [shipped] = await settle()
    expect(shipped?.eventType).toBe("GxG.Nucleus.Order.Shipped")
    expect(extractGxgOrderIdFromWebhookBody(shipped?.body)).toBe(placed.orderId)

    expect((await admin(`/kits/${kit}/transition`, { to: "Received" })).status).toBe(200)
    const [received] = await settle()
    expect(received).toMatchObject({
      status: "verified",
      eventType: "GxG.Nucleus.Kit.Received",
      kitNumbers: [kit],
    })

    expect(
      (await admin(`/kits/${kit}/transition`, { to: "Completed", fixture: "pgx" })).status,
    ).toBe(200)
    const completed = await settle()
    expect(completed.map((e) => e.eventType)).toEqual([
      "GxG.Nucleus.Kit.Completed",
      "GxG.Nucleus.Kit.Completed",
    ])
    expect(completed.every((e) => e.status === "verified")).toBe(true)

    // The scoped sync our backend runs after a verified Kit.Completed.
    const kitDto = (await client.fetchKit(kit)) as { currentStatuses: { status: string }[] }
    expect(kitDto.currentStatuses.every((s) => s.status === "Completed")).toBe(true)
    const results = await client.fetchResultsByKitNumber({
      kitNumber: kit,
      offset: 0,
      pageSize: 100,
    })
    const json = results.items.find(
      (r) => r.resultType === "nutrigenomics_comprehensive_report_json",
    )
    expect(String(json?.resultPayload)).toBe(
      `s3://mockingbird-genebygene-results/default/${kit}.json`,
    )
    const payload = await fetchResultPayload(
      client,
      { kitNumber: kit, resultId: String(json?.resultId), resultType: String(json?.resultType) },
      (request) => runtime.fetch(request),
    )
    expect(payload.ok).toBe(true)
    const report = payload.ok ? JSON.parse(new TextDecoder().decode(payload.bytes)) : {}
    expect(report.barcode).toBe(kit)
    expect(report.health_sections[0].title).toBe("Medication Metabolism")
  })

  test("the presigned URL serves the result bytes with a plain GET, and a 403 is read as denied", async () => {
    const { runtime, client, admin, place } = await harness({ subscribe: false })
    const { kitNumbers } = await place()
    const kit = kitNumbers[0] as string
    await admin(`/kits/${kit}/transition`, { to: "Received" })
    // The PDF is published only when the transition asks for it.
    await admin(`/kits/${kit}/transition`, { to: "Completed", pdf: true })
    const plainGet = (request: Request) => runtime.fetch(request)
    const report = await fetchResultPayload(
      client,
      { kitNumber: kit, resultType: "nutrigenomics_comprehensive_report_json" },
      plainGet,
    )
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.contentType).toBe("application/json")
    const parsed = JSON.parse(new TextDecoder().decode(report.bytes)) as Record<string, unknown>
    expect(parsed.barcode).toBe(kit)
    expect(Array.isArray(parsed.health_sections)).toBe(true)
    const pdf = await fetchResultPayload(
      client,
      { kitNumber: kit, resultType: "nutrigenomics_comprehensive_report_pdf" },
      plainGet,
    )
    expect(pdf.ok && new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-")

    runtime.applyPreset("presigned_access_denied", "default", { count: 1 })
    const denied = await fetchResultPayload(client, { kitNumber: kit }, plainGet)
    expect(denied).toMatchObject({ ok: false, statusCode: 403, isAccessDenied: true })
    // An expired URL is denied too (the mock clock runs past X-Amz-Expires).
    const { presignedUrl } = await client.fetchResultPresignedUrl({ kitNumber: kit })
    runtime.clock.advance(3_601_000)
    const expired = await plainGet(new Request(presignedUrl))
    expect(expired.status).toBe(403)
    expect(await expired.text()).toContain("AccessDenied")
  })

  test("a blocked credential gets 400 invalid_client and our client stops asking", async () => {
    const { runtime, client, auth, admin } = await harness({ subscribe: false })
    await admin("/settings", { blockedClients: { [CLIENT_ID]: "invalid_client" } }, "PUT")
    await expect(client.fetchProduct(BUNDLE)).rejects.toThrow(/HTTP 400.*invalid_client/)
    expect(auth.isCredentialBlocked()).toBe(true)
    expect(auth.tokenRequests).toBe(1)
    await admin("/settings", { blockedClients: {} }, "PUT")
    await expect(client.fetchProduct(BUNDLE)).rejects.toThrow(/invalid_client/)
    expect(auth.tokenRequests).toBe(1)
    const journal = (await (
      await runtime.fetch(new Request(`${API}/__admin/requests?operationId=PostConnectToken`))
    ).json()) as { requests: { status: number }[] }
    expect(journal.requests.map((r) => r.status)).toEqual([400])
  })

  test("401 and 403 from the auth host block too; other failures do not", async () => {
    for (const [preset, status, blocks] of [
      ["invalid_client", 400, true],
      ["token_unauthorized", 401, true],
      ["token_forbidden", 403, true],
      ["rate_limited", 429, false],
    ] as const) {
      const { runtime, client, auth } = await harness({ subscribe: false })
      if (preset === "rate_limited") {
        runtime.faults.add({ id: "rl", operationId: "PostConnectToken", status: 429, count: 1 })
      } else {
        runtime.applyPreset(preset, "default", { count: 1 })
      }
      await expect(client.fetchProduct(BUNDLE)).rejects.toThrow(new RegExp(`HTTP ${status}`))
      expect(auth.isCredentialBlocked()).toBe(blocks)
    }
  })

  test("a 401 on the API invalidates the cached token and retries once", async () => {
    const { runtime, client, auth } = await harness({ subscribe: false })
    expect(await client.fetchProduct(BUNDLE)).not.toBeNull()
    expect(auth.tokenRequests).toBe(1)
    runtime.applyPreset("token_revoked", "default", { count: 1 })
    expect(await client.fetchProduct(BUNDLE)).not.toBeNull()
    expect(auth.tokenRequests).toBe(2)
    // Revoking every token (POST /__admin/tokens/revoke) is the same from the client's side.
    await runtime.fetch(new Request(`${API}/__admin/tokens/revoke`, { method: "POST" }))
    expect(await client.fetchProduct(BUNDLE)).not.toBeNull()
    expect(auth.tokenRequests).toBe(3)
  })

  test("Kit.Error 4 (delay) and 19 (new collection) carry the recorded shape", async () => {
    const { admin, settle, place } = await harness()
    const { kitNumbers } = await place()
    const kit = kitNumbers[0] as string
    await settle()
    await admin(`/kits/${kit}/transition`, { to: "Error", errorCode: 4 })
    await admin(`/kits/${kit}/transition`, { to: "Error", errorCode: 19 })
    const errors = await settle()
    expect(errors.map((e) => [e.body.ErrorCode, e.body.ErrorMessage])).toEqual([
      [4, "10 Day Delay"],
      [19, "New collection requested"],
    ])
    for (const event of errors) {
      expect(Object.keys(event.body).sort()).toEqual(
        [
          "AlternateKitId",
          "ErrorCode",
          "ErrorMessage",
          "KitNumber",
          "OrderLineId",
          "PlacerOrderNumber",
          "ProductCode",
        ].sort(),
      )
      expect(event.body.ProductCode).toBe("nt_custom_agena_panel")
      expect(event.body.PlacerOrderNumber).toBe("geviti:238307:478b5ca52b7c91fb")
    }
    const kitDto = (await admin("/kits")).body.kits as { status: string; errors: string[] }[]
    expect(kitDto[0]).toMatchObject({ status: "Error", errors: ["19"] })
  })

  test("webhook bodies have the recorded samples' keys (GXG/docs/webhook-events.json)", async () => {
    const { admin, settle, place } = await harness()
    const { orderId, kitNumbers } = await place()
    const kit = kitNumbers[0] as string
    await admin(`/orders/${orderId}/ship`, {})
    await admin(`/kits/${kit}/transition`, { to: "Received" })
    await admin(`/kits/${kit}/transition`, { to: "Completed" })
    const events = await settle()
    const keys = (type: string) =>
      Object.keys(events.find((e) => e.eventType === type)?.body ?? {}).sort()
    expect(keys("GxG.Nucleus.Order.Created")).toEqual(["OrderGuid", "OrderItems", "OrderType"])
    expect(keys("GxG.Nucleus.Order.KitNumbersGenerated")).toEqual([
      "OrderDate",
      "OrderId",
      "OrderLines",
    ])
    expect(keys("GxG.Nucleus.Kit.Received")).toEqual(["KitNumber"])
    expect(keys("GxG.Nucleus.Kit.Completed")).toEqual(
      [
        "AlternateKitId",
        "KitNumber",
        "OrderLineId",
        "PlacerOrderNumber",
        "ProductCode",
        "ProductDisplayName",
        "ProductId",
        "ProductType",
        "Results",
      ].sort(),
    )
    const shipment = (
      events.find((e) => e.eventType === "GxG.Nucleus.Order.Shipped")?.body.Shipments as
        | Record<string, unknown>[]
        | undefined
    )?.[0]
    expect(Object.keys(shipment ?? {}).sort()).toEqual(
      [
        "Address",
        "BundleProductId",
        "BundleProductName",
        "CloseoutDate",
        "CourierServiceCode",
        "CourierServiceName",
        "FulfillmentId",
        "Id",
        "IsInternational",
        "KitNumbers",
        "OrderDate",
        "OrderId",
        "OrderLineId",
        "PlacerOrderNumber",
        "ProductId",
        "ProductName",
        "Quantity",
        "ReturnLabels",
        "TrackingNumber",
      ].sort(),
    )
    const item = (events[0]?.body.OrderItems as Record<string, unknown>[] | undefined)?.[0]
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "Id",
      "KitNumbers",
      "PlacerOrderNumber",
      "Product",
      "Quantity",
    ])
  })

  test("three-layer cancel before the lab succeeds, and the vendor order reads as cancelled", async () => {
    const { runtime, client, admin, settle, place } = await harness()
    const { orderId } = await place()
    await settle()
    const outcome = await cancelOrder(client, orderId)
    expect(outcome).toMatchObject({ ok: true, kind: "cancelled" })
    // Kit.KitOrderLine.Canceled is published, but GxG rejects it in a subscription filter
    // ("Valid event type is required."), so our subscription never receives it.
    expect(await settle()).toEqual([])
    expect(runtime.webhooks.messages().map((m) => m.type)).toContain(
      "GxG.Nucleus.Kit.KitOrderLine.Canceled",
    )
    // Idempotent: nothing left to cancel reads as already cancelled.
    expect(await cancelOrder(client, orderId)).toMatchObject({ ok: true })
    expect((await admin("/kits")).body.kits).toMatchObject([{ canceled: true }])
  })

  test("cancel after shipping soft-continues past the shipped fulfillment", async () => {
    const { client, admin, place } = await harness({ subscribe: false })
    const { orderId } = await place()
    await admin(`/orders/${orderId}/ship`, {})
    expect(await cancelOrder(client, orderId)).toMatchObject({ ok: true, kind: "cancelled" })
  })

  test("cancel after the lab has the kit is 'not yet cancellable' (400 not in a cancellable status)", async () => {
    const { client, admin, place } = await harness({ subscribe: false })
    const { orderId, kitNumbers } = await place()
    await admin(`/orders/${orderId}/ship`, {})
    await admin(`/kits/${kitNumbers[0]}/transition`, { to: "In Lab" })
    expect(await cancelOrder(client, orderId)).toEqual({
      ok: false,
      code: "state_invalid",
      message: "Order is not yet cancellable",
    })
    const direct = await client.deleteKitOrderLines(kitNumbers[0] as string)
    expect(direct.response.status).toBe(400)
    expect(JSON.stringify(direct.error)).toMatch(/not in a cancellable status/)
  })

  test("updateShipmentAddress is visible on the next GET; a shipped shipment refuses", async () => {
    const { client, admin, place } = await harness({ subscribe: false })
    const { orderId } = await place()
    const patch = { line1: "1 E Washington St", city: "Phoenix", state: "az", zip: "85004" }
    expect(await patchOutboundShipmentAddress(client, orderId, patch)).toEqual({ ok: true })
    const tooLong = { ...patch, line1: "12345 North Extraordinarily Long Street Name" }
    const rejected = await patchOutboundShipmentAddress(client, orderId, tooLong)
    expect(rejected).toMatchObject({ ok: false })
    expect(JSON.stringify(rejected)).toMatch(/shipping address\(es\) not validated/i)
    await admin(`/orders/${orderId}/ship`, {})
    expect(await patchOutboundShipmentAddress(client, orderId, patch)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already has trackingNumber"),
    })
  })

  test("kit demographics PATCH: accepted, echoed on the kit, 400/422 on bad input, WBQA skipped", async () => {
    const { client, place } = await harness({ subscribe: false })
    const { kitNumbers } = await place()
    const kit = kitNumbers[0] as string
    const attrs = demographicsToKitAttributes({
      firstName: "Ada",
      lastName: "Lovelace",
      dob: "1985-02-14",
      sex: "female",
    })
    expect(await patchKitDemographics(client, kit, attrs)).toBe("patched")
    const dto = (await client.fetchKit(kit)) as {
      gender: string
      attributes: { name: string; value: string }[]
    }
    expect(dto.gender).toBe("F")
    expect(dto.attributes.map((a) => [a.name, a.value])).toContainEqual(["dateofbirth", "19850214"])
    const bad = await patchKitDemographics(client, kit, [
      { name: "dateofbirth", value: "02/14/1985" },
    ]).catch((e) => e)
    expect(bad).toBeInstanceOf(GxgKitAttributesPatchError)
    expect((bad as GxgKitAttributesPatchError).status).toBe(422)
    expect((bad as GxgKitAttributesPatchError).isValidationFailure).toBe(true)
    const unknown = await patchKitDemographics(client, kit, [
      { name: "shoe_size", value: "9" },
    ]).catch((e) => e)
    expect((unknown as GxgKitAttributesPatchError).status).toBe(400)
    expect(await patchKitDemographics(client, "WBQA1234ABCD", attrs)).toBe("skipped")
  })

  test("existing-kits order (recollection path) links the new lab order to the kit", async () => {
    const { client, settle, place } = await harness()
    const { kitNumbers } = await place()
    await settle()
    const { data } = await client.postCreateOrderForExistingKits({
      items: [
        {
          productId: LAB_ONLY_BUNDLE,
          kitNumbers,
          samples: kitNumbers.map((kitNumber) => ({
            kitNumber,
            attributes: [{ name: "firstName", value: "Ada" }],
          })),
          comment: null,
        },
      ],
      notes: null,
    })
    expect(data?.orderLines).toHaveLength(3)
    const [created] = await settle()
    expect(created?.body).toMatchObject({ OrderType: 3 })
    expect(
      (created?.body.OrderItems as { KitNumbers: string[] }[] | undefined)?.[0]?.KitNumbers,
    ).toEqual(kitNumbers)
    const kit = (await client.fetchKit(kitNumbers[0] as string)) as { currentStatuses: unknown[] }
    expect(kit.currentStatuses).toHaveLength(9)
  })

  test("presets: shipping_empty_500, address_not_validated, 35-char line, slow_orders", async () => {
    const { runtime, client } = await harness({ subscribe: false })
    runtime.applyPreset("shipping_empty_500", "default", { count: 1 })
    expect(await fetchShippingOptions(client, BUNDLE, ADDRESS)).toMatchObject({
      ok: false,
      code: "upstream",
    })

    runtime.applyPreset("address_not_validated", "default")
    const placed = await placeOrder(client, {
      productId: BUNDLE,
      placerOrderNumber: "p",
      address: ADDRESS,
    })
    expect(placed).toMatchObject({ ok: false, code: "validation" })
    expect(JSON.stringify(placed)).toMatch(/Address not found/i)
    runtime.faults.clear()

    const long = { ...ADDRESS, addressLine1: "x".repeat(36) }
    const options = await fetchShippingOptions(client, BUNDLE, long)
    expect(options).toMatchObject({ ok: false, code: "validation" })
    const direct = await client.postCreateOrder({
      items: [
        {
          productId: BUNDLE,
          shipments: [{ quantity: 1, address: long, courierServiceCode: "DHL_PARCEL_EXPEDITED" }],
        },
      ],
    })
    expect(direct.response.status).toBe(400)
    expect(JSON.stringify(direct.error).toLowerCase()).toContain(
      "shipping address(es) not validated",
    )

    runtime.applyPreset("slow_orders", "default", { count: 1, latencyMs: 150 })
    const started = performance.now()
    await placeOrder(client, { productId: BUNDLE, placerOrderNumber: "slow", address: ADDRESS })
    expect(performance.now() - started).toBeGreaterThanOrEqual(140)
  })

  test("a lab-only product falls back to a quantity-only order ('not valid for shipping options')", async () => {
    const { client } = await harness({ subscribe: false })
    const shipping = await fetchShippingOptions(client, LAB_ONLY_BUNDLE, ADDRESS)
    expect(shipping).toMatchObject({ ok: false })
    expect(JSON.stringify(shipping)).toContain("not valid for shipping options")
  })

  test("kit numbers are generated by default; no_kit_numbers / generateKitNumbers:false defer them", async () => {
    const { runtime, admin, settle, place } = await harness()
    runtime.applyPreset("no_kit_numbers", "default", { count: 1 })
    const placed = await place()
    expect(placed.kitNumbers).toEqual([])
    expect((await settle()).map((e) => e.eventType)).toEqual(["GxG.Nucleus.Order.Created"])
    await admin(`/orders/${placed.orderId}/kit-numbers`, {})
    const [generated] = await settle()
    expect(generated?.eventType).toBe("GxG.Nucleus.Order.KitNumbersGenerated")
    expect(generated?.kitNumbers[0]).toMatch(/^WB[0-9A-Z]{6}$/)
  })

  test("the subscription secret is returned only on create, and a wrong secret fails verification", async () => {
    const { client, receiver, secrets, place, settle } = await harness()
    const listed = await client.listVendorSubscriptions()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty("signingSecret")
    secrets.splice(0, secrets.length, "not-the-secret")
    await place()
    const events = await settle()
    expect(events.every((e) => e.status === "rejected" && e.reason === "signature-mismatch")).toBe(
      true,
    )
    expect(receiver.events).toHaveLength(0)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(GENEBYGENE_PRESETS)).toEqual(
      expect.arrayContaining([
        "invalid_client",
        "rate_limited",
        "shipping_empty_500",
        "address_not_validated",
        "slow_orders",
      ]),
    )
  })

  test("any kit-ladder walk keeps every subscribed delivery verifiable", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("Received", "In Lab", "In QC Analysis", "Error", "Completed"), {
          maxLength: 4,
        }),
        fc.constantFrom(4, 19),
        async (path, code) => {
          const { admin, settle, place } = await harness()
          const { kitNumbers } = await place()
          for (const to of path) {
            await admin(`/kits/${kitNumbers[0]}/transition`, { to, errorCode: code })
          }
          const events = await settle()
          expect(events.length).toBeGreaterThanOrEqual(2)
          expect(events.every((e) => e.status === "verified")).toBe(true)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 10 },
    )
  }, 60_000)
})

// ---------------------------------------------------------------------------------------------
// Issue #122: the production-parity drop-in, behaviour by behaviour (B1–B52).
// ---------------------------------------------------------------------------------------------

const DELUXE = "789af544-270c-40ff-9677-c492a87262cd"
const KIT_COMPONENT = "b1949749-19b0-4f72-a5c5-8f2414656607"
const REPORT_PRODUCT = "8dee4da8-5103-4209-bb91-b8beba6ee7e5"
const LAB_SERVICE = "a7c9c265-6d31-4391-8e93-342d9617fef5"
const MISSING_ID = "00000000-0000-4000-8000-000000000000"
const CODES = [
  "DHL_PARCEL_EXPEDITED",
  "FEDEX_EXPRESS_SAVER_ONE_RATE",
  "FEDEX_2_DAY_ONE_RATE",
  "FEDEX_PRIORITY_OVERNIGHT",
]
const cents = (value: number) => Math.round(value * 100) / 100

/** An `AddressDto` as our consumer sends it for a member (synthetic streets only). */
const addr = (over: Record<string, unknown>): Record<string, unknown> => ({
  isCommercial: false,
  recipientName: "Mockingbird Test",
  addressLine1: "1600 Amphitheatre Pkwy",
  addressLine2: null,
  addressLine3: null,
  city: "Mountain View",
  stateOrRegion: "CA",
  postalCode: "94043",
  countryCode: "US",
  email: "test@example.com",
  phone: "+15555550100",
  shippingInstruction: null,
  referenceId: null,
  ...over,
})
const MOUNTAIN_VIEW = addr({})
const PHOENIX_NOT_FOUND = addr({
  addressLine1: "501 N 5th St",
  city: "Phoenix",
  stateOrRegion: "AZ",
  postalCode: "85004",
})
const HONOLULU = addr({
  addressLine1: "825 Fort Street",
  city: "Honolulu",
  stateOrRegion: "HI",
  postalCode: "96813",
})

type Json = Record<string, unknown>

/** The drop-in harness: our consumer's transport, plus raw calls for the wire-level checks. */
const dropIn = async (options: { subscribe?: boolean; runtime?: GeneByGeneRuntime } = {}) => {
  const h = await harness(options)
  const raw = async (method: string, path: string, body?: unknown) => {
    const result = await h.client.http.request<Json>(method, path, {
      ...(body === undefined ? {} : { body }),
    })
    return { status: result.response.status, data: result.data, error: result.error as Json }
  }
  const settings = (patch: Json) => h.admin("/settings", patch, "PUT")
  const quote = (address: Json, productId = DELUXE) =>
    raw("POST", "/api/v2/fulfillments/actions/getShippingOptions", {
      shippingAddress: address,
      quantity: 1,
      productId,
    })
  const placeShipped = (
    address: Json,
    courierServiceCode = "FEDEX_EXPRESS_SAVER_ONE_RATE",
    placerOrderNumber = "geviti:1000:abc",
  ) =>
    raw(
      "POST",
      "/api/v2/orders",
      buildShippedCreateOrderBody({
        productId: DELUXE,
        placerOrderNumber,
        address,
        courierServiceCode,
      }),
    )
  const orders = async () =>
    (await raw("GET", "/api/v2/orders?offset=0&pageSize=500")).data as {
      totalCount: number
      items: Json[]
    }
  return { ...h, raw, settings, quote, placeShipped, orders }
}

type Line = {
  id: string
  productId: string
  bundleProductId: string | null
  placerOrderNumber: string | null
  currentStatus: string
  kitNumbers: string[] | null
  fulfillments: { id: string; currentStatus: string; shipments: Json[] }[] | null
}
const linesOf = (order: unknown) => (order as { orderLines: Line[] }).orderLines
const kitLineOf = (order: unknown) =>
  linesOf(order).find((l) => (l.fulfillments?.length ?? 0) > 0) as Line
const outboundOf = (order: unknown) =>
  kitLineOf(order).fulfillments?.[0]?.shipments.find((s) => s.isReturnShipment === false) as Json
const codesOf = (data: unknown) =>
  ((data as { shippingOptions: { courierServiceCode: string }[] }).shippingOptions ?? []).map(
    (o) => o.courierServiceCode,
  )
const pricesOf = (data: unknown) =>
  Object.fromEntries(
    (
      data as { shippingOptions: { courierServiceCode: string; estimatedPrice: number }[] }
    ).shippingOptions.map((o) => [o.courierServiceCode, o.estimatedPrice]),
  )

describe("issue #122: auth and catalog", () => {
  const tokenCall = (runtime: GeneByGeneRuntime) =>
    runtime.fetch(
      new Request(`${API}/connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "any-client",
          client_secret: "any-secret",
        }),
      }),
    )
  const products = (runtime: GeneByGeneRuntime, token?: string) =>
    runtime.fetch(
      new Request(`${API}/api/v2/products`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    )

  test("B1: any client pair gets a 3600 s Bearer token that reads the catalog", async () => {
    const runtime = createRuntime()
    const response = await tokenCall(runtime)
    expect(response.status).toBe(200)
    const token = (await response.json()) as Json
    expect(token).toMatchObject({ token_type: "Bearer", expires_in: 3600 })
    expect((await products(runtime, String(token.access_token))).status).toBe(200)
  })

  test("B2: no bearer is an empty 401 with WWW-Authenticate invalid_token", async () => {
    const response = await products(createRuntime())
    expect(response.status).toBe(401)
    expect(await response.text()).toBe("")
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"')
  })

  test("B3: the token dies at issuedAt + expires_in on the mock clock; a new one works", async () => {
    const runtime = createRuntime()
    const token = String(((await (await tokenCall(runtime)).json()) as Json).access_token)
    runtime.clock.advance(3_599_000)
    expect((await products(runtime, token)).status).toBe(200)
    runtime.clock.advance(1_000)
    const expired = await products(runtime, token)
    expect(expired.status).toBe(401)
    expect(await expired.text()).toBe("")
    const fresh = String(((await (await tokenCall(runtime)).json()) as Json).access_token)
    expect((await products(runtime, fresh)).status).toBe(200)
  })

  test("B4: the production deluxe bundle has six components, preassembly everywhere", async () => {
    const { settings, raw } = await dropIn({ subscribe: false })
    await settings({ catalog: "production" })
    const { status, data } = await raw("GET", `/api/v2/products?productId=${DELUXE}`)
    expect(status).toBe(200)
    const [bundle] = data as unknown as Json[]
    const components = (bundle as { components: { product: Json }[] }).components
    expect(components).toHaveLength(6)
    expect(bundle).toHaveProperty("preassembly")
    for (const c of components) expect(c.product).toHaveProperty("preassembly")
    expect(components.find((c) => c.product.id === KIT_COMPONENT)?.product).toMatchObject({
      shippingQualified: true,
      preassembly: true,
      maxOrderingQuantity: 500,
      price: 5,
    })
  })

  test("B5/B6: a component is found by id; an unknown id is 404", async () => {
    const { settings, raw } = await dropIn({ subscribe: false })
    await settings({ catalog: "production" })
    const component = await raw("GET", `/api/v2/products?productId=${KIT_COMPONENT}`)
    expect(component.status).toBe(200)
    expect((component.data as unknown as Json[])[0]?.id).toBe(KIT_COMPONENT)
    expect((await raw("GET", `/api/v2/products?productId=${MISSING_ID}`)).status).toBe(404)
  })

  test("B7/B8: the staging bundle quotes an empty 500 on production, and quotes on both", async () => {
    const { settings, client } = await dropIn({ subscribe: false })
    await settings({ catalog: "production" })
    const production = await client.postGetShippingOptions({
      shippingAddress: MOUNTAIN_VIEW,
      quantity: 1,
      productId: BUNDLE,
    })
    expect(production.response.status).toBe(500)
    expect(production.error).toBe("")
    await settings({ catalog: "both" })
    const both = await client.postGetShippingOptions({
      shippingAddress: MOUNTAIN_VIEW,
      quantity: 1,
      productId: BUNDLE,
    })
    expect(both.response.status).toBe(200)
    expect(codesOf(both.data).length).toBeGreaterThan(0)
  })
})

describe("issue #122: quotes", () => {
  test("B9: Mountain View residential is the zone-7 menu with the DHL surcharge", async () => {
    const { quote, runtime } = await dropIn({ subscribe: false })
    const { status, data } = await quote(MOUNTAIN_VIEW)
    expect(status).toBe(200)
    expect(data).toMatchObject({ dutiesAndTaxesIncluded: true, errorMessages: [] })
    expect(codesOf(data)).toEqual(CODES)
    expect(pricesOf(data)).toEqual({
      DHL_PARCEL_EXPEDITED: cents(cents(6 * 1.12) + 0.5),
      FEDEX_EXPRESS_SAVER_ONE_RATE: cents(14.91 * 1.12),
      FEDEX_2_DAY_ONE_RATE: cents(14.91 * 1.12),
      FEDEX_PRIORITY_OVERNIGHT: cents(62.23 * 1.12),
    })
    const [dhl] = (data as { shippingOptions: Json[] }).shippingOptions
    expect(dhl).toMatchObject({
      courierName: "DHL",
      courierServiceDisplayName: "DHL Expedited",
      attributes: { isSaturdayDelivery: "false", isOneRate: "false" },
    })
    // Next business morning, 08:00 in Houston, .NET 7-digit instants.
    const ship = new Date(String(dhl?.estimatedShipDate))
    expect(String(dhl?.estimatedShipDate)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.0000000Z$/)
    expect(ship.getTime()).toBeGreaterThan(runtime.clock.now())
    expect([1, 2, 3, 4, 5]).toContain(ship.getUTCDay())
    expect([13, 14]).toContain(ship.getUTCHours())
    expect(new Date(String(dhl?.estimatedDeliveryDate)).getTime()).toBeGreaterThan(ship.getTime())
  })

  test("B10: rural Oklahoma 73938 reproduces the recorded anchor exactly", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const { data } = await quote(
      addr({
        addressLine1: "100 Main St",
        city: "Forgan",
        stateOrRegion: "OK",
        postalCode: "73938",
      }),
    )
    expect(codesOf(data)).toEqual(CODES)
    expect(Object.values(pricesOf(data))).toEqual([6, 14.91, 14.91, 62.23])
  })

  test("B11: commercial addresses carry no DHL surcharge", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const { data } = await quote(addr({ isCommercial: true }))
    expect(codesOf(data)).toEqual(CODES)
    expect(pricesOf(data).DHL_PARCEL_EXPEDITED).toBe(cents(6 * 1.12))
  })

  test("B12: Honolulu is zone 8: DHL and Express Saver only", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const { data } = await quote(HONOLULU)
    expect(codesOf(data)).toEqual(["DHL_PARCEL_EXPEDITED", "FEDEX_EXPRESS_SAVER_ONE_RATE"])
    expect(pricesOf(data)).toEqual({
      DHL_PARCEL_EXPEDITED: cents(cents(6 * 1.35) + 0.5),
      FEDEX_EXPRESS_SAVER_ONE_RATE: cents(14.91 * 1.35),
    })
  })

  test("B13/B14: a 38-character line1 is refused on HTTP 200; 35 and 35 still quote", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const long = "1234 North Example Boulevard Extension"
    expect(long.length).toBe(38)
    const refused = await quote({ ...PHOENIX_NOT_FOUND, addressLine1: long })
    expect(refused.status).toBe(200)
    expect(refused.data).toMatchObject({
      shippingOptions: [],
      errorMessages: ["Address line exceeds 35 characters."],
    })
    const line1 = "1600 Amphitheatre Pkwy".padEnd(35, "X")
    const line2 = "Building 40 Mail Stop".padEnd(35, "Y")
    const fits = await quote(addr({ addressLine1: line1, addressLine2: line2 }))
    expect(codesOf(fits.data).length).toBeGreaterThan(0)
  })

  test("B15–B18: non-US, PO Box, military and missing fields are 200 errorMessages", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const cases: [Json, string[]][] = [
      [
        addr({
          addressLine1: "100 Queen St W",
          city: "Toronto",
          stateOrRegion: "ON",
          postalCode: "M5H 2N2",
          countryCode: "CA",
        }),
        ["Only US destinations are available for this product."],
      ],
      [
        { ...PHOENIX_NOT_FOUND, addressLine1: "PO Box 100" },
        ["PO Box addresses are not supported for this product."],
      ],
      [
        addr({ addressLine1: "Unit 1000", city: "APO", stateOrRegion: "AE", postalCode: "09012" }),
        ["Military addresses are not supported for this product."],
      ],
      [addr({ city: null, phone: null }), ["city is required.", "phone is required."]],
    ]
    for (const [address, messages] of cases) {
      const { status, data } = await quote(address)
      expect(status).toBe(200)
      expect((data as { shippingOptions: unknown[] }).shippingOptions).toEqual([])
      for (const message of messages) {
        expect((data as { errorMessages: string[] }).errorMessages).toContain(message)
      }
    }
    // Our consumer reads a non-empty errorMessages on HTTP 200 as a validation failure.
    const consumer = await fetchShippingOptions(
      (await dropIn({ subscribe: false })).client,
      DELUXE,
      { ...PHOENIX_NOT_FOUND, addressLine1: "PO Box 100" },
    )
    expect(consumer).toMatchObject({ ok: false, code: "validation" })
  })

  test("B19/B20: nothing to ship, or an unknown product, is a 400 ErrorDto", async () => {
    const { quote } = await dropIn({ subscribe: false })
    for (const productId of [REPORT_PRODUCT, MISSING_ID]) {
      const { status, error } = await quote(MOUNTAIN_VIEW, productId)
      expect(status).toBe(400)
      expect(error).toEqual({
        statusCode: 400,
        message: "This product Id is not valid for shipping options.",
        payload: {},
        errorType: "ValidationError",
      })
    }
  })

  test("B21: the not-found street still quotes the zone-5 menu", async () => {
    const { quote } = await dropIn({ subscribe: false })
    const { status, data } = await quote(PHOENIX_NOT_FOUND)
    expect(status).toBe(200)
    expect(codesOf(data)).toEqual(CODES)
    expect(pricesOf(data).FEDEX_PRIORITY_OVERNIGHT).toBe(cents(62.23 * 0.94))
  })
})

describe("issue #122: place", () => {
  test("B22/B23: a shipped deluxe place expands to six lines, one kit, null couriers, and both webhooks", async () => {
    const { placeShipped, raw, settle } = await dropIn()
    const { status, data } = await placeShipped(MOUNTAIN_VIEW)
    expect(status).toBe(200)
    expect(String(data?.id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const lines = linesOf(data)
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line.placerOrderNumber).toBe("geviti:1000:abc")
      expect(line.bundleProductId).toBe(DELUXE)
    }
    const kitLine = kitLineOf(data)
    expect(kitLine.productId).toBe(KIT_COMPONENT)
    expect(kitLine.fulfillments).toHaveLength(1)
    expect(kitLine.fulfillments?.[0]?.currentStatus).toBe("Ordered")
    const shipments = kitLine.fulfillments?.[0]?.shipments ?? []
    expect(shipments.map((s) => s.isReturnShipment).sort()).toEqual([false, true])
    for (const s of shipments) {
      expect(s).toMatchObject({ trackingNumber: null, courier: null, courierService: null })
    }
    expect(outboundOf(data).address).toEqual(MOUNTAIN_VIEW)
    expect(shipments.find((s) => s.isReturnShipment)?.address).toMatchObject({
      recipientName: "Gene by Gene",
      addressLine1: "1445 N Loop W",
      city: "Houston",
      stateOrRegion: "TX",
      postalCode: "77008",
      countryCode: "US",
    })
    const kits = new Set(lines.flatMap((l) => l.kitNumbers ?? []))
    expect(kits.size).toBe(1)
    const [kit] = [...kits]
    expect(kit).toMatch(/^WB[A-Z0-9]{6}$/)
    for (const line of lines) expect(line.kitNumbers).toEqual([kit as string])
    // Other component lines carry no fulfillment (the recorded production orders answer null).
    for (const line of lines.filter((l) => l !== kitLine))
      expect(line.fulfillments ?? []).toEqual([])
    expect((await raw("GET", `/api/v2/orders/${data?.id}`)).data).toEqual(data)

    const events = await settle()
    const generated = events.find((e) => e.eventType === "GxG.Nucleus.Order.KitNumbersGenerated")
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "GxG.Nucleus.Order.Created",
      "GxG.Nucleus.Order.KitNumbersGenerated",
    ])
    const generatedLines = generated?.body.OrderLines as { KitNumbers: string[] }[]
    expect(generatedLines).toHaveLength(6)
    for (const line of generatedLines) expect(line.KitNumbers).toEqual([kit as string])
  })

  test("B24: deferred association withholds kit numbers until the admin associates them", async () => {
    const { settings, placeShipped, admin, settle } = await dropIn()
    await settings({ kitAssociation: "deferred" })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    for (const line of linesOf(data)) expect(line.kitNumbers ?? []).toEqual([])
    expect((await settle()).map((e) => e.eventType)).toEqual(["GxG.Nucleus.Order.Created"])
    const associated = await admin(`/orders/${data?.id}/kit-numbers`, {})
    expect(associated.status).toBe(200)
    const kits = new Set(linesOf(associated.body).flatMap((l) => l.kitNumbers ?? []))
    expect(kits.size).toBe(1)
    const [generated] = await settle()
    expect(generated?.eventType).toBe("GxG.Nucleus.Order.KitNumbersGenerated")
    expect(generated?.kitNumbers).toEqual([...kits])
  })

  test("B25/B26: a street that quotes is Address Not Found at place, and nothing is stored", async () => {
    const { placeShipped, quote, orders } = await dropIn({ subscribe: false })
    const rural = addr({
      addressLine1: "1 Unlisted County Road 9",
      city: "Nowhere",
      stateOrRegion: "MT",
      postalCode: "59001",
    })
    const valles = addr({
      addressLine1: "4440 County Road 000",
      city: "Valles Mines",
      stateOrRegion: "MO",
      postalCode: "63087",
    })
    for (const address of [PHOENIX_NOT_FOUND, rural, valles]) {
      const quoted = await quote(address)
      expect(quoted.status).toBe(200)
      expect(codesOf(quoted.data).length).toBeGreaterThan(0)
      const placed = await placeShipped(address, "DHL_PARCEL_EXPEDITED")
      expect(placed.status).toBe(400)
      expect(placed.error).toEqual({
        statusCode: 400,
        message: `Shipping address(es) not validated: ${address.addressLine1} : Address Not Found`,
        payload: {},
        errorType: "ValidationError",
      })
    }
    // A state the ZIP3 table disagrees with (Beverly Hills in "TX") is the same class.
    const mismatch = addr({
      addressLine1: "9336 Civic Center Dr",
      city: "Beverly Hills",
      stateOrRegion: "TX",
      postalCode: "90210",
    })
    expect((await quote(mismatch)).status).toBe(200)
    expect((await placeShipped(mismatch)).error.message).toMatch(/: Address Not Found$/)
    expect((await orders()).totalCount).toBe(0)
  })

  test("B27: a long line at place is the same 400 template", async () => {
    const { placeShipped } = await dropIn({ subscribe: false })
    const line = "1234 North Example Boulevard Extension"
    const { status, error } = await placeShipped({ ...PHOENIX_NOT_FOUND, addressLine1: line })
    expect(status).toBe(400)
    expect(error.message).toBe(
      `Shipping address(es) not validated: ${line} : Address line exceeds 35 characters.`,
    )
  })

  test("B28/B30: an unknown code, or one the zone does not offer, is 'not valid for shipping options'", async () => {
    const { placeShipped, orders } = await dropIn({ subscribe: false })
    for (const [address, code] of [
      [MOUNTAIN_VIEW, "NOT_A_COURIER"],
      [HONOLULU, "FEDEX_PRIORITY_OVERNIGHT"],
    ] as const) {
      const { status, error } = await placeShipped(address, code)
      expect(status).toBe(400)
      expect(String(error.message)).toContain("not valid for shipping options")
    }
    expect((await orders()).totalCount).toBe(0)
  })

  test("B29: DHL_DOMESTIC_RETURN is accepted and stored on the outbound shipment", async () => {
    const { placeShipped, admin, settle } = await dropIn()
    const { status, data } = await placeShipped(MOUNTAIN_VIEW, "DHL_DOMESTIC_RETURN")
    expect(status).toBe(200)
    await settle()
    await admin(`/orders/${data?.id}/ship`, {})
    const [shipped] = await settle()
    const shipment = ((shipped?.body.Shipments ?? []) as Json[])[0]
    expect(shipment?.CourierServiceCode).toBe("DHL_DOMESTIC_RETURN")
    // DHL eCommerce tracking: 420 + destination ZIP5, 34 digits, a pure function of the id.
    expect(String(shipment?.TrackingNumber)).toMatch(/^42094043\d{26}$/)
    expect(String(shipment?.CloseoutDate)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
    const returns = shipment?.ReturnLabels as Json[]
    expect(String(returns[0]?.TrackingNumber)).toMatch(/^42077008\d{26}$/)
  })

  test("B31/B32: quantity-only places skip the address check, mint kits now, and have no shipment", async () => {
    const { raw, settle } = await dropIn()
    const { status, data } = await raw(
      "POST",
      "/api/v2/orders",
      buildQuantityOnlyCreateOrderBody({ productId: DELUXE, placerOrderNumber: "geviti:1:q" }),
    )
    expect(status).toBe(200)
    const lines = linesOf(data)
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line.fulfillments ?? []).toEqual([])
      expect(line.kitNumbers).toHaveLength(1)
    }
    expect((await settle()).map((e) => e.eventType).sort()).toEqual([
      "GxG.Nucleus.Order.Created",
      "GxG.Nucleus.Order.KitNumbersGenerated",
    ])
    const fulfillments = await raw("GET", `/api/v2/fulfillments?orderId=${data?.id}`)
    expect((fulfillments.data as { items: unknown[] }).items).toEqual([])
    const edit = await raw("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", {
      id: MISSING_ID,
      isReturnShipment: false,
      address: MOUNTAIN_VIEW,
    })
    expect(edit.status).toBe(404)
  })

  test("B33: the vendor does not dedupe placerOrderNumber", async () => {
    const { placeShipped, orders } = await dropIn({ subscribe: false })
    await placeShipped(MOUNTAIN_VIEW, "DHL_PARCEL_EXPEDITED", "geviti:1:same")
    await placeShipped(MOUNTAIN_VIEW, "DHL_PARCEL_EXPEDITED", "geviti:1:same")
    expect((await orders()).totalCount).toBe(2)
  })

  test("B34/B35: an existing-kit order sends OrderType 3 and no new kit; an unknown kit is 400", async () => {
    const { placeShipped, raw, settle, admin, orders } = await dropIn()
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    const kit = kitLineOf(data).kitNumbers?.[0] as string
    await settle()
    const kitsBefore = ((await admin("/kits")).body.kits as unknown[]).length
    const existing = await raw("POST", "/api/v2/orders/actions/createOrderForExistingKits", {
      items: [
        {
          productId: LAB_SERVICE,
          kitNumbers: [kit],
          samples: [{ kitNumber: kit, attributes: [{ name: "firstname", value: "Test" }] }],
        },
      ],
    })
    expect(existing.status).toBe(200)
    const events = await settle()
    expect(events.map((e) => e.eventType)).toEqual(["GxG.Nucleus.Order.Created"])
    expect(events[0]?.body.OrderType).toBe(3)
    expect(((await admin("/kits")).body.kits as unknown[]).length).toBe(kitsBefore)
    const total = (await orders()).totalCount
    const unknown = await raw("POST", "/api/v2/orders/actions/createOrderForExistingKits", {
      items: [{ productId: LAB_SERVICE, kitNumbers: ["WB000000"] }],
    })
    expect(unknown.status).toBe(400)
    expect((await orders()).totalCount).toBe(total)
  })
})

describe("issue #122: read, demographics, edit, cancel", () => {
  test("B36/B37: pages carry the true totalCount, pageSize caps at 500, unknown ids are 404", async () => {
    const { placeShipped, raw } = await dropIn({ subscribe: false })
    for (const n of [1, 2, 3]) await placeShipped(MOUNTAIN_VIEW, "DHL_PARCEL_EXPEDITED", `p:${n}`)
    const first = (await raw("GET", "/api/v2/orders?offset=0&pageSize=2")).data as Json
    expect(first).toMatchObject({ offset: 0, pageSize: 2, totalCount: 3 })
    expect(first.items).toHaveLength(2)
    const last = (await raw("GET", "/api/v2/orders?offset=2&pageSize=2")).data as Json
    expect(last.items).toHaveLength(1)
    const past = (await raw("GET", "/api/v2/orders?offset=10&pageSize=2")).data as Json
    expect(past).toMatchObject({ totalCount: 3, items: [] })
    expect(((await raw("GET", "/api/v2/orders?pageSize=5000")).data as Json).pageSize).toBe(500)
    expect((await raw("GET", `/api/v2/orders/${MISSING_ID}`)).status).toBe(404)
  })

  test("B38/B39: demographics round-trip, names are case-insensitive, bad values are 400/422", async () => {
    const { placeShipped, raw } = await dropIn({ subscribe: false })
    const kit = kitLineOf((await placeShipped(MOUNTAIN_VIEW)).data).kitNumbers?.[0] as string
    const attributes = [
      { name: "firstname", value: "Test" },
      { name: "lastname", value: "Person" },
      { name: "dateofbirth", value: "19850412" },
      { name: "gender", value: "F" },
      { name: "race", value: "Unknown" },
      { name: "ethnicity", value: "Unknown" },
    ]
    const patch = (list: unknown) =>
      raw("PATCH", `/api/v2/kits/${kit}/attributes`, { kitNumber: kit, attributes: list })
    const first = await patch(attributes)
    expect(first.status).toBe(200)
    const values = (data: unknown) =>
      Object.fromEntries((data as { name: string; value: string }[]).map((a) => [a.name, a.value]))
    expect(values(first.data)).toMatchObject(
      Object.fromEntries(attributes.map((a) => [a.name, a.value])),
    )
    expect(values((await patch(attributes)).data)).toEqual(values(first.data))
    const kitDto = (await raw("GET", `/api/v2/kits/${kit}`)).data as { attributes: Json[] }
    expect(values(kitDto.attributes)).toMatchObject(values(first.data))

    expect((await patch([{ name: "nope", value: "x" }])).status).toBe(400)
    expect((await patch([{ name: "dateofbirth", value: "1985-04-12" }])).status).toBe(422)
    expect((await patch([{ name: "gender", value: "female" }])).status).toBe(422)
    const renamed = await patch([{ name: "FirstName", value: "Renamed" }])
    const firstNames = (renamed.data as unknown as { name: string; value: string }[]).filter(
      (a) => a.name === "firstname",
    )
    expect(firstNames).toEqual([expect.objectContaining({ value: "Renamed" })])
  })

  test("B40/B41: the address edit replaces the outbound address until tracking exists", async () => {
    const { placeShipped, raw, admin } = await dropIn({ subscribe: false })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    const orderId = String(data?.id)
    const outbound = outboundOf(data)
    const returnBefore = kitLineOf(data).fulfillments?.[0]?.shipments.find(
      (s) => s.isReturnShipment,
    )
    const newYork = addr({
      addressLine1: "350 Fifth Avenue",
      city: "New York",
      stateOrRegion: "NY",
      postalCode: "10118",
    })
    const command = { id: outbound.id, isReturnShipment: false, address: newYork }
    const edited = await raw("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", command)
    expect(edited.status).toBe(200)
    expect(edited.data).toEqual(command)
    const after = (await raw("GET", `/api/v2/orders/${orderId}`)).data
    expect((outboundOf(after).address as Json).addressLine1).toBe("350 Fifth Avenue")
    expect(kitLineOf(after).fulfillments?.[0]?.shipments.find((s) => s.isReturnShipment)).toEqual(
      returnBefore,
    )

    // The place check re-runs: a not-found street is refused with the create strings.
    const refused = await raw("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", {
      ...command,
      address: PHOENIX_NOT_FOUND,
    })
    expect(refused.error.message).toBe(
      "Shipping address(es) not validated: 501 N 5th St : Address Not Found",
    )

    await admin(`/orders/${orderId}/ship`, {})
    const locked = await raw("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", {
      ...command,
      address: MOUNTAIN_VIEW,
    })
    expect(locked.status).toBe(400)
    expect(locked.error.message).toBe("The shipment address can not be updated")
    const final = (await raw("GET", `/api/v2/orders/${orderId}`)).data
    expect((outboundOf(final).address as Json).addressLine1).toBe("350 Fifth Avenue")
  })

  test("an instruction-only edit goes through even when the place check would refuse", async () => {
    const { placeShipped, raw, runtime } = await dropIn({ subscribe: false })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    const outbound = outboundOf(data)
    runtime.applyPreset("address_not_validated", "default")
    const edited = await raw("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", {
      id: outbound.id,
      isReturnShipment: false,
      address: MOUNTAIN_VIEW,
      shippingInstruction: "Leave at the front desk",
    })
    expect(edited.status).toBe(200)
    runtime.faults.clear()
    const shipments = (
      (await raw("GET", `/api/v2/fulfillments?orderId=${data?.id}`)).data as {
        items: { shipments: Json[] }[]
      }
    ).items[0]?.shipments
    const after = shipments?.find((s) => s.id === outbound.id) as Json
    expect(after.shippingInstruction).toBe("Leave at the front desk")
    expect((after.address as Json).shippingInstruction).toBe("Leave at the front desk")
  })

  test("B42/B43: fulfillment cancel sends KitOrderLine.Canceled; a received kit is not cancellable", async () => {
    const { placeShipped, raw, runtime, admin } = await dropIn({ subscribe: false })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    const fulfillment = kitLineOf(data).fulfillments?.[0]?.id
    expect((await raw("DELETE", `/api/v2/fulfillments/${fulfillment}`)).status).toBe(204)
    const again = await raw("DELETE", `/api/v2/fulfillments/${fulfillment}`)
    expect(again.status).toBe(400)
    expect(String(again.error.message)).toMatch(/not in a cancellable status/i)
    await runtime.webhooks.idle()
    expect(runtime.webhooks.messages().map((m) => m.type)).toContain(
      "GxG.Nucleus.Kit.KitOrderLine.Canceled",
    )

    const second = await placeShipped(MOUNTAIN_VIEW, "DHL_PARCEL_EXPEDITED", "p:2")
    const kit = kitLineOf(second.data).kitNumbers?.[0] as string
    await admin(`/kits/${kit}/transition`, { to: "Received" })
    const received = await raw("DELETE", `/api/v2/kits/${kit}/orderLines`)
    expect(received.status).toBe(400)
    expect(String(received.error.message)).toMatch(/not in a cancellable status/i)
    expect((await raw("DELETE", "/api/v2/kits/WB000000/orderLines")).status).toBe(404)
  })

  test("B44: namespaces never share kit numbers or orders", async () => {
    const runtime = createRuntime()
    const client = (ns: string) =>
      new GxgClient(
        new GxgHttpClient(
          `${API}/ns/${ns}`,
          new GxgAuthService({
            tokenUrl: `${API}/ns/${ns}/connect/token`,
            clientId: ns,
            clientSecret: "s",
            fetch: (r) => runtime.fetch(r),
          }),
          (r) => runtime.fetch(r),
        ),
      )
    const [a, b] = [client("worker-a"), client("worker-b")]
    const body = buildShippedCreateOrderBody({
      productId: DELUXE,
      placerOrderNumber: "p",
      address: MOUNTAIN_VIEW,
      courierServiceCode: "DHL_PARCEL_EXPEDITED",
    })
    const placedA = (await a.postCreateOrder(body)).data
    const placedB = (await b.postCreateOrder(body)).data
    expect(kitLineOf(placedA).kitNumbers).not.toEqual(kitLineOf(placedB).kitNumbers)
    const idsA = (await a.fetchVendorOrdersListPage({ offset: 0, pageSize: 50 })).items.map(
      (o) => o.id,
    )
    expect(idsA).toEqual([placedA?.id])
    expect(await b.fetchOrderFromVendor(String(placedA?.id))).toBeNull()
  })
})

describe("issue #122: results", () => {
  test("B45–B47: Results Completed publishes the JSON and raw rows to the bucket, one Kit.Completed per line", async () => {
    const { placeShipped, raw, admin, settle, runtime, client } = await dropIn()
    const kit = kitLineOf((await placeShipped(MOUNTAIN_VIEW)).data).kitNumbers?.[0] as string
    await settle()
    const done = await admin(`/kits/${kit}/transition`, {
      to: "Results Completed",
      fixture: "normal",
    })
    expect(done.status).toBe(200)
    const statuses = (done.body as { currentStatuses: { status: string; productId: string }[] })
      .currentStatuses
    expect(statuses.find((s) => s.productId === REPORT_PRODUCT)?.status).toBe("Results Completed")
    const rows = ((await raw("GET", `/api/v2/kits/${kit}/results`)).data as { kitResults: Json[] })
      .kitResults
    expect(rows.map((r) => r.resultType).sort()).toEqual([
      "nt_custom_agena_panel_data",
      "nutrigenomics_comprehensive_report_json",
    ])
    for (const row of rows) {
      expect(String(row.resultPayload)).toStartWith("s3://mockingbird-genebygene-results/default/")
    }
    const completed = (await settle()).filter((e) => e.eventType === "GxG.Nucleus.Kit.Completed")
    expect(completed).toHaveLength(2)
    expect(completed.every((e) => e.status === "verified")).toBe(true)

    // B46: the presigned URL is this mock's /__blob/<key>; it expires on the mock clock.
    const json = rows.find(
      (r) => r.resultType === "nutrigenomics_comprehensive_report_json",
    ) as Json
    const presigned = await raw(
      "GET",
      `/api/v2/results/results/presignedUrl?resultId=${json.resultid}&kitNumber=${kit}&resultType=${json.resultType}`,
    )
    expect(presigned.status).toBe(200)
    const url = String(presigned.data?.presignedUrl)
    expect(url).toMatch(/\/__blob\/.+\?.*X-Amz-Signature=/)
    const blob = await runtime.fetch(new Request(url))
    expect(blob.status).toBe(200)
    // B47: a synthetic report (no real genotype of a real person).
    const report = (await blob.json()) as Json
    expect(report.barcode).toBe(kit)
    const csv = await fetchResultPayload(
      client,
      { kitNumber: kit, resultType: "nt_custom_agena_panel_data" },
      (r) => runtime.fetch(r),
    )
    expect(csv.ok && new TextDecoder().decode(csv.bytes).split("\n")[0]).toBe(
      "RSID,CHROMOSOME,POSITION,RESULT",
    )
    runtime.clock.set(Date.parse(String(presigned.data?.expiresAt)) + 1_000)
    const expired = await runtime.fetch(new Request(url))
    expect(expired.status).toBe(403)
    expect(await expired.text()).toContain("<Code>AccessDenied</Code>")
  })

  test("B47: a PDF only when asked; pgx and ancestry stay available", async () => {
    const { placeShipped, raw, admin } = await dropIn({ subscribe: false })
    for (const [fixture, pdf] of [
      ["pgx", true],
      ["ancestry", false],
    ] as const) {
      const kit = kitLineOf(
        (await placeShipped(MOUNTAIN_VIEW, "DHL_PARCEL_EXPEDITED", fixture)).data,
      ).kitNumbers?.[0] as string
      expect(
        (await admin(`/kits/${kit}/transition`, { to: "Completed", fixture, pdf })).status,
      ).toBe(200)
      const types = (
        (await raw("GET", `/api/v2/kits/${kit}/results`)).data as { kitResults: Json[] }
      ).kitResults.map((r) => r.resultType)
      expect(types.includes("nutrigenomics_comprehensive_report_pdf")).toBe(pdf)
    }
  })
})

describe("issue #122: webhooks and subscriptions", () => {
  test("B48–B50: subscription rules, and the secret only on create", async () => {
    const { raw } = await dropIn({ subscribe: false })
    const create = (events: string[], endPoint = "https://backend.example/webhooks/gxg") =>
      raw("POST", "/api/v2/notificationSubscriptions", { type: "webhook", events, endPoint })
    const canceled = await create(["GxG.Nucleus.Kit.KitOrderLine.Canceled"])
    expect(canceled.status).toBe(400)
    expect(canceled.error.message).toBe("Valid event type is required.")
    const created = await create(["GxG.Nucleus.Order.Created"])
    expect(created.status).toBe(200)
    expect(typeof created.data?.secret).toBe("string")
    expect((await create(["GxG.Nucleus.Order.Created"])).status).toBe(400)
    const got = await raw("GET", `/api/v2/notificationSubscriptions/${created.data?.id}`)
    expect(typeof got.data?.secret).not.toBe("string")
    const listed = (await raw("GET", "/api/v2/notificationSubscriptions?type=webhook"))
      .data as unknown as Json[]
    expect(listed.every((s) => typeof s.secret !== "string")).toBe(true)
  })

  test("B51: every delivery is HMAC-SHA512 over the raw body, with the GxG headers", async () => {
    const received: { headers: Headers; body: string }[] = []
    const runtime = createRuntime({
      webhooks: {
        fetch: async (request) => {
          received.push({ headers: request.headers, body: await request.text() })
          return new Response("{}")
        },
      },
    })
    const { raw } = await dropIn({ subscribe: false, runtime })
    const { data } = await raw("POST", "/api/v2/notificationSubscriptions", {
      type: "webhook",
      events: ["GxG.Nucleus.Order.Created", "GxG.Nucleus.Order.KitNumbersGenerated"],
      endPoint: "https://backend.example/webhooks/gxg",
    })
    await raw(
      "POST",
      "/api/v2/orders",
      buildShippedCreateOrderBody({
        productId: DELUXE,
        placerOrderNumber: "p",
        address: MOUNTAIN_VIEW,
        courierServiceCode: "DHL_PARCEL_EXPEDITED",
      }),
    )
    await runtime.webhooks.idle()
    expect(received).toHaveLength(2)
    for (const { headers, body } of received) {
      const expected = `sha512=${createHmac("sha512", String(data?.secret)).update(body).digest("hex")}`
      expect(headers.get("gxg-signature")).toBe(expected)
      expect(headers.get("gxg-eventtype")).toMatch(/^GxG\.Nucleus\.Order\./)
      expect(headers.get("gxg-notificationid")).toBeTruthy()
      // Re-serializing the body is not what was signed if key order or spacing differ.
      const reserialized = JSON.stringify(JSON.parse(body), null, 1)
      expect(
        `sha512=${createHmac("sha512", String(data?.secret)).update(reserialized).digest("hex")}`,
      ).not.toBe(expected)
    }
  })

  test("B52: a failing receiver gets four attempts (now, 10 s, 1 min, 5 min); flush runs them", async () => {
    let attempts = 0
    const runtime = createRuntime({
      webhooks: {
        url: "https://backend.example/webhooks/gxg",
        secret: "s",
        events: ["GxG.Nucleus.Order.Created"],
        fetch: async () => {
          attempts++
          return new Response("nope", { status: 500 })
        },
      },
    })
    const { raw } = await dropIn({ subscribe: false, runtime })
    await raw(
      "POST",
      "/api/v2/orders",
      buildQuantityOnlyCreateOrderBody({ productId: DELUXE, placerOrderNumber: "p" }),
    )
    await runtime.webhooks.idle()
    expect(attempts).toBe(1)
    for (let i = 0; i < 5; i++) {
      await runtime.fetch(new Request(`${API}/__admin/webhooks/flush`, { method: "POST" }))
    }
    expect(attempts).toBe(4)
    const listed = (await (await runtime.fetch(new Request(`${API}/__admin/webhooks`))).json()) as {
      deliveries: { state: string; attempts: unknown[] }[]
    }
    expect(listed.deliveries).toEqual([expect.objectContaining({ state: "failed" })])
    expect(listed.deliveries[0]?.attempts).toHaveLength(4)
  })
})

describe("issue #122: test controls", () => {
  test("POST /__admin/addresses/classify shows both checks without placing anything", async () => {
    const { admin, orders } = await dropIn({ subscribe: false })
    const classify = async (body: Json) => (await admin("/addresses/classify", body)).body
    expect(await classify(MOUNTAIN_VIEW)).toMatchObject({
      quote: "options",
      place: "ok",
      zone: 7,
      codes: CODES,
    })
    expect(await classify(PHOENIX_NOT_FOUND)).toMatchObject({
      quote: "options",
      place: "address-not-found",
      zone: 5,
    })
    expect(await classify({ ...PHOENIX_NOT_FOUND, addressLine1: "PO Box 100" })).toMatchObject({
      quote: "errorMessages",
      place: "structural",
    })
    expect(
      await classify({ address: HONOLULU, courierServiceCode: "FEDEX_PRIORITY_OVERNIGHT" }),
    ).toMatchObject({ quote: "options", place: "bad-courier", zone: 8 })
    expect(await classify({ address: MOUNTAIN_VIEW, productId: REPORT_PRODUCT })).toMatchObject({
      quote: "http400",
    })
    expect((await orders()).totalCount).toBe(0)
  })

  test("PUT /__admin/addresses/corpus adds a not-found street for one namespace", async () => {
    const { admin, placeShipped, quote } = await dropIn({ subscribe: false })
    const street = addr({
      addressLine1: "77 Synthetic Lane",
      city: "Austin",
      stateOrRegion: "TX",
      postalCode: "78701",
    })
    expect((await placeShipped(street, "DHL_PARCEL_EXPEDITED", "p:1")).status).toBe(200)
    const added = await admin(
      "/addresses/corpus",
      {
        kind: "quote-ok-place-not-found",
        addressLine1: "77 Synthetic Lane",
        city: "Austin",
        stateOrRegion: "TX",
        postalCode: "78701",
      },
      "PUT",
    )
    expect(added.status).toBe(200)
    expect(codesOf((await quote(street)).data).length).toBeGreaterThan(0)
    expect((await placeShipped(street, "DHL_PARCEL_EXPEDITED", "p:2")).error.message).toBe(
      "Shipping address(es) not validated: 77 Synthetic Lane : Address Not Found",
    )
  })

  test("presets: address_not_found fails the next shipped place only; shipping_empty_500; rate_limited", async () => {
    const { runtime, placeShipped, quote, raw } = await dropIn({ subscribe: false })
    runtime.applyPreset("address_not_found", "default")
    expect((await placeShipped(MOUNTAIN_VIEW)).error.message).toBe(
      "Shipping address(es) not validated: 1600 Amphitheatre Pkwy : Address Not Found",
    )
    expect((await placeShipped(MOUNTAIN_VIEW)).status).toBe(200)
    runtime.applyPreset("shipping_empty_500", "default", { count: 1 })
    const empty = await quote(MOUNTAIN_VIEW)
    expect(empty.status).toBe(500)
    runtime.faults.clear()
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await raw("GET", "/api/v2/products")
    expect(limited.status).toBe(429)
    expect(limited.error).toMatchObject({ statusCode: 429, payload: {} })
  })

  test("POST /__admin/scenario/happy-path walks associate → ship → … → Results Completed", async () => {
    const { settings, placeShipped, admin, settle } = await dropIn()
    await settings({ kitAssociation: "deferred" })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    await settle()
    const scenario = await admin("/scenario/happy-path", { orderId: data?.id })
    expect(scenario.status).toBe(200)
    expect(scenario.body.next).toBe(7)
    const types = (await settle()).map((e) => e.eventType)
    expect(types).toContain("GxG.Nucleus.Order.KitNumbersGenerated")
    expect(types).toContain("GxG.Nucleus.Order.Shipped")
    expect(types).toContain("GxG.Nucleus.Kit.Received")
    expect(types.filter((t) => t === "GxG.Nucleus.Kit.Completed")).toHaveLength(2)
  })

  test("the happy path with stepDelayMs moves only as the mock clock does", async () => {
    const { placeShipped, admin, runtime, raw } = await dropIn({ subscribe: false })
    const { data } = await placeShipped(MOUNTAIN_VIEW)
    const kit = kitLineOf(data).kitNumbers?.[0] as string
    const started = await admin("/scenario/happy-path", { orderId: data?.id, stepDelayMs: 60_000 })
    expect(started.body.next).toBe(1) // associate ran now; ship is due in a minute
    runtime.clock.advance(60_000)
    await raw("GET", `/api/v2/kits/${kit}`)
    const kitDto = (await raw("GET", `/api/v2/kits/${kit}`)).data as {
      currentStatuses: { status: string }[]
    }
    expect(kitDto.currentStatuses[0]?.status).toBe("Not Received")
    runtime.clock.advance(60_000)
    const received = (await raw("GET", `/api/v2/kits/${kit}`)).data as {
      currentStatuses: { status: string }[]
    }
    expect(received.currentStatuses[0]?.status).toBe("Received")
    runtime.clock.advance(10 * 60_000)
    const done = (await raw("GET", `/api/v2/kits/${kit}`)).data as {
      currentStatuses: { status: string }[]
    }
    expect(done.currentStatuses.some((s) => s.status === "Results Completed")).toBe(true)
  })
})

describe("issue #122: the address parity corpus (corpus/address-parity.json)", () => {
  // Replays the recorded (or, until a live run, the issue-documented) strings so CI locks them.
  for (const c of addressParity.cases) {
    test(`${c.operation}: ${c.name}`, async () => {
      const { quote, placeShipped } = await dropIn({ subscribe: false })
      const address = addr({ countryCode: "US", ...c.address })
      if (c.operation === "quote") {
        const { status, data } = await quote(address, addressParity.productId)
        expect(status).toBe(c.status)
        expect((data as { errorMessages: string[] }).errorMessages).toEqual(c.errorMessages ?? [])
        // Live parity records the courier codes as a set (sorted), never the menu order.
        if (c.courierServiceCodes) {
          expect(codesOf(data).sort()).toEqual([...c.courierServiceCodes].sort())
        }
      } else {
        const { status, error } = await placeShipped(address, c.courierServiceCode)
        expect(status).toBe(c.status)
        expect(error.message).toBe(c.message)
      }
    })
  }
})
