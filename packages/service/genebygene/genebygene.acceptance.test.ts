import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, GENEBYGENE_PRESETS, type GeneByGeneRuntime } from "./src/index.js"
import {
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
    expect(String(json?.resultPayload)).toBe(`s3://mockingbird-genebygene-results/${kit}.json`)
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
    await admin(`/kits/${kit}/transition`, { to: "Completed" })
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
    expect(JSON.stringify(rejected)).toMatch(/shipping address\(es\) not validated/)
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
    expect(JSON.stringify(placed)).toMatch(/Address not found/)
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
