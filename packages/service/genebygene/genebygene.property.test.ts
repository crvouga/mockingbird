import { describe, expect, test } from "bun:test"
import { ParityError, type ParityOptions, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  type AddressDto,
  document,
  GeneByGeneAPI,
  placeCheck,
  quoteVerdict,
  supportedOperationIds,
} from "./src/index.js"
import {
  ANCHOR_ZIP,
  COURIER_SERVICES,
  hashDigits,
  menuFor,
  priceFor,
  roundCents,
  stateForZip3,
  trackingNumberFor,
  ZONE_FACTORS,
  zoneFor,
} from "./src/shipping.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.genebygene.local"
const now = () => 1_781_194_684_000

/** A token both instances accept: tokens are self-describing and signed deterministically. */
const token = async () => {
  const response = await new GeneByGeneAPI({ now }).fetch(
    new Request(`https://${MOCK_HOST}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "parity",
        client_secret: "parity",
      }),
    }),
  )
  return ((await response.json()) as { access_token: string }).access_token
}

// Walks never reach the admin-only lifecycle, so the mock-only blob route stays out of scope.
const WALKED = supportedOperationIds.filter((id) => id !== "GetResultBlob")

/**
 * The address classes the address walk must reach, read off the reference's answers: a quote
 * with a menu, a structural quote refusal, a shipped place, a quantity-only place, an address
 * edit, and the place-time `Address Not Found` (the quote-ok / place-fails split).
 */
const ADDRESS_CLASSES = [
  "quote:options",
  "quote:errorMessages",
  "place:shipped",
  "place:quantity-only",
  "place:address-not-found",
  "edit:ok",
] as const

const addressClass = async (request: Request, response: Response): Promise<string | undefined> => {
  const { pathname } = new URL(request.url)
  if (request.method !== "POST") return undefined
  const sent = await request.text().catch(() => "")
  const got = await response.clone().text()
  if (pathname.endsWith("/getShippingOptions") && response.status === 200) {
    const body = JSON.parse(got) as { shippingOptions?: unknown[] }
    return (body.shippingOptions?.length ?? 0) > 0 ? "quote:options" : "quote:errorMessages"
  }
  if (pathname.endsWith("/api/v2/orders")) {
    if (response.status === 200) {
      const items = (JSON.parse(sent) as { items?: { shipments?: unknown[] | null }[] }).items
      return items?.some((i) => (i.shipments?.length ?? 0) > 0)
        ? "place:shipped"
        : "place:quantity-only"
    }
    if (got.includes(": Address Not Found")) return "place:address-not-found"
  }
  if (pathname.endsWith("/updateShipmentAddress") && response.status === 200) return "edit:ok"
  return undefined
}

/** Two fresh instances on the same clock, walked together; the reference's classes counted. */
const selfParity = async (
  options: Partial<ParityOptions> & { create?: () => { fetch: (r: Request) => Promise<Response> } },
) => {
  const auth = { authorization: `Bearer ${await token()}` }
  const reference = new GeneByGeneAPI({ now })
  const classes = new Map<string, number>()
  const { create, ...rest } = options
  const report = await parity({
    provider: "genebygene",
    spec: document,
    real: {
      baseUrl: `https://${MOCK_HOST}`,
      allowedHosts: [MOCK_HOST],
      headers: () => auth,
      fetch: async (request) => {
        const response = await reference.fetch(request.clone())
        const seen = await addressClass(request, response)
        if (seen) classes.set(seen, (classes.get(seen) ?? 0) + 1)
        return response
      },
    },
    mock: {
      create: create ?? (() => new GeneByGeneAPI({ now })),
      baseUrl: `https://${MOCK_HOST}`,
      headers: () => auth,
    },
    cleanup: async () => {
      await reference.reset()
    },
    includeUnsafe: true,
    // Both sides are this same in-process mock: only a GC or scheduler pause can make one slower,
    // and a spurious latency failure then shrinks a 2000-walk property for many minutes.
    latencyToleranceMs: 10_000,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    env: process.env,
    sleep: async () => {},
    log: () => {},
    ...rest,
  })
  return { report, classes }
}

/** The operations the address walk concentrates on (quote, place, edit, and what they need). */
const ADDRESS_WALK = ["ListProducts", "GetShippingOptions", "CreateOrder", "UpdateShipmentAddress"]

describe("GeneByGeneAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const { report } = await selfParity({
        numRuns: Math.max(params.numRuns ?? 250, 250),
        maxCommands: 30,
        coverageBias: 4,
        weights: {
          CreateOrder: 6,
          CreateOrderForExistingKits: 2,
          CancelOrderLine: 4,
          CancelFulfillment: 3,
          CancelKitOrderLines: 3,
          GetKitResults: 2,
          SetKitAttributes: 2,
          UpdateShipmentAddress: 2,
        },
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every parity-enabled operation, including order placement and all three cancel layers.
      expect(Object.keys(report.exercised).sort()).toEqual([...WALKED].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "self-parity: the address walk reaches every quote / place / edit class, prices included",
    async () => {
      const { report, classes } = await selfParity({
        only: ADDRESS_WALK,
        // Walks are short (a place needs a product from ListProducts first, an edit a shipment
        // from a shipped place), so this walk runs many of them: ~15 shipped places and ~15
        // successful edits per 2000 walks.
        numRuns: Math.max(params.numRuns ?? 2000, 2000),
        maxCommands: 30,
        weights: {
          ListProducts: 6,
          GetShippingOptions: 3,
          CreateOrder: 10,
          UpdateShipmentAddress: 10,
        },
        // Mostly well-formed bodies: the classes live behind model binding.
        invalidProbability: 0.02,
        missingProbability: 0.02,
      })
      expect(Object.keys(report.exercised).sort()).toEqual([...ADDRESS_WALK].sort())
      // Quote with a menu, shipped and quantity-only place, address edit, and Address Not Found.
      expect([...classes.keys()].sort()).toEqual([...ADDRESS_CLASSES].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const faulty = () => {
            const api = new GeneByGeneAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/attributes")) return response
                const body = (await response.json()) as { name: string }[]
                if (body[0]) body[0] = { ...body[0], name: "diverged" }
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await selfParity({
            create: faulty,
            only: ["ListAttributeDefinitions"],
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            missingProbability: 0,
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )

  test(
    "a runtime that flattens every quote to estimatedPrice 1 is caught",
    async () => {
      // Prices are deterministic in the mock (zone table), so self-parity compares them.
      const flat = () => {
        const api = new GeneByGeneAPI({ now })
        return {
          fetch: async (request: Request) => {
            const response = await api.fetch(request)
            if (!new URL(request.url).pathname.endsWith("/getShippingOptions")) return response
            if (response.status !== 200) return response
            const body = (await response.json()) as {
              shippingOptions: { estimatedPrice: number }[]
            }
            for (const option of body.shippingOptions) option.estimatedPrice = 1
            return Response.json(body, { status: 200 })
          },
        }
      }
      const failure = await selfParity({
        create: flat,
        only: ["ListProducts", "GetShippingOptions"],
        numRuns: 200,
        maxCommands: 30,
        weights: { GetShippingOptions: 8 },
        invalidProbability: 0,
        missingProbability: 0,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ParityError)
      expect(String((failure as Error).message)).toContain("estimatedPrice")
    },
    { timeout: 60_000 },
  )
})

// --- the zone table and the two address checks, as properties ----------------------------------

const zip5 = fc.integer({ min: 0, max: 99_999 }).map((n) => String(n).padStart(5, "0"))

/** A structurally valid US address in a mapped state (quote passes structure). */
const validAddress = fc
  .record({
    zip: zip5.filter((z) => {
      const state = stateForZip3(z.slice(0, 3))
      return (
        state !== undefined &&
        !["AA", "AE", "AP"].includes(state) &&
        zoneFor(z.slice(0, 3)) !== undefined
      )
    }),
    number: fc.integer({ min: 1, max: 99_999 }),
    commercial: fc.boolean(),
  })
  .map(
    ({ zip, number, commercial }): AddressDto => ({
      isCommercial: commercial,
      recipientName: "Mockingbird Test",
      addressLine1: `${number} Main St`,
      addressLine2: null,
      city: "Springfield",
      stateOrRegion: stateForZip3(zip.slice(0, 3)) as string,
      postalCode: zip,
      countryCode: "US",
      email: null,
      phone: "+15555550100",
    }),
  )

describe("shipping model", () => {
  test("every zone's prices scale the zone-6 anchor, rounded to cents; zone 8 drops Express Saver", () => {
    fc.assert(
      fc.property(zip5, fc.boolean(), (zip, residential) => {
        const zone = zoneFor(zip.slice(0, 3))
        if (zone === undefined) return
        const menu = menuFor(zone)
        expect(menu.length).toBe(zone === 8 ? 3 : 4)
        for (const service of menu) {
          const price = priceFor(service, zone, { residential, zip5: zip })
          const base = roundCents(service.anchorPrice * (ZONE_FACTORS[zone] as number))
          const surcharge =
            residential &&
            service.courierServiceCode === "DHL_PARCEL_EXPEDITED" &&
            zip !== ANCHOR_ZIP
          expect(price).toBe(surcharge ? roundCents(base + 0.5) : base)
          expect(Math.round(price * 100)).toBeCloseTo(price * 100, 6)
        }
      }),
      params,
    )
  })

  test("zone 6 is the recorded anchor: 6, 62.23, 14.91, 14.91 for 73938 (staging's menu order)", () => {
    expect(zoneFor("739")).toBe(6)
    expect(
      COURIER_SERVICES.map((s) => priceFor(s, 6, { residential: true, zip5: "73938" })),
    ).toEqual([6, 62.23, 14.91, 14.91])
  })

  test("a structurally valid address always quotes; place never reports a structural problem for it", () => {
    fc.assert(
      fc.property(validAddress, (address) => {
        expect(quoteVerdict(address).kind).toBe("ok")
        const place = placeCheck(address)
        expect(place.ok || (!place.ok && place.kind === "address-not-found")).toBe(true)
      }),
      params,
    )
  })

  // Staging: the quote is already the carrier's 500 (90210 in "TX", corpus/address-parity.json).
  test("a state that disagrees with the ZIP3 table is the carrier's 500 at quote, Address Not Found at place", () => {
    fc.assert(
      fc.property(validAddress, fc.constantFrom("TX", "CA", "NY", "MT", "HI"), (address, state) => {
        fc.pre(state !== address.stateOrRegion)
        // Territories quote DHL only, and the carrier's ZIP check is FedEx's.
        fc.pre(!["PR", "VI", "GU"].includes(address.stateOrRegion as string))
        const moved = { ...address, stateOrRegion: state }
        expect(quoteVerdict(moved).kind).toBe("carrier")
        expect(placeCheck(moved)).toMatchObject({ ok: false, kind: "address-not-found" })
      }),
      params,
    )
  })

  test("line length is UTF-16 code units: 35 passes, 36 is refused, on every line", () => {
    fc.assert(
      fc.property(
        validAddress,
        fc.constantFrom("addressLine1", "addressLine2", "addressLine3") as fc.Arbitrary<
          "addressLine1" | "addressLine2" | "addressLine3"
        >,
        fc.integer({ min: 30, max: 40 }),
        fc.constantFrom("a", "é", "😀"),
        (address, line, length, unit) => {
          // An emoji is two code units, as String#length in the caller counts it.
          const text = `${unit.repeat(Math.floor(length / unit.length))}${"a".repeat(length % unit.length)}`
          expect(text.length).toBe(length)
          const verdict = quoteVerdict({ ...address, [line]: text })
          expect(verdict).toEqual(
            length > 35
              ? {
                  kind: "errorMessages",
                  errorMessages: ["Address Lines cannot be longer than 35 characters."],
                }
              : expect.objectContaining({ kind: "ok" }),
          )
        },
      ),
      params,
    )
  })

  // The PO Box pattern once backtracked cubically on runs of spaces (6 s for one 6 KB line),
  // which the random walks generate.
  test("a quote stays fast on long runs of spaces in any address line", () => {
    fc.assert(
      fc.property(
        validAddress,
        fc.integer({ min: 1_000, max: 5_000 }),
        fc.constantFrom("p", "p o", "p. o.", "po box"),
        (address, spaces, head) => {
          const line = `${head}${" ".repeat(spaces)}o${" ".repeat(spaces)}x`
          const started = performance.now()
          quoteVerdict({ ...address, addressLine1: line, addressLine2: line })
          expect(performance.now() - started).toBeLessThan(50)
        },
      ),
      { ...params, numRuns: 20 },
    )
  })

  test("tracking numbers are a pure function of the shipment id: DHL 420+ZIP5+26, FedEx 12", () => {
    fc.assert(
      fc.property(fc.uuid(), zip5, fc.boolean(), fc.boolean(), (id, zip, isReturn, fedex) => {
        const input = {
          shipmentId: id,
          isReturnShipment: isReturn,
          courierServiceCode: fedex ? "FEDEX_2_DAY_ONE_RATE" : "DHL_PARCEL_EXPEDITED",
          postalCode: zip,
        }
        const number = trackingNumberFor(input)
        expect(trackingNumberFor(input)).toBe(number)
        if (fedex && !isReturn) expect(number).toMatch(/^\d{12}$/)
        else expect(number).toBe(`420${isReturn ? "77008" : zip}${hashDigits(`dhl:${id}`, 26)}`)
      }),
      params,
    )
  })
})
