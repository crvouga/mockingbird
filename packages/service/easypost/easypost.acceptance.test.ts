import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  createRuntime,
  EASYPOST_PRESETS,
  TEST_TRACKING_CODES,
  TRACKER_STATUSES,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  batchLookupTrackingStatuses,
  type Fetch,
  lookupTrackingStatus,
  mapEasyPostStatus,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://easypost.mock"
const KEY = "EZTK_test_key"
const UPS = "1Z999AA10123456784"

const harness = () => {
  const runtime = createRuntime()
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const lookup = (trackingNumber: string, apiKey = KEY) =>
    lookupTrackingStatus({ baseUrl: API, trackingNumber, apiKey, fetchImpl })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, fetchImpl, lookup, admin }
}

describe("S25 EasyPost acceptance: our tracking lookup against the mock", () => {
  test("EasyPost's documented test codes answer their fixed statuses (carrier USPS)", async () => {
    const { lookup } = harness()
    const expected: Record<string, string> = {
      EZ1000000001: "pre_transit",
      EZ2000000002: "in_transit",
      EZ3000000003: "out_for_delivery",
      EZ4000000004: "delivered",
      // Our mapper folds return_to_sender into failure.
      EZ5000000005: "failure",
      EZ6000000006: "failure",
      EZ7000000007: "unknown",
    }
    for (const [code, status] of Object.entries(expected)) {
      const result = await lookup(code)
      expect(result.status).toBe(status as never)
      expect(result.carrier).toBe("USPS")
      expect(result.statusDetail).toBe(TEST_TRACKING_CODES[code]?.status_detail as string)
    }
  })

  test("a real-shaped code starts unknown and follows admin transitions; the tracker is re-used", async () => {
    const { lookup, admin, runtime } = harness()
    const first = await lookup(UPS)
    expect(first).toEqual({
      trackingNumber: UPS,
      status: "unknown",
      carrier: "UPS",
      statusDetail: "unknown",
    })
    for (const [status, mapped] of [
      ["pre_transit", "pre_transit"],
      ["in_transit", "in_transit"],
      ["out_for_delivery", "out_for_delivery"],
      ["delivered", "delivered"],
    ] as const) {
      expect((await admin(`/trackers/${UPS}/transition`, { status })).status).toBe(200)
      expect((await lookup(UPS)).status).toBe(mapped)
    }
    const trackers = runtime.instance().trackers()
    expect(trackers).toHaveLength(1)
    expect(trackers[0]?.tracking_details.map((d) => d.status)).toEqual([
      "pre_transit",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ])
  })

  test("a transition before the first lookup pre-registers the code (seed a status for the app)", async () => {
    const { lookup, admin } = harness()
    await admin("/trackers/9400100000000000000000/transition", {
      status: "available_for_pickup",
    })
    const result = await lookup("9400100000000000000000")
    // available_for_pickup maps to in_transit in our client.
    expect(result).toMatchObject({ status: "in_transit", carrier: "USPS" })
    expect(result.statusDetail).toBe("arrived_at_pickup_location")
  })

  test("every EasyPost status is reachable and maps the way our client maps it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TRACKER_STATUSES), async (status) => {
        const { lookup, admin } = harness()
        await admin(`/trackers/${UPS}/transition`, { status })
        expect((await lookup(UPS)).status).toBe(mapEasyPostStatus(status))
      }),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })

  test("carrier hints: DHL is normalised to DHLExpress and our client maps it back to DHL", async () => {
    const { lookup, runtime } = harness()
    const result = await lookup("1234567890")
    expect(result.carrier).toBe("DHL")
    expect(runtime.instance().trackers()[0]?.carrier).toBe("DHLExpress")
  })

  test("errors surface error.message as the status detail", async () => {
    const { lookup, admin, fetchImpl } = harness()
    await admin("/settings", { apiKeys: [KEY] }, "PUT")
    const denied = await lookup(UPS, "EZTK_wrong")
    expect(denied.status).toBe("unknown")
    expect(denied.statusDetail).toMatch(/couldn't authenticate you/)
    // A blank code is caught by our client before any request; sent raw it is a 422.
    const raw = await fetchImpl(`${API}/v2/trackers`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${KEY}:`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "tracker[carrier]=UPS",
    })
    expect(raw.status).toBe(422)
    expect(await raw.json()).toEqual({
      error: {
        code: "PARAMETER.REQUIRED",
        message: "Missing required parameter.",
        errors: [{ field: "tracker.tracking_code", message: "cannot be blank" }],
      },
    })
    expect((await lookup("   ")).statusDetail).toBe("empty tracking number")
  })

  test("presets: rate limit, 5xx, revoked key, an HTML gateway page and a dropped connection", async () => {
    const cases: [string, string][] = [
      ["rate_limited", "You have exceeded the rate limit for this endpoint."],
      ["server_error", "Something went wrong on our end."],
      ["invalid_api_key", "We couldn't authenticate you. Please check your API key and try again."],
      ["gateway_html", "EasyPost tracker request failed (502)"],
    ]
    for (const [preset, detail] of cases) {
      const { runtime, lookup } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      expect(await lookup(UPS)).toEqual({
        trackingNumber: UPS,
        status: "unknown",
        carrier: "UPS",
        statusDetail: detail,
      })
      expect((await lookup(UPS)).statusDetail).toBe("unknown")
    }
    const { runtime, fetchImpl } = harness()
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    const warnings: string[] = []
    const results = await batchLookupTrackingStatuses({
      baseUrl: API,
      trackingNumbers: [UPS],
      apiKey: KEY,
      fetchImpl,
      onWarning: (m) => warnings.push(m),
    })
    expect(results.get(UPS)?.status).toBe("unknown")
    expect(warnings[0]).toMatch(/tracking lookup failed for 1Z999AA10123456784/)
  })

  test("the batch lookup dedupes codes: one tracker request per unique code", async () => {
    const { runtime, fetchImpl } = harness()
    const results = await batchLookupTrackingStatuses({
      baseUrl: API,
      trackingNumbers: ["EZ4000000004", " EZ4000000004 ", "EZ2000000002", "", UPS],
      apiKey: KEY,
      concurrency: 2,
      fetchImpl,
    })
    expect([...results.keys()].sort()).toEqual(["EZ2000000002", "EZ4000000004", UPS].sort())
    const journal = (await (
      await runtime.fetch(new Request(`${API}/__admin/requests?operationId=CreateTracker`))
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests).toHaveLength(3)
    expect(journal.requests.every((r) => r.ids?.trackerId?.startsWith("trk_"))).toBe(true)
  })

  test("namespaces by API key, by header and by /ns/ prefix isolate workers", async () => {
    const { runtime, fetchImpl, admin } = harness()
    await admin("/credentials", { credentials: { EZTK_worker_a: "a", EZTK_worker_b: "b" } }, "PUT")
    await admin(`/trackers/${UPS}/transition?namespace=a`, { status: "delivered" })
    const as = (apiKey: string, baseUrl = API) =>
      lookupTrackingStatus({ baseUrl, trackingNumber: UPS, apiKey, fetchImpl })
    expect((await as("EZTK_worker_a")).status).toBe("delivered")
    expect((await as("EZTK_worker_b")).status).toBe("unknown")
    expect((await as(KEY, `${API}/ns/a`)).status).toBe("delivered")
    const viaHeader = await runtime.fetch(
      new Request(`${API}/v2/trackers?tracking_code=${UPS}`, {
        headers: { authorization: `Basic ${btoa(`${KEY}:`)}`, "x-mockingbird-namespace": "a" },
      }),
    )
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^easypost@.*; ns=a$/)
    expect(((await viaHeader.json()) as { trackers: unknown[] }).trackers).toHaveLength(1)
  })

  test("every documented preset is registered, and /health answers", async () => {
    expect(Object.keys(EASYPOST_PRESETS)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "server_error",
        "invalid_api_key",
        "gateway_html",
        "connection_drop",
      ]),
    )
    const { runtime } = harness()
    const health = await runtime.fetch(new Request(`${API}/health`))
    expect(((await health.json()) as { status: string }).status).toBe("ok")
  })
})

describe("served over HTTP", () => {
  test("our lookup works against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const fetchImpl: Fetch = (input, init) => fetch(input, init)
      await fetch(`${server.url}/__admin/trackers/EZ1000000001/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "delivered" }),
      })
      const result = await lookupTrackingStatus({
        baseUrl: server.url,
        trackingNumber: "EZ1000000001",
        apiKey: KEY,
        fetchImpl,
      })
      expect(result).toMatchObject({ status: "delivered", carrier: "USPS" })
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^easypost@/)
    } finally {
      await server.close()
    }
  })
})
