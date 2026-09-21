import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  createRuntime,
  DEFAULT_CORPUS,
  GOOGLE_MAPS_PRESETS,
  INVALID_KEY_MESSAGE,
  PHOENIX_DEMO_ADDRESS,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type Fetch,
  fakeWindow,
  findPlaceWithHttp,
  formatBloodworkAddress,
  geocodeOnNative,
  geocodeOnWeb,
  geocodeWithHttp,
  loadGoogleMapsScript,
  NativeAddressAutocomplete,
  WebAddressAutocomplete,
} from "./test/consumer.js"

const params = fcParameters(process.env)
/** Where the app would point `maps.googleapis.com` once seam G-Y1 lands. */
const BASE = "http://maps.mock"
const KEY = "places-key-dev"

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
  return { runtime, send, admin, native: new NativeAddressAutocomplete(BASE, KEY, send) }
}

/** Faker-style street names QA's fuzzed line1 draws from (none ends in a corpus city). */
const STREETS = [
  "Maple Street",
  "Kuhn Village",
  "Oak Avenue",
  "Cedar Ln",
  "Schroeder Mews",
  "Birch Road",
  "Willow Way",
  "Ferry Crossroad",
  "Lakeview Dr",
  "Harbor Blvd",
]

describe("S21 acceptance: our member app's address flows against the mock", () => {
  test("the Phoenix AZ demo member resolves through autocomplete → details", async () => {
    const { native } = harness()
    const predictions = await native.fetchPredictions("1625 N Central")
    expect(predictions[0]).toEqual({
      placeId: expect.stringMatching(/^ChIJ/),
      mainText: "1625 N Central Ave",
      secondaryText: "Phoenix, AZ, USA",
    })
    const parsed = await native.selectPrediction(predictions[0] as (typeof predictions)[0])
    expect(parsed).toEqual({
      line1: "1625 N Central Ave",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
    })
    expect(native.consecutiveFailures).toBe(0)
  })

  test("every corpus row round-trips autocomplete → details → parseAddressComponents", async () => {
    const { native } = harness()
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...DEFAULT_CORPUS), async (row) => {
        const [first] = await native.fetchPredictions(`${row.line1} ${row.city}`)
        expect(first?.mainText).toBe(row.line1)
        const parsed = await native.selectPrediction(first as NonNullable<typeof first>)
        expect(parsed).toEqual({ line1: row.line1, city: row.city, state: row.state, zip: row.zip })
      }),
      { ...params, numRuns: params.numRuns ?? DEFAULT_CORPUS.length * 2 },
    )
    for (const row of DEFAULT_CORPUS) {
      const [first] = await native.fetchPredictions(`${row.line1} ${row.city}`)
      expect(first?.mainText).toBe(row.line1)
    }
  })

  test("QA's fuzzed search (`<n> <street> <corpus city>`) resolves to that street in the row's city/state/ZIP", async () => {
    const { native } = harness()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...DEFAULT_CORPUS),
        fc.integer({ min: 100, max: 9999 }),
        fc.constantFrom(...STREETS),
        async (row, number, street) => {
          const line1 = `${number} ${street}`
          const predictions = await native.fetchPredictions(`${line1} ${row.city}`)
          const first = predictions[0]
          expect(first?.mainText).toBe(line1)
          const parsed = await native.selectPrediction(first as NonNullable<typeof first>)
          const expectedRow = DEFAULT_CORPUS.find((r) => r.city === row.city) ?? row
          expect(parsed).toEqual({
            line1,
            city: row.city,
            state: expectedRow.state,
            zip: expectedRow.zip,
          })
        },
      ),
      { ...params, numRuns: params.numRuns ?? 100 },
    )
  })

  test("an unknown address is ZERO_RESULTS, which our client counts as a success (no manual entry)", async () => {
    const { native } = harness()
    expect(await native.fetchPredictions("zzqx nowhere lane")).toEqual([])
    expect(await native.fetchPredictions("qqqq")).toEqual([])
    expect(native.consecutiveFailures).toBe(0)
    expect(native.apiUnavailable).toBe(false)
  })

  test("geocoding the formatted bloodwork address gives the row's coordinates (native)", async () => {
    const { send } = harness()
    const address = formatBloodworkAddress(PHOENIX_DEMO_ADDRESS)
    expect(address).toBe("1625 N Central Ave, Phoenix, AZ 85004")
    expect(await geocodeWithHttp(send, BASE, address, KEY)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    expect(await findPlaceWithHttp(send, BASE, address, KEY)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    // Every corpus row geocodes to itself.
    for (const row of DEFAULT_CORPUS) {
      expect(await geocodeOnNative(send, BASE, formatBloodworkAddress(row), KEY)).toEqual({
        lat: row.lat,
        lng: row.lng,
      })
    }
  })

  test("geocode ZERO_RESULTS falls back to Find Place From Text", async () => {
    const { runtime, send } = harness()
    // A street with no city: the Geocoding API cannot place it, Find Place's looser match can.
    expect(await geocodeWithHttp(send, BASE, "1625 N Central", KEY)).toBeNull()
    expect(await geocodeOnNative(send, BASE, "1625 N Central", KEY)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    runtime.applyPreset("geocode_zero_results", "default", { count: 1 })
    const address = formatBloodworkAddress(PHOENIX_DEMO_ADDRESS)
    expect(await geocodeOnNative(send, BASE, address, KEY)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    runtime.applyPreset("zero_results", "default", { count: 2 })
    expect(await geocodeOnNative(send, BASE, address, KEY)).toBeNull()
  })

  test("two consecutive failures switch the sheet to manual entry; a success in between resets", async () => {
    const { runtime, native } = harness()
    runtime.applyPreset("autocomplete_over_query_limit", "default", { count: 2 })
    await native.fetchPredictions("1625 N Central")
    expect(native.consecutiveFailures).toBe(1)
    expect(native.apiUnavailable).toBe(false)
    await native.fetchPredictions("1625 N Central")
    expect(native.apiUnavailable).toBe(true)
    // "Back to search", and the mock recovers.
    native.resetDegradedState()
    expect(await native.fetchPredictions("1625 N Central")).toHaveLength(1)

    const fresh = harness()
    fresh.runtime.applyPreset("unknown_error", "default", { count: 1 })
    await fresh.native.fetchPredictions("Phoenix")
    await fresh.native.fetchPredictions("Phoenix")
    fresh.runtime.applyPreset("server_error", "default", { count: 1 })
    await fresh.native.fetchPredictions("Phoenix")
    expect(fresh.native.consecutiveFailures).toBe(1)
    expect(fresh.native.apiUnavailable).toBe(false)
  })

  test("a failed details lookup counts too (OVER_QUERY_LIMIT on details, HTTP 500)", async () => {
    const { runtime, native } = harness()
    const [prediction] = await native.fetchPredictions("88 Greenwich")
    runtime.applyPreset("over_query_limit", "default", { count: 1 })
    expect(await native.selectPrediction(prediction as NonNullable<typeof prediction>)).toBeNull()
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect(await native.selectPrediction(prediction as NonNullable<typeof prediction>)).toBeNull()
    expect(native.apiUnavailable).toBe(true)
  })

  test("REQUEST_DENIED for a missing or refused key", async () => {
    const { runtime, admin, send } = harness()
    await admin("/settings", { keys: [KEY] }, "PUT")
    const denied = new NativeAddressAutocomplete(BASE, "wrong-key", send)
    await denied.fetchPredictions("Phoenix")
    expect(denied.consecutiveFailures).toBe(1)
    const body = (await (
      await runtime.fetch(new Request(`${BASE}/maps/api/geocode/json?address=85004&key=wrong-key`))
    ).json()) as { status: string; error_message: string; results: unknown[] }
    expect(body).toEqual({
      results: [],
      error_message: INVALID_KEY_MESSAGE,
      status: "REQUEST_DENIED",
    })
    const missing = (await (
      await runtime.fetch(new Request(`${BASE}/maps/api/place/autocomplete/json?input=Phoenix`))
    ).json()) as { status: string; error_message: string }
    expect(missing.status).toBe("REQUEST_DENIED")
    expect(missing.error_message).toMatch(/must use an API key/)
    // The accepted key still works.
    expect(
      await new NativeAddressAutocomplete(BASE, KEY, send).fetchPredictions("Phoenix"),
    ).not.toEqual([])
  })

  test("details honours fields; findplace defaults to place_id only; INVALID_REQUEST without input", async () => {
    const { runtime } = harness()
    const get = async (path: string) =>
      (await (await runtime.fetch(new Request(`${BASE}${path}&key=${KEY}`))).json()) as Record<
        string,
        unknown
      >
    const auto = (await get("/maps/api/place/autocomplete/json?input=1625%20N%20Central")) as {
      predictions: { place_id: string }[]
    }
    const placeId = auto.predictions[0]?.place_id as string
    const onlyComponents = (
      await get(`/maps/api/place/details/json?place_id=${placeId}&fields=address_component`)
    ).result as Record<string, unknown>
    expect(Object.keys(onlyComponents)).toEqual(["address_components"])
    const all = (await get(`/maps/api/place/details/json?place_id=${placeId}`)).result as Record<
      string,
      unknown
    >
    expect(all.formatted_address).toBe("1625 N Central Ave, Phoenix, AZ 85004, USA")
    const find = (
      await get("/maps/api/place/findplacefromtext/json?input=Gilbert&inputtype=textquery")
    ).candidates as Record<string, unknown>[]
    expect(Object.keys(find[0] as object)).toEqual(["place_id"])
    expect((await get("/maps/api/place/details/json?place_id=ChIJnope")).status).toBe("NOT_FOUND")
    expect((await get("/maps/api/place/autocomplete/json?types=address")).status).toBe(
      "INVALID_REQUEST",
    )
    expect((await get("/maps/api/place/findplacefromtext/json?input=x")).status).toBe(
      "INVALID_REQUEST",
    )
    expect((await get("/maps/api/place/details/json?place_id=x&fields=bogus")).status).toBe(
      "INVALID_REQUEST",
    )
    expect(
      (await get("/maps/api/place/autocomplete/json?input=Phoenix&components=country:ca")).status,
    ).toBe("ZERO_RESULTS")
    // A session token is accepted and journaled as metadata only.
    await get(
      `/maps/api/place/autocomplete/json?input=Phoenix&sessiontoken=6b1a2c1e-1111-4222-8333-944455556666`,
    )
    const journal = (await (
      await runtime.fetch(new Request(`${BASE}/__admin/requests?operationId=PlaceAutocomplete`))
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(
      journal.requests.some((r) => r.ids?.sessionToken === "6b1a2c1e-1111-4222-8333-944455556666"),
    ).toBe(true)
    // The journal never holds the typed address.
    expect(JSON.stringify(journal)).not.toContain("Central")
  })

  test("web: the Maps JavaScript shim drives AddressAutocompleteWeb and useGeocodedAddress", async () => {
    const { runtime, send } = harness()
    const win = fakeWindow(send)
    expect(await loadGoogleMapsScript(win, send, BASE, KEY)).toBe("loaded")
    const web = new WebAddressAutocomplete(win)
    const predictions = await web.fetchPredictions("136 Murray")
    expect(predictions[0]?.mainText).toBe("136 Murray Avenue")
    expect(
      await web.selectPrediction(predictions[0] as NonNullable<(typeof predictions)[0]>),
    ).toEqual({
      line1: "136 Murray Avenue",
      city: "Port Washington",
      state: "NY",
      zip: "11050",
    })
    expect(await web.fetchPredictions("zzqx nowhere")).toEqual([])
    expect(web.searchReturnedEmpty).toBe(true)
    // Session tokens reach the REST endpoints.
    const journal = (await (
      await runtime.fetch(new Request(`${BASE}/__admin/requests?operationId=PlaceDetails`))
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.sessionToken).toMatch(/^mbst-/)

    const address = formatBloodworkAddress(PHOENIX_DEMO_ADDRESS)
    expect(await geocodeOnWeb(win, address)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    runtime.applyPreset("geocode_zero_results", "default", { count: 1 })
    expect(await geocodeOnWeb(win, address)).toEqual({
      lat: PHOENIX_DEMO_ADDRESS.lat,
      lng: PHOENIX_DEMO_ADDRESS.lng,
    })
    runtime.applyPreset("autocomplete_over_query_limit", "default", { count: 2 })
    await web.fetchPredictions("Phoenix")
    await web.fetchPredictions("Phoenix")
    expect(web.apiUnavailable).toBe(true)
  })

  test("web: a refused key fires gm_authFailure; &callback= is called; a script outage is onerror", async () => {
    const { runtime, send, admin } = harness()
    await admin("/settings", { keys: [KEY] }, "PUT")
    const win = fakeWindow(send)
    expect(await loadGoogleMapsScript(win, send, BASE, "wrong-key")).toBe("loaded")
    const web = new WebAddressAutocomplete(win)
    await Bun.sleep(5)
    expect(web.authFailed).toBe(true)
    expect(await web.fetchPredictions("Phoenix")).toEqual([])
    expect(web.consecutiveFailures).toBe(1)

    let called = 0
    const withCallback = fakeWindow(send)
    withCallback.initMap = () => {
      called++
    }
    const source = await (
      await send(new Request(`${BASE}/maps/api/js?key=${KEY}&libraries=places&callback=initMap`))
    ).text()
    new Function("window", source)(withCallback)
    expect(called).toBe(1)

    runtime.applyPreset("script_unavailable", "default", { count: 1 })
    expect(await loadGoogleMapsScript(fakeWindow(send), send, BASE, KEY)).toBe("error")
  })

  test("namespaces by API key and by /ns/ prefix isolate custom addresses; the shim stays in its namespace", async () => {
    const { admin, send } = harness()
    await admin("/credentials", { credentials: { "key-worker-a": "a" } }, "PUT")
    const custom = {
      line1: "77 Mockingbird Ln",
      city: "Tempe",
      state: "AZ",
      zip: "85281",
      lat: 33.42,
      lng: -111.94,
    }
    expect((await admin("/corpus?namespace=a", { addresses: [custom] }, "PUT")).status).toBe(200)
    const a = new NativeAddressAutocomplete(BASE, "key-worker-a", send)
    const b = new NativeAddressAutocomplete(BASE, "key-worker-b", send)
    const [found] = await a.fetchPredictions("77 Mockingbird")
    expect(await a.selectPrediction(found as NonNullable<typeof found>)).toEqual({
      line1: "77 Mockingbird Ln",
      city: "Tempe",
      state: "AZ",
      zip: "85281",
    })
    expect(await b.fetchPredictions("77 Mockingbird")).toEqual([])

    // `/ns/a` on the base URL: the shim it serves calls back through `/ns/a`.
    const win = fakeWindow(send)
    expect(await loadGoogleMapsScript(win, send, `${BASE}/ns/a`, "any-key")).toBe("loaded")
    const web = new WebAddressAutocomplete(win)
    expect((await web.fetchPredictions("77 Mockingbird"))[0]?.mainText).toBe("77 Mockingbird Ln")
    const other = fakeWindow(send)
    await loadGoogleMapsScript(other, send, BASE, "any-key")
    expect(await new WebAddressAutocomplete(other).fetchPredictions("77 Mockingbird")).toEqual([])

    expect((await admin("/corpus", { addresses: [{ line1: "x" }] }, "PUT")).status).toBe(400)
  })

  test("contract: /health, x-mockingbird header, every documented preset", async () => {
    const { runtime } = harness()
    const health = await runtime.fetch(new Request(`${BASE}/health`))
    expect(((await health.json()) as { service: string }).service).toBe("google-maps")
    expect(health.headers.get("x-mockingbird")).toMatch(/^google-maps@/)
    expect(Object.keys(GOOGLE_MAPS_PRESETS)).toEqual(
      expect.arrayContaining([
        "over_query_limit",
        "request_denied",
        "unknown_error",
        "zero_results",
        "geocode_zero_results",
        "autocomplete_over_query_limit",
        "server_error",
        "slow",
        "script_unavailable",
      ]),
    )
    // request_denied answers the documented body.
    runtime.applyPreset("request_denied", "default", { count: 1 })
    const denied = (await (
      await runtime.fetch(
        new Request(`${BASE}/maps/api/place/autocomplete/json?input=x&key=${KEY}`),
      )
    ).json()) as { status: string }
    expect(denied.status).toBe("REQUEST_DENIED")
  })
})

describe("served over HTTP", () => {
  test("REST and the JS shim work from a real server with plain fetch", async () => {
    const server = await createServer()
    try {
      const native = new NativeAddressAutocomplete(server.url, KEY, (r) => fetch(r))
      const [first] = await native.fetchPredictions("1625 N Central")
      expect(await native.selectPrediction(first as NonNullable<typeof first>)).toEqual({
        line1: "1625 N Central Ave",
        city: "Phoenix",
        state: "AZ",
        zip: "85004",
      })
      const win = fakeWindow((r) => fetch(r))
      expect(await loadGoogleMapsScript(win, (r) => fetch(r), server.url, KEY)).toBe("loaded")
      expect(await geocodeOnWeb(win, "88 Greenwich St, New York, NY 10006")).toEqual({
        lat: 40.7077,
        lng: -74.0137,
      })
      const script = await fetch(`${server.url}/maps/api/js?key=${KEY}&libraries=places`)
      expect(script.headers.get("content-type")).toMatch(/javascript/)
      expect(await script.text()).toContain(server.url)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^google-maps@/)
    } finally {
      await server.close()
    }
  })
})
