import { describe, expect, test } from "bun:test"
import { createRuntime, GOOGLE_MAPS_PRESETS, INVALID_API_KEY_MESSAGE } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  evaluateAddressValidation,
  type Fetch,
  type ShipToAddress,
  validateShipTo,
  validationRequestBody,
} from "./test/consumer.js"

/** Where a checkout would point `addressvalidation.googleapis.com`. */
const BASE = "http://address-validation.mock"
const KEY = "places-key-dev"

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
type Json = Record<string, any>

const harness = () => {
  const runtime = createRuntime()
  const send: Fetch = (request) => runtime.fetch(request)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${BASE}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const post = async (body: unknown, query = `?key=${KEY}`, prefix = "") => {
    const response = await runtime.fetch(
      new Request(`${BASE}${prefix}/v1:validateAddress${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as Json }
  }
  const validate = async (address: ShipToAddress) => post(validationRequestBody(address))
  return { runtime, send, admin, post, validate }
}

const PHOENIX: ShipToAddress = {
  line1: "1625 N Central Ave",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
}

/** An admin-seeded apartment building (fictional street) with two known units. */
const APARTMENTS = {
  id: "az-phoenix-apartments",
  line1: "77 W Example Ln",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  validation: { multiUnit: true, units: ["1", "2"] },
}

describe("Address Validation (POST /v1:validateAddress) with USPS CASS", () => {
  test("B1: a corpus row is accepted with a deterministic ZIP+4 and DPV Y", async () => {
    const { validate, send } = harness()
    const { status, body } = await validate(PHOENIX)
    expect(status).toBe(200)
    const { verdict, address, uspsData, geocode } = body.result
    expect(verdict).toEqual({
      inputGranularity: "PREMISE",
      validationGranularity: "PREMISE",
      geocodeGranularity: "PREMISE",
      addressComplete: true,
      hasInferredComponents: true,
      possibleNextAction: "ACCEPT",
    })
    expect(address.formattedAddress).toMatch(/^1625 N Central Ave, Phoenix, AZ 85004-\d{4}, USA$/)
    expect(address.postalAddress).toEqual({
      regionCode: "US",
      languageCode: "en",
      postalCode: expect.stringMatching(/^85004-\d{4}$/),
      administrativeArea: "AZ",
      locality: "Phoenix",
      addressLines: ["1625 N Central Ave"],
    })
    // proto3 JSON: an empty list is omitted, not sent as [].
    expect(address.unconfirmedComponentTypes).toBeUndefined()
    expect(address.missingComponentTypes).toBeUndefined()
    expect(uspsData.dpvConfirmation).toBe("Y")
    expect(uspsData.cassProcessed).toBe(true)
    expect(uspsData.standardizedAddress).toEqual({
      firstAddressLine: "1625 N CENTRAL AVE",
      cityStateZipAddressLine: expect.stringMatching(/^PHOENIX AZ 85004-\d{4}$/),
      city: "PHOENIX",
      state: "AZ",
      zipCode: "85004",
      zipCodeExtension: expect.stringMatching(/^\d{4}$/),
    })
    expect(geocode.placeId).toMatch(/^ChIJ/)
    expect(typeof body.responseId).toBe("string")
    // Deterministic across instances.
    const again = await harness().validate(PHOENIX)
    expect(again.body.result.address.formattedAddress).toBe(address.formattedAddress)
    // The checkout accepts it, uncorrected apart from the ZIP+4.
    const outcome = await validateShipTo(send, BASE, KEY, PHOENIX)
    expect(outcome).toMatchObject({ kind: "accept", formattedAddress: address.formattedAddress })
  })

  test("B2: a long line 1 with spelled-out words and a building is accepted", async () => {
    const { validate, send } = harness()
    const input = { ...PHOENIX, line1: "1625 North Central Avenue Building A" }
    const { body } = await validate(input)
    expect(body.result.verdict.validationGranularity).toBe("PREMISE")
    expect(body.result.uspsData.dpvConfirmation).toBe("Y")
    expect(body.result.address.postalAddress.addressLines).toEqual(["1625 N Central Ave Bldg A"])
    expect(body.result.address.unconfirmedComponentTypes).toEqual(["subpremise"])
    expect((await validateShipTo(send, BASE, KEY, input)).kind).toBe("accept")
  })

  test("B3: a street synthesized in a corpus city is a premise; a city outside the corpus is FIX / N", async () => {
    const { validate, send } = harness()
    const synth = { line1: "4821 Maple Street", city: "Denver", state: "CO", zip: "80202" }
    const { body } = await validate(synth)
    expect(body.result.verdict).toMatchObject({
      validationGranularity: "PREMISE",
      addressComplete: true,
      possibleNextAction: "ACCEPT",
    })
    expect(body.result.address.postalAddress.addressLines).toEqual(["4821 Maple St"])
    expect(body.result.uspsData.dpvConfirmation).toBe("Y")
    expect((await validateShipTo(send, BASE, KEY, synth)).kind).toBe("accept")

    const nowhere = { line1: "12 Nowhere Rd", city: "Examplefield", state: "OR", zip: "97999" }
    const miss = await validate(nowhere)
    expect(miss.status).toBe(200)
    expect(miss.body.result.verdict).toEqual({
      inputGranularity: "PREMISE",
      validationGranularity: "OTHER",
      geocodeGranularity: "OTHER",
      hasUnconfirmedComponents: true,
      possibleNextAction: "FIX",
    })
    expect(miss.body.result.address.unconfirmedComponentTypes).toEqual(
      expect.arrayContaining(["street_number", "route", "locality", "postal_code"]),
    )
    expect(miss.body.result.uspsData.dpvConfirmation).toBe("N")
    expect(miss.body.result.uspsData.standardizedAddress).toBeUndefined()
    expect(await validateShipTo(send, BASE, KEY, nowhere)).toMatchObject({ kind: "reject" })
  })

  test("B4: a missing premise number is ROUTE with street_number missing", async () => {
    const { validate, send } = harness()
    const input = { ...PHOENIX, line1: "N Central Ave" }
    const { body } = await validate(input)
    expect(body.result.verdict).toMatchObject({
      validationGranularity: "ROUTE",
      possibleNextAction: "FIX",
    })
    expect(body.result.verdict.addressComplete).toBeUndefined()
    expect(body.result.address.missingComponentTypes).toEqual(["street_number"])
    expect(body.result.uspsData.dpvConfirmation).toBeUndefined()
    expect(await validateShipTo(send, BASE, KEY, input)).toMatchObject({ kind: "reject" })
  })

  test("B5: a multi-unit building without a unit is CONFIRM_ADD_SUBPREMISES / D", async () => {
    const { validate, send, admin } = harness()
    expect((await admin("/corpus", { addresses: [APARTMENTS] }, "PUT")).status).toBe(200)
    const input = { line1: APARTMENTS.line1, city: "Phoenix", state: "AZ", zip: "85004" }
    const { body } = await validate(input)
    expect(body.result.verdict).toMatchObject({
      validationGranularity: "PREMISE",
      possibleNextAction: "CONFIRM_ADD_SUBPREMISES",
    })
    expect(body.result.verdict.addressComplete).toBeUndefined()
    expect(body.result.address.missingComponentTypes).toEqual(["subpremise"])
    expect(body.result.uspsData.dpvConfirmation).toBe("D")
    expect(await validateShipTo(send, BASE, KEY, input)).toMatchObject({ kind: "reject" })
  })

  test("B6: an unknown unit is CONFIRM / S (accepted); a known one is SUB_PREMISE / Y", async () => {
    const { validate, send, admin } = harness()
    await admin("/corpus", { addresses: [APARTMENTS] }, "PUT")
    const unknown = {
      line1: APARTMENTS.line1,
      line2: "Apt 9999",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
    }
    const { body } = await validate(unknown)
    expect(body.result.verdict).toMatchObject({
      validationGranularity: "PREMISE",
      addressComplete: true,
      hasUnconfirmedComponents: true,
      possibleNextAction: "CONFIRM",
    })
    expect(body.result.address.unconfirmedComponentTypes).toEqual(["subpremise"])
    expect(body.result.uspsData.dpvConfirmation).toBe("S")
    expect((await validateShipTo(send, BASE, KEY, unknown)).kind).toBe("accept")

    const known = { ...unknown, line2: "Apt 2" }
    const ok = await validate(known)
    expect(ok.body.result.verdict).toMatchObject({
      validationGranularity: "SUB_PREMISE",
      geocodeGranularity: "PREMISE",
      possibleNextAction: "ACCEPT",
    })
    expect(ok.body.result.address.postalAddress.addressLines).toEqual(["77 W Example Ln Apt 2"])
    expect(ok.body.result.uspsData.dpvConfirmation).toBe("Y")
  })

  test("B7: a wrong ZIP for the city is replaced (CONFIRM), and the corrected ZIP is suggested", async () => {
    const { validate, send } = harness()
    const input = { ...PHOENIX, zip: "85099" }
    const { body } = await validate(input)
    expect(body.result.verdict).toMatchObject({
      hasReplacedComponents: true,
      possibleNextAction: "CONFIRM",
      validationGranularity: "PREMISE",
      addressComplete: true,
    })
    const postal = body.result.address.addressComponents.find(
      (c: Json) => c.componentType === "postal_code",
    )
    expect(postal).toMatchObject({ componentName: { text: "85004" }, replaced: true })
    // Google's replaced component is its confirmed correction, not an unconfirmed one.
    expect(body.result.address.unconfirmedComponentTypes).toBeUndefined()
    expect(body.result.address.postalAddress.postalCode).toMatch(/^85004-\d{4}$/)
    const outcome = await validateShipTo(send, BASE, KEY, input)
    expect(outcome).toMatchObject({ kind: "accept", corrected: true })
    if (outcome.kind === "accept") expect(outcome.suggestion?.zip).toMatch(/^85004-/)
  })

  test("B8: an admin row with a USPS error answers uspsData.errorMessage and no DPV code", async () => {
    const { validate, send, admin } = harness()
    const row = {
      id: "az-usps-error",
      line1: "9 Example Ct",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
      validation: { uspsErrorMessage: "Address Not Found" },
    }
    await admin("/corpus", { addresses: [row] }, "PUT")
    const input = { line1: row.line1, city: "Phoenix", state: "AZ", zip: "85004" }
    const { body } = await validate(input)
    expect(body.result.uspsData).toEqual({ errorMessage: "Address Not Found", cassProcessed: true })
    expect(await validateShipTo(send, BASE, KEY, input)).toEqual({
      kind: "reject",
      reason: "USPS rejected this address: Address Not Found",
    })
    // Overrides pin the rest of the verdict too; bad values are refused.
    await admin(
      "/corpus",
      { addresses: [{ ...row, validation: { granularity: "BLOCK", dpvConfirmation: "N" } }] },
      "PUT",
    )
    const pinned = await validate(input)
    expect(pinned.body.result.verdict.validationGranularity).toBe("BLOCK")
    expect(pinned.body.result.uspsData.dpvConfirmation).toBe("N")
    for (const validation of [{ granularity: "HOUSE" }, { multiUnit: "yes" }, { units: [1] }]) {
      expect((await admin("/corpus", { addresses: [{ ...row, validation }] }, "PUT")).status).toBe(
        400,
      )
    }
  })

  test("B9: malformed requests are 400 INVALID_ARGUMENT in Google's envelope", async () => {
    const { post } = harness()
    const invalid = { code: 400, status: "INVALID_ARGUMENT", message: expect.any(String) }
    for (const body of [
      {},
      { enableUspsCass: true },
      { address: { regionCode: "US", addressLines: [] } },
      { address: { regionCode: "US", addressLines: ["  "] } },
      { address: { regionCode: "US", addressLines: "1625 N Central Ave" } },
      { address: { regionCode: "US", addressLines: ["1 A St"], street: "x" } },
      { address: { regionCode: "US", addressLines: ["1 A St"] }, bogus: true },
      { address: { regionCode: "CA", addressLines: ["1 A St"] }, enableUspsCass: true },
      "{not json",
    ]) {
      const { status, body: response } = await post(body)
      expect(status).toBe(400)
      expect(response).toEqual({ error: invalid })
    }
  })

  test("B10: a missing key is 403 PERMISSION_DENIED; a key outside settings.keys is refused", async () => {
    const { post, admin, send } = harness()
    const body = validationRequestBody(PHOENIX)
    expect(await post(body, "")).toEqual({
      status: 403,
      body: {
        error: {
          code: 403,
          message: "The request is missing a valid API key.",
          status: "PERMISSION_DENIED",
        },
      },
    })
    await admin("/settings", { keys: [KEY] }, "PUT")
    const refused = await post(body, "?key=wrong-key")
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatchObject({
      code: 400,
      message: INVALID_API_KEY_MESSAGE,
      status: "INVALID_ARGUMENT",
      details: [expect.objectContaining({ reason: "API_KEY_INVALID" })],
    })
    // The checkout fails open on both.
    expect((await validateShipTo(send, BASE, undefined, PHOENIX)).kind).toBe("unavailable")
    expect((await validateShipTo(send, BASE, "wrong-key", PHOENIX)).kind).toBe("unavailable")
    expect((await validateShipTo(send, BASE, KEY, PHOENIX)).kind).toBe("accept")
    // Google Cloud APIs also take the key as a header.
    const { runtime } = harness()
    const viaHeader = await runtime.fetch(
      new Request(`${BASE}/v1:validateAddress`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(body),
      }),
    )
    expect(viaHeader.status).toBe(200)
  })

  test("B11: /ns/<name> and key → namespace credentials route to that namespace's corpus and faults", async () => {
    const { admin, post, send } = harness()
    await admin("/credentials", { credentials: { "key-worker-a": "a" } }, "PUT")
    await admin("/corpus?namespace=a", { addresses: [APARTMENTS] }, "PUT")
    const input = { line1: APARTMENTS.line1, city: "Phoenix", state: "AZ", zip: "85004" }
    // Namespace a knows the building (D: missing unit); the default namespace synthesizes it (Y).
    const byKey = await validateShipTo(send, BASE, "key-worker-a", input)
    expect(byKey).toMatchObject({ kind: "reject" })
    const byPrefix = await post(validationRequestBody(input), `?key=${KEY}`, "/ns/a")
    expect(byPrefix.body.result.uspsData.dpvConfirmation).toBe("D")
    const elsewhere = await validateShipTo(send, BASE, "key-worker-b", input)
    expect(elsewhere.kind).toBe("accept")
    // A fault added in namespace a stays there.
    await admin(
      "/faults?namespace=a",
      { preset: "address_validation_unavailable", count: 1 },
      "POST",
    )
    expect((await validateShipTo(send, BASE, "key-worker-b", PHOENIX)).kind).toBe("accept")
    expect(await validateShipTo(send, BASE, "key-worker-a", PHOENIX)).toEqual({
      kind: "unavailable",
      reason: "Google Address Validation HTTP 503",
    })
  })

  test("B12: the journal records ValidateAddress, the row and the verdict class, never the address", async () => {
    const { runtime, validate, admin } = harness()
    await validate(PHOENIX)
    await validate({ line1: "12 Nowhere Rd", city: "Examplefield", state: "OR", zip: "97999" })
    const journal = (await (
      await runtime.fetch(new Request(`${BASE}/__admin/requests?operationId=ValidateAddress`))
    ).json()) as {
      requests: { operationId: string; status: number; ids?: Record<string, string> }[]
    }
    expect(journal.requests.map((r) => [r.operationId, r.status, r.ids])).toEqual([
      ["ValidateAddress", 200, { addressRowId: "az-phoenix", verdict: "ACCEPT/Y" }],
      ["ValidateAddress", 200, { verdict: "FIX/N" }],
    ])
    const text = JSON.stringify(journal)
    for (const piece of ["Central", "Nowhere", "Examplefield", "85004"]) {
      expect(text).not.toContain(piece)
    }
    // Metrics count the operation on its own.
    const metrics = (await (await admin("/metrics")).json()) as {
      byOperation: Record<string, number>
    }
    expect(metrics.byOperation["ValidateAddress 200"]).toBe(2)
  })

  test("fault presets: denied, unavailable, slow, no verdict, DPV N", async () => {
    const { runtime, admin, send } = harness()
    const listed = (await (await admin("/faults/presets")).json()) as Json
    const names = JSON.stringify(listed)
    for (const name of [
      "address_validation_denied",
      "address_validation_unavailable",
      "address_validation_slow",
      "address_validation_no_verdict",
      "address_validation_dpv_n",
    ]) {
      expect(GOOGLE_MAPS_PRESETS[name]).toBeDefined()
      expect(names).toContain(name)
    }

    runtime.applyPreset("address_validation_denied", "default", { count: 1 })
    expect(await validateShipTo(send, BASE, KEY, PHOENIX)).toEqual({
      kind: "unavailable",
      reason: "Google Address Validation HTTP 403",
    })
    runtime.applyPreset("address_validation_unavailable", "default", { count: 1 })
    expect(await validateShipTo(send, BASE, KEY, PHOENIX)).toEqual({
      kind: "unavailable",
      reason: "Google Address Validation HTTP 503",
    })
    runtime.applyPreset("address_validation_no_verdict", "default", { count: 1 })
    expect(await validateShipTo(send, BASE, KEY, PHOENIX)).toEqual({
      kind: "unavailable",
      reason: "no verdict",
    })
    runtime.applyPreset("address_validation_dpv_n", "default", { count: 1 })
    expect(await validateShipTo(send, BASE, KEY, PHOENIX)).toEqual({
      kind: "reject",
      reason: "DPV N",
    })
    // Each fault was single-use: the next call is the plain answer.
    expect((await validateShipTo(send, BASE, KEY, PHOENIX)).kind).toBe("accept")
    // Other operations are untouched by these presets.
    runtime.applyPreset("address_validation_unavailable", "default", { count: 1 })
    const geocode = await runtime.fetch(
      new Request(`${BASE}/maps/api/geocode/json?address=85004&key=${KEY}`),
    )
    expect(((await geocode.json()) as Json).status).toBe("OK")
    expect((await validateShipTo(send, BASE, KEY, PHOENIX)).kind).toBe("unavailable")

    runtime.applyPreset("address_validation_slow", "default", { count: 1 })
    const started = performance.now()
    const controller = AbortSignal.timeout(2_500)
    const slow = await Promise.race([
      validateShipTo(send, BASE, KEY, PHOENIX),
      new Promise<"timeout">((resolve) =>
        controller.addEventListener("abort", () => resolve("timeout")),
      ),
    ])
    expect(slow).toBe("timeout")
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_400)
  }, 10_000)

  test("the evaluation port reads each branch as documented", () => {
    const input = PHOENIX
    expect(evaluateAddressValidation(200, "<html>", input).kind).toBe("unavailable")
    expect(
      evaluateAddressValidation(200, JSON.stringify({ error: { status: "REQUEST_DENIED" } }), input)
        .kind,
    ).toBe("unavailable")
    const accept = (usps: Json | undefined) =>
      evaluateAddressValidation(
        200,
        JSON.stringify({
          result: {
            verdict: {
              validationGranularity: "PREMISE",
              addressComplete: true,
              possibleNextAction: "ACCEPT",
            },
            ...(usps ? { uspsData: usps } : {}),
          },
        }),
        input,
      ).kind
    expect(accept(undefined)).toBe("accept")
    expect(accept({})).toBe("accept")
    expect(accept({ dpvConfirmation: "S" })).toBe("accept")
    expect(accept({ dpvConfirmation: "D" })).toBe("reject")
  })
})

describe("Address Validation served over HTTP", () => {
  test("one server answers both the Maps paths and /v1:validateAddress", async () => {
    const server = await createServer()
    try {
      const outcome = await validateShipTo((r) => fetch(r), server.url, KEY, PHOENIX)
      expect(outcome.kind).toBe("accept")
      const geocode = await fetch(`${server.url}/maps/api/geocode/json?address=85004&key=${KEY}`)
      expect(((await geocode.json()) as Json).status).toBe("OK")
    } finally {
      await server.close()
    }
  })
})
