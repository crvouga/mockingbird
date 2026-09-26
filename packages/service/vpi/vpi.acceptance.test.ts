import { describe, expect, test } from "bun:test"
import {
  createRuntime,
  DEFAULT_CLINIC_ID,
  DEFAULT_CLINIC_LOCATION_ID,
  DEFAULT_USER_ID,
  VPI_PRESETS,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type ErxRequest,
  type FulfillmentStatus,
  resolveMonotonicFulfillmentStatus,
  sampleRequest,
  TESTOSTERONE_MAPPING,
  VpiApiHttpError,
  VpiConsumer,
  VpiFulfillment,
} from "./test/consumer.js"

const API = "http://vpi.mock"
const EMAIL = "clinic@example.com"

/** A runtime plus our consumer over it, counting authentications and running on the mock clock. */
const harness = (email = EMAIL) => {
  const runtime = createRuntime()
  let auths = 0
  const fetch = (request: Request) => {
    if (new URL(request.url).pathname === "/accounts/authenticate") auths++
    return runtime.fetch(request)
  }
  const client = new VpiConsumer({ apiUrl: API, email, password: "secret" }, fetch, () =>
    runtime.clock.now(),
  )
  const vpi = new VpiFulfillment(client, { VPI_CLINIC_LOCATION_ID: DEFAULT_CLINIC_LOCATION_ID })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, client, vpi, admin, auths: () => auths }
}

/** Seed a clinic patient whose demographics match `request` (VPI patient creation is uncaptured). */
const seedPatient = async (
  admin: ReturnType<typeof harness>["admin"],
  request: ErxRequest,
  overrides: Record<string, unknown> = {},
) => {
  const response = await admin("/patients", {
    firstName: request.patient.firstName,
    lastName: request.patient.lastName,
    dateOfBirth: request.patient.dob,
    email: request.patient.email,
    phoneNumber: request.patient.phone.replace(/\D/g, ""),
    addresses: [
      {
        addressLine1: request.patient.address.line1,
        addressLine2: request.patient.address.line2,
        city: request.patient.address.city,
        state: request.patient.address.state,
        zipcode: request.patient.address.zip,
      },
    ],
    ...overrides,
  })
  expect(response.status).toBe(201)
}

const namedRequest = (paymentId: string, firstName: string): ErxRequest => {
  const request = sampleRequest(paymentId)
  return { ...request, patient: { ...request.patient, firstName } }
}

describe("S12.2 acceptance: our VPI draft rail against the mock", () => {
  test("draft → admin transitions → page-1 polling moves our status processing → shipped (with tracking)", async () => {
    const { vpi, admin } = harness()
    const outcome = await vpi.submitDraft(sampleRequest("pay_1001"), TESTOSTERONE_MAPPING)
    expect(outcome.verdict).toBe("submitted")
    expect(outcome.result).toMatchObject({
      success: true,
      fulfillmentStatus: "processing",
      pharmacyStatus: "vpi_api_draft_ready",
      portalAgentStatus: "draft_ready",
    })
    const id = outcome.result.pharmacyOrderId as string
    expect(id).toMatch(/^[0-9a-f]{24}$/)

    // Our payment row starts where submitDraft puts it and applies each poll monotonically.
    let status: FulfillmentStatus = outcome.result.fulfillmentStatus
    const seen: (FulfillmentStatus | undefined)[] = []
    const poll = async () => {
      const refreshed = await vpi.getOrderStatus({ pharmacyOrderId: id })
      seen.push(refreshed?.fulfillmentStatus)
      if (refreshed) status = resolveMonotonicFulfillmentStatus(status, refreshed.fulfillmentStatus)
      return refreshed
    }
    expect(await poll()).toEqual({
      fulfillmentStatus: "processing",
      pharmacyStatus: "Provider Signature Needed",
    })
    await admin(`/prescriptions/${id}/transition`, { to: "Order Received" })
    expect((await poll())?.fulfillmentStatus).toBe("submitted")
    await admin(`/prescriptions/${id}/transition`, { to: "In Process" })
    expect((await poll())?.fulfillmentStatus).toBe("processing")
    await admin(`/prescriptions/${id}/transition`, {
      to: "Order Completed",
      trackingNumber: "1ZVPI0001",
    })
    expect(await poll()).toEqual({
      fulfillmentStatus: "shipped",
      pharmacyStatus: "Order Completed",
      trackingNumber: "1ZVPI0001",
    })
    expect(seen).toEqual(["processing", "submitted", "processing", "shipped"])
    // Catalog S12 says every pharmacy walks submitted → processing → shipped → delivered. Our VPI
    // consumer cannot: the draft rail starts at `processing` (a monotonic row ignores the later
    // "Order Received" → submitted), and mapVpiPrescriptionStatus has no delivered status at all
    // ("Order Completed" is the last one, → shipped). The mock serves every status the map knows.
    expect(status).toBe("shipped")
  })

  test("cancelling moves a prescription to the archived list (rows keyed `id`), which our poll reads", async () => {
    const { vpi, admin } = harness()
    const outcome = await vpi.submitDraft(sampleRequest("pay_1002"), TESTOSTERONE_MAPPING)
    const id = outcome.result.pharmacyOrderId as string
    await admin(`/prescriptions/${id}/transition`, { to: "Cancelled" })
    expect(await vpi.getOrderStatus({ pharmacyOrderId: id })).toEqual({
      fulfillmentStatus: "cancelled",
      pharmacyStatus: "Cancelled",
    })
    // A status our map does not know is not a refresh (null), whatever list it sits in.
    await admin(`/prescriptions/${id}/transition`, { to: "Archived" })
    expect(await vpi.getOrderStatus({ pharmacyOrderId: id })).toBeNull()
  })

  test("status polling reads page 1, limit 5 only: a prescription pushed off by 5 newer ones is not found", async () => {
    const { vpi, admin } = harness()
    const first = await vpi.submitDraft(sampleRequest("pay_2000"), TESTOSTERONE_MAPPING)
    const id = first.result.pharmacyOrderId as string
    await admin(`/prescriptions/${id}/transition`, { to: "Order Received" })
    expect((await vpi.getOrderStatus({ pharmacyOrderId: id }))?.fulfillmentStatus).toBe("submitted")
    for (const name of ["Bea", "Cy", "Di", "Ed", "Flo"]) {
      const request = namedRequest(`pay_${name}`, name)
      await seedPatient(admin, request)
      const newer = await vpi.submitDraft(request, TESTOSTERONE_MAPPING)
      expect(newer.verdict).toBe("submitted")
      await admin(`/prescriptions/${newer.result.pharmacyOrderId}/transition`, {
        to: "Order Received",
      })
    }
    expect(await vpi.getOrderStatus({ pharmacyOrderId: id })).toBeNull()
  })

  test("a duplicate (active prescription for the same patient and product) needs review, never retries", async () => {
    const { vpi, runtime } = harness()
    expect((await vpi.submitDraft(sampleRequest("pay_3001"), TESTOSTERONE_MAPPING)).verdict).toBe(
      "submitted",
    )
    const again = await vpi.submitDraft(sampleRequest("pay_3002"), TESTOSTERONE_MAPPING)
    expect(again.verdict).toBe("needs_review")
    expect(again.result.errorCode).toBe("vpi_duplicate_prescription")

    const fresh = harness()
    fresh.runtime.applyPreset("duplicate_prescription", "default", { count: 1 })
    const flagged = await fresh.vpi.submitDraft(sampleRequest("pay_3003"), TESTOSTERONE_MAPPING)
    expect(flagged.result.errorCode).toBe("vpi_duplicate_prescription")
    expect(runtime.instance().prescriptions()).toHaveLength(1)
  })

  test("save presets: 409 after saving and 429 are ambiguous (needs_review), 400 retries via the browser", async () => {
    const ambiguous = harness()
    ambiguous.runtime.applyPreset("save_ambiguous_409", "default", { count: 1 })
    const conflicted = await ambiguous.vpi.submitDraft(
      sampleRequest("pay_4001"),
      TESTOSTERONE_MAPPING,
    )
    expect(conflicted.verdict).toBe("needs_review")
    expect(conflicted.result.errorCode).toBe("vpi_draft_state_unknown")
    // The draft really exists: that is why our classifier refuses to re-order blindly.
    expect(ambiguous.runtime.instance().prescriptions()).toHaveLength(1)

    const limited = harness()
    limited.runtime.applyPreset("save_rate_limited", "default", { count: 1 })
    expect(
      (await limited.vpi.submitDraft(sampleRequest("pay_4002"), TESTOSTERONE_MAPPING)).verdict,
    ).toBe("needs_review")
    expect(limited.runtime.instance().prescriptions()).toHaveLength(0)

    const rejected = harness()
    rejected.runtime.applyPreset("save_400", "default", { count: 1 })
    expect(
      (await rejected.vpi.submitDraft(sampleRequest("pay_4003"), TESTOSTERONE_MAPPING)).verdict,
    ).toBe("retry_via_browser")
  })

  test("patient resolution: an unknown patient is uncaptured (retry via browser) until a suite seeds one", async () => {
    const { vpi, admin } = harness()
    const stranger = namedRequest("pay_5001", "Zed")
    const blocked = await vpi.submitDraft(stranger, TESTOSTERONE_MAPPING)
    expect(blocked.verdict).toBe("retry_via_browser")
    expect(blocked.result.errorCode).toBe("vpi_patient_create_unavailable")
    await seedPatient(admin, stranger)
    expect((await vpi.submitDraft(stranger, TESTOSTERONE_MAPPING)).verdict).toBe("submitted")
  })

  test("an address or identity mismatch needs review; an ambiguous match needs review", async () => {
    const moved = harness()
    const request = sampleRequest("pay_5101")
    const elsewhere = {
      ...request,
      patient: { ...request.patient, address: { ...request.patient.address, line1: "9 Elm St" } },
    }
    const mismatch = await moved.vpi.submitDraft(elsewhere, TESTOSTERONE_MAPPING)
    expect(mismatch.verdict).toBe("needs_review")
    expect(mismatch.result.errorCode).toBe("vpi_patient_address_mismatch")

    const twins = harness()
    // A twin with the same name, DOB, email and phone: contact details cannot break the tie.
    await seedPatient(twins.admin, request)
    const ambiguous = await twins.vpi.submitDraft(request, TESTOSTERONE_MAPPING)
    expect(ambiguous.result.errorCode).toBe("vpi_patient_match_ambiguous")
  })

  test("provider resolution by NPI; an unmapped prescriber is not resolved", async () => {
    const { vpi } = harness()
    const request = sampleRequest("pay_5201")
    const unknown = { ...request, prescriber: { ...request.prescriber, npi: "1111111111" } }
    const result = await vpi.submitDraft(unknown, TESTOSTERONE_MAPPING)
    expect(result.result.errorCode).toBe("vpi_provider_not_resolved")
  })

  test("controlled substances never reach saveNewPrescription", async () => {
    const { vpi, runtime } = harness()
    const result = await vpi.submitDraft(sampleRequest("pay_5301"), {
      id: "64f1c2a9e4b0a1b2c3d4e5f9",
      productId: "5120_INJ",
      name: "Nandrolone Decanoate",
      productSize: "5mL",
      dispenseType: "Vial",
    })
    expect(result.result.errorCode).toBe("controlled_substance_excluded")
    expect(runtime.instance().prescriptions()).toHaveLength(0)
  })

  test("the mock enforces the save contract itself: a 2-letter state or a controlled product is a 400", async () => {
    const { client, runtime } = harness()
    const { jwtToken } = await client.authenticate()
    const payload = {
      patientIds: ["65a1c0de00000000000000f1"],
      clinicLocationId: DEFAULT_CLINIC_LOCATION_ID,
      providerId: "65a1c0de00000000000000e1",
      clinicId: DEFAULT_CLINIC_ID,
      userId: DEFAULT_USER_ID,
      products: [
        {
          id: "64f1c2a9e4b0a1b2c3d4e5f6",
          productId: "2185_INJ",
          name: "Testosterone Cypionate",
          unitPrice: 45.5,
          family: "Hormone Restoration",
          subCategory1: "Testosterone",
          subCategory2: "Injectables",
          commonName: "Testosterone Cypionate",
          sigOptions: [],
          productSize: "10mL",
          medicalAccessories: [],
          coldShipped: "0",
          controlledSubstance: "0",
          dispenseType: "Vial",
          reasonForCompoundedMedication: "",
          isReasonForCompoundedMedicationNeeded: false,
          productType: "S",
          patientPay: 62.5,
          ndc: "",
          quantity: 10,
          sig: "Use as directed",
          daySupply: 28,
          daySupplyReason: "",
          refills: 0,
          isCustomSig: true,
          discountedPercentage: 0,
          discountedPrice: 45.5,
          displayedGeneratedSig: "Use as directed",
        },
      ],
      rxPadProducts: [],
      shippingInfo: {
        isRushOrder: false,
        isSignatureRequired: false,
        orderNotes: "",
        shipTo: "Patient",
        isNewAddressUsed: false,
        shippingMethod: "UPS Ground",
        shippingAddress: {
          addressLine1: "1 Main St",
          addressLine2: "-",
          city: "Phoenix",
          state: "AZ",
          zipcode: "85004",
        },
        rushOrderCost: 0,
        rushOrderMethod: "",
      },
      patientNotificationRecipients: [],
    }
    const save = (body: unknown) =>
      runtime.fetch(
        new Request(`${API}/clinic/rxOrdering/saveNewPrescription`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${jwtToken}` },
          body: JSON.stringify(body),
        }),
      )
    const badState = await save(payload)
    expect(badState.status).toBe(400)
    expect(JSON.stringify(await badState.json())).toContain("shippingInfo.shippingAddress.state")
    payload.shippingInfo.shippingAddress.state = "Arizona"
    const product = payload.products[0] as Record<string, unknown>
    const controlled = await save({
      ...payload,
      products: [{ ...product, id: "64f1c2a9e4b0a1b2c3d4e5f9", productId: "5120_INJ" }],
    })
    expect(controlled.status).toBe(400)
    expect((await save(payload)).status).toBe(200)
  })

  test("JWT cached until exp minus 30 s on the mock clock, then re-authenticated", async () => {
    const { client, runtime, auths } = harness()
    await client.getAllFamiliesAndCategories()
    await client.getShippingStates()
    expect(auths()).toBe(1)
    runtime.clock.advance((3_600 - 30) * 1000 - 1_000)
    await client.getAllFamiliesAndCategories()
    expect(auths()).toBe(1)
    runtime.clock.advance(2_000)
    await client.getAllFamiliesAndCategories()
    expect(auths()).toBe(2)
  })

  test("the mock rejects an expired JWT with 401; a TTL under the 30 s skew makes our client refuse the token", async () => {
    const { client, runtime } = harness()
    const { jwtToken } = await client.authenticate()
    runtime.clock.advance(3_600_000)
    const stale = await runtime.fetch(
      new Request(`${API}/admin/rxOrdering/getShippingStates`, {
        headers: { authorization: `Bearer ${jwtToken}` },
      }),
    )
    expect(stale.status).toBe(401)

    const short = harness()
    await short.admin("/settings", { tokenTtlSeconds: 20 }, "PUT")
    await expect(short.client.authenticate()).rejects.toThrow(
      "VPI authentication response contains an expired JWT",
    )
  })

  test("token_expired (count 1): exactly one re-auth and the retry succeeds; unauthorized_twice fails with 401", async () => {
    const { client, runtime, auths } = harness()
    await client.authenticate()
    runtime.applyPreset("token_expired", "default", { count: 1 })
    const taxonomy = await client.getAllFamiliesAndCategories()
    expect(taxonomy.length).toBeGreaterThan(0)
    expect(auths()).toBe(2)
    expect(client.warnings).toEqual([
      "VPI API returned 401 for /products/getAllFamiliesAndCategories; refreshing authentication",
    ])

    const twice = harness()
    twice.runtime.applyPreset("unauthorized_twice", "default")
    const failure = await twice.client.getShippingStates().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(VpiApiHttpError)
    expect((failure as VpiApiHttpError).status).toBe(401)
    expect(twice.auths()).toBe(2)
  })

  test("accounts restrict logins; auth_rejected fails authentication", async () => {
    const { admin, client, runtime } = harness()
    await admin(
      "/settings",
      { accounts: [{ email: EMAIL, password: "right", id: "acct-9" }] },
      "PUT",
    )
    await expect(client.authenticate()).rejects.toBeInstanceOf(VpiApiHttpError)
    const ok = new VpiConsumer({ apiUrl: API, email: EMAIL, password: "right" }, (r) =>
      runtime.fetch(r),
    )
    expect(await ok.getAuthenticatedUserId()).toBe("acct-9")

    const rejected = harness()
    rejected.runtime.applyPreset("auth_rejected", "default", { count: 1 })
    await expect(rejected.client.authenticate()).rejects.toThrow("failed with HTTP 401")
  })

  test("response_drift fails closed in our zod parse; server_error makes the status refresh fail closed", async () => {
    const { client, runtime, vpi } = harness()
    runtime.applyPreset("response_drift", "default")
    await expect(client.getAllFamiliesAndCategories()).rejects.toThrow("response validation failed")
    await expect(client.getProductDetailsByProductId(TESTOSTERONE_MAPPING.id)).rejects.toThrow(
      "response validation failed",
    )
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect(await vpi.getOrderStatus({ pharmacyOrderId: "66b2000000000000000000001" })).toBeNull()
    expect(vpi.warnings).toContain("VPI order status refresh failed closed")
  })

  test("every status-list envelope our client accepts resolves the same status", async () => {
    for (const envelope of [
      "vendor",
      "array",
      "prescriptions",
      "message",
      "message.prescriptions",
    ]) {
      const { vpi, admin } = harness()
      const outcome = await vpi.submitDraft(sampleRequest("pay_6001"), TESTOSTERONE_MAPPING)
      const id = outcome.result.pharmacyOrderId as string
      await admin("/settings", { statusEnvelope: envelope }, "PUT")
      expect((await vpi.getOrderStatus({ pharmacyOrderId: id }))?.fulfillmentStatus).toBe(
        "processing",
      )
      await admin(`/prescriptions/${id}/transition`, { to: "Order Cancelled" })
      expect((await vpi.getOrderStatus({ pharmacyOrderId: id }))?.fulfillmentStatus).toBe(
        "cancelled",
      )
    }
  })

  test("the patient roster pages by 100 until hasNextPage is false", async () => {
    const { client, admin } = harness()
    for (let i = 0; i < 120; i++) {
      await admin("/patients", {
        firstName: `P${i}`,
        lastName: "Roster",
        dateOfBirth: "1990-01-01",
        addresses: [],
      })
    }
    const patients = await client.getPatientsInClinic(DEFAULT_CLINIC_ID, DEFAULT_USER_ID)
    expect(patients).toHaveLength(121)
  })

  test("catalog reads parse: taxonomy, products by category, shipping states, day supply, discounts", async () => {
    const { client } = harness()
    const taxonomy = await client.getAllFamiliesAndCategories()
    expect(taxonomy).toContainEqual({
      family: "Hormone Restoration",
      categories: ["Testosterone"],
    })
    const byCategory = await client.getProductsByCategory("Weight Management", "GLP-1")
    expect(byCategory[0]?.commonNames[0]?.products[0]?.productId).toBe("3097_POW")
    const states = await client.getShippingStates()
    expect(states.data[0]?.states.find((s) => s.code === "AZ")?.name).toBe("Arizona")
    expect(
      await client.calculateDaySupply({
        productId: "64f1c2a9e4b0a1b2c3d4e5f8",
        quantity: 60,
        sig: "1 daily",
      }),
    ).toMatchObject({ daySupply: 60 })
    const [discount] = await client.getProductDiscountByProductIds(DEFAULT_CLINIC_ID, [
      TESTOSTERONE_MAPPING.id,
    ])
    expect(discount).toMatchObject({ discountedPercentage: 10, discountedPrice: 40.95 })
  })

  test("namespaces by login email isolate workers; the journal never holds bodies (PHI)", async () => {
    const { runtime } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "a@example.com": "a", "b@example.com": "b" } }),
      }),
    )
    const worker = (email: string) =>
      new VpiFulfillment(
        new VpiConsumer(
          { apiUrl: API, email, password: "x" },
          (r) => runtime.fetch(r),
          () => runtime.clock.now(),
        ),
        { VPI_CLINIC_LOCATION_ID: DEFAULT_CLINIC_LOCATION_ID },
      )
    const placed = await worker("a@example.com").submitDraft(
      sampleRequest("pay_7001"),
      TESTOSTERONE_MAPPING,
    )
    const id = placed.result.pharmacyOrderId as string
    expect(await worker("a@example.com").getOrderStatus({ pharmacyOrderId: id })).not.toBeNull()
    expect(await worker("b@example.com").getOrderStatus({ pharmacyOrderId: id })).toBeNull()
    expect(runtime.instance("a").prescriptions()).toHaveLength(1)
    expect(runtime.instance("b").prescriptions()).toHaveLength(0)
    const journal = (await (
      await runtime.fetch(
        new Request(`${API}/__admin/requests?namespace=a&operationId=SaveNewPrescription`),
      )
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.prescriptionId).toBe(id)
    const all = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).text()
    expect(all).not.toContain("Lovelace")
    expect(all).not.toContain("1985-02-14")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(VPI_PRESETS)).toEqual(
      expect.arrayContaining([
        "token_expired",
        "unauthorized_twice",
        "auth_rejected",
        "server_error",
        "duplicate_prescription",
        "save_ambiguous_409",
        "save_rate_limited",
        "save_400",
        "response_drift",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("our consumer drafts and polls against the node server", async () => {
    const server = await createServer()
    try {
      const client = new VpiConsumer({ apiUrl: server.url, email: EMAIL, password: "s" }, (r) =>
        fetch(r),
      )
      const vpi = new VpiFulfillment(client, { VPI_CLINIC_LOCATION_ID: DEFAULT_CLINIC_LOCATION_ID })
      const outcome = await vpi.submitDraft(sampleRequest("pay_http"), TESTOSTERONE_MAPPING)
      expect(outcome.verdict).toBe("submitted")
      const id = outcome.result.pharmacyOrderId as string
      await fetch(`${server.url}/__admin/prescriptions/${id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Order Completed" }),
      })
      const shipped = await vpi.getOrderStatus({ pharmacyOrderId: id })
      expect(shipped?.fulfillmentStatus).toBe("shipped")
      expect(shipped?.trackingNumber).toMatch(/^1Z/)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^vpi@/)
    } finally {
      await server.close()
    }
  })
})
