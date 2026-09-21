/**
 * SDK drop-in: the official clients our apps pin, pointed at the mock.
 *
 * - posthog-node 5.52.2 (backend, EMR backend, notification-service): the SDK itself.
 * - @posthog/core 1.54.0 `PostHogCore` (what posthog-react-native 4.72.1 extends): remote
 *   config, `reloadFeatureFlagsAsync`, payloads and the gzip `/batch/` flush.
 * - posthog-js 1.433.2 (EMR frontend, member-app web): its real `request` transport (gzip-js,
 *   base64 `data=` and plain bodies) and its `parseFlagsResponse`, which is what feeds
 *   `onFeatureFlags` / `isFeatureEnabled`. The full browser SDK needs a DOM, which bun lacks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PostHog } from "posthog-node"
import { createRuntime } from "./src/index.js"
import { createServer, type PostHogServer } from "./src/server.js"
import { type Fetcher, ReactNativeLikeClient } from "./test/consumer.js"

console.warn = () => {}

const HOST = "http://posthog.mock"

type Seen = { method: string; url: string; encoding: string | null; contentType: string | null }

const harness = () => {
  const runtime = createRuntime()
  const seen: Seen[] = []
  const fetcher: Fetcher = (url, init) => {
    const request = new Request(url, init)
    seen.push({
      method: request.method,
      url,
      encoding: request.headers.get("content-encoding"),
      contentType: request.headers.get("content-type"),
    })
    return runtime.fetch(request)
  }
  const admin = (path: string, body: unknown, method = "PUT") =>
    runtime.fetch(new Request(`${HOST}/__admin${path}`, { method, body: JSON.stringify(body) }))
  const events = async (query = "") =>
    (
      (await (await runtime.fetch(new Request(`${HOST}/__admin/events${query}`))).json()) as {
        events: { event: string; distinct_id: string; properties: Record<string, unknown> }[]
      }
    ).events
  return { runtime, seen, fetcher, admin, events }
}

describe("posthog-node 5.52.2", () => {
  test("getAllFlagsAndPayloads / getFeatureFlag / isFeatureEnabled / getFeatureFlagPayload", async () => {
    const { fetcher, admin, seen } = harness()
    await admin("/flags/bool-on", { default: true, payload: { a: 1 } })
    await admin("/flags/bool-off", { default: false, payload: { hidden: true } })
    await admin("/flags/multi", {
      default: "control",
      overrides: [{ distinct_id: "7", value: "test", payload: [1, 2] }],
    })
    const posthog = new PostHog("phc_node", {
      host: HOST,
      fetch: fetcher as never,
      flushAt: 1,
    })
    try {
      const all = await posthog.getAllFlagsAndPayloads("7")
      expect(all.featureFlags).toEqual({ "bool-on": true, "bool-off": false, multi: "test" })
      expect(all.featureFlagPayloads).toEqual({ "bool-on": { a: 1 }, multi: [1, 2] })
      expect(await posthog.getFeatureFlag("multi", "8")).toBe("control")
      expect(await posthog.getFeatureFlag("absent", "8")).toBeUndefined()
      expect(await posthog.isFeatureEnabled("multi", "8")).toBe(true)
      expect(await posthog.isFeatureEnabled("bool-off", "8")).toBe(false)
      expect(await posthog.getFeatureFlagPayload("bool-on", "8")).toEqual({ a: 1 })
      // A disabled flag carries no payload; the SDK answers null.
      expect(await posthog.getFeatureFlagPayload("bool-off", "8")).toBeNull()
      const flags = seen.find((s) => s.url.includes("/flags/"))
      expect(flags?.url).toBe(`${HOST}/flags/?v=2`)
    } finally {
      await posthog.shutdown()
    }
  })

  test("person properties and groups travel in the body; email targeting applies", async () => {
    const { fetcher, admin } = harness()
    await admin("/flags/by-email", { overrides: [{ email: "a@b.test", value: true }] })
    const posthog = new PostHog("phc_node", { host: HOST, fetch: fetcher as never })
    try {
      expect(
        await posthog.getFeatureFlag("by-email", "x", { personProperties: { email: "A@B.test" } }),
      ).toBe(true)
      expect(await posthog.getFeatureFlag("by-email", "x")).toBeUndefined()
    } finally {
      await posthog.shutdown()
    }
  })

  test("capture flushes a gzip /batch/ the mock decodes", async () => {
    const { fetcher, seen, events } = harness()
    const posthog = new PostHog("phc_node", { host: HOST, fetch: fetcher as never })
    posthog.capture({ distinctId: "u1", event: "signup_completed", properties: { plan: "core" } })
    posthog.identify({ distinctId: "u1", properties: { email_verified: true } })
    await posthog.shutdown()
    const batch = seen.filter((s) => s.url === `${HOST}/batch/`)
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.every((s) => s.encoding === "gzip")).toBe(true)
    const captured = await events("?distinct_id=u1")
    expect(captured.map((e) => e.event)).toEqual(["signup_completed", "$identify"])
    expect(captured[0]?.properties).toMatchObject({ plan: "core", $lib: "posthog-node" })
  })

  test("the project token selects the namespace (PUT /__admin/credentials)", async () => {
    const { fetcher, admin, events } = harness()
    await admin("/credentials", { credentials: { phc_one: "one", phc_two: "two" } })
    await admin("/flags/k?namespace=one", { default: "one" })
    await admin("/flags/k?namespace=two", { default: "two" })
    const one = new PostHog("phc_one", { host: HOST, fetch: fetcher as never })
    const two = new PostHog("phc_two", { host: HOST, fetch: fetcher as never })
    try {
      expect(
        await Promise.all([one.getFeatureFlag("k", "u"), two.getFeatureFlag("k", "u")]),
      ).toEqual(["one", "two"])
      one.capture({ distinctId: "u", event: "from-one" })
      await one.flush()
      expect((await events("?namespace=one&event=from-one")).length).toBe(1)
      expect((await events("?namespace=two&event=from-one")).length).toBe(0)
    } finally {
      await Promise.all([one.shutdown(), two.shutdown()])
    }
  })
})

describe("@posthog/core PostHogCore (the posthog-react-native base)", () => {
  test("remote config, reloadFeatureFlagsAsync, payloads, and a gzip batch", async () => {
    const { fetcher, admin, seen, events } = harness()
    await admin("/flags/rn-flag", { default: "variant-a", payload: { cta: "Book" } })
    await admin("/flags/rn-off", { default: false })
    const client = new ReactNativeLikeClient("phc_rn", { host: HOST }, fetcher)
    try {
      const config = await client.reloadRemoteConfigAsync()
      expect(config).toMatchObject({
        supportedCompression: ["gzip", "gzip-js"],
        analytics: { endpoint: "/i/v0/e/" },
        hasFeatureFlags: true,
        sessionRecording: false,
      })
      client.identify("member-9", { email: "m@x.test" })
      const flags = await client.reloadFeatureFlagsAsync()
      expect(flags).toEqual({ "rn-flag": "variant-a", "rn-off": false })
      expect(client.getFeatureFlag("rn-flag")).toBe("variant-a")
      expect(client.getFeatureFlagPayload("rn-flag")).toEqual({ cta: "Book" })
      expect(client.isFeatureEnabled("rn-off")).toBe(false)
      client.capture("screen_viewed", { screen: "home" })
      await client.flush()
      expect(seen.some((s) => s.url === `${HOST}/array/phc_rn/config`)).toBe(true)
      expect(seen.some((s) => s.url.startsWith(`${HOST}/flags/?v=2`))).toBe(true)
      const batch = seen.filter((s) => s.url === `${HOST}/batch/`)
      expect(batch.length).toBeGreaterThan(0)
      expect(batch.every((s) => s.encoding === "gzip")).toBe(true)
      expect((await events("?distinct_id=member-9")).map((e) => e.event)).toContain("screen_viewed")
    } finally {
      await client.shutdown()
    }
  })

  test("config=true on /flags carries the remote-config fields", async () => {
    const { runtime } = harness()
    const response = await runtime.fetch(
      new Request(`${HOST}/flags/?v=2&config=true`, {
        method: "POST",
        body: JSON.stringify({ token: "phc_rn", distinct_id: "d" }),
      }),
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      flags: {},
      supportedCompression: ["gzip", "gzip-js"],
      sessionRecording: false,
      errorsWhileComputingFlags: false,
    })
  })
})

describe("posthog-js 1.433.2 transport", () => {
  let server: PostHogServer
  type RequestFn = (options: Record<string, unknown>) => void
  let request: RequestFn
  let parseFlagsResponse: (response: unknown) => Record<string, unknown> | undefined

  beforeAll(async () => {
    server = await createServer()
    // posthog-js reads `window.fetch` once at import; give it the global scope, then remove it.
    const scope = globalThis as { window?: unknown }
    scope.window = globalThis
    try {
      request = (
        (await import("posthog-js/lib/src/request.js")) as unknown as { request: RequestFn }
      ).request
      parseFlagsResponse = (
        (await import("posthog-js/lib/src/posthog-featureflags.js")) as unknown as {
          parseFlagsResponse: typeof parseFlagsResponse
        }
      ).parseFlagsResponse
    } finally {
      delete scope.window
    }
  })
  afterAll(async () => {
    await server.close()
  })

  const send = (path: string, data: unknown, compression?: string) =>
    new Promise<{ statusCode: number; json?: Record<string, unknown> }>((resolve) =>
      request({
        url: `${server.url}${path}`,
        method: "POST",
        data,
        ...(compression ? { compression } : {}),
        transport: "fetch",
        callback: resolve,
      }),
    )
  const admin = (path: string, body: unknown, method = "PUT") =>
    fetch(`${server.url}/__admin${path}`, { method, body: JSON.stringify(body) })

  test("flags in every body encoding feed onFeatureFlags the admin values", async () => {
    await admin("/flags/web-flag?namespace=web", { default: "treatment", payload: { hero: 2 } })
    await admin("/flags/web-off?namespace=web", { default: false })
    await admin("/credentials", { credentials: { phc_web: "web" } })
    const body = {
      token: "phc_web",
      distinct_id: "anon-1",
      groups: {},
      person_properties: { $lib: "web", $lib_version: "1.433.2" },
      timezone: "UTC",
    }
    for (const [path, compression] of [
      ["/flags/?v=2", "gzip-js"],
      ["/flags/?v=2&compression=gzip-js&ver=1.433.2", "gzip-js"],
      ["/flags/?v=2", "base64"],
      ["/flags/?v=2", undefined],
    ] as const) {
      const response = await send(path, body, compression)
      expect(response.statusCode).toBe(200)
      const persisted = parseFlagsResponse(response.json)
      expect(persisted?.$enabled_feature_flags).toEqual({
        "web-flag": "treatment",
        "web-off": false,
      })
      expect(persisted?.$active_feature_flags).toEqual(["web-flag"])
      // posthog-js keeps payloads as the JSON strings the wire carries.
      expect(persisted?.$feature_flag_payloads).toEqual({ "web-flag": '{"hero":2}' })
    }
  })

  test("capture batches (gzip-js and base64 data= bodies) land in the events store", async () => {
    await admin("/credentials", { credentials: { phc_web2: "web2" } })
    const batch = [
      {
        event: "$pageview",
        properties: { token: "phc_web2", distinct_id: "anon-2", $current_url: "/" },
      },
      { event: "cta_clicked", properties: { token: "phc_web2", distinct_id: "anon-2" } },
    ]
    expect((await send("/e/?ver=1.433.2", batch, "gzip-js")).statusCode).toBe(200)
    expect((await send("/i/v0/e/?ver=1.433.2", batch, "base64")).statusCode).toBe(200)
    const stored = (await (await fetch(`${server.url}/__admin/events?namespace=web2`)).json()) as {
      events: { event: string; distinct_id: string; endpoint: string }[]
    }
    expect(stored.events.map((e) => [e.event, e.distinct_id, e.endpoint])).toEqual([
      ["$pageview", "anon-2", "/e/"],
      ["cta_clicked", "anon-2", "/e/"],
      ["$pageview", "anon-2", "/i/v0/e/"],
      ["cta_clicked", "anon-2", "/i/v0/e/"],
    ])
  })

  test("config.js sets window._POSTHOG_REMOTE_CONFIG; surveys, experiments and recorder answer", async () => {
    const script = await (await fetch(`${server.url}/array/phc_web/config.js`)).text()
    const sandbox: {
      _POSTHOG_REMOTE_CONFIG?: Record<string, { config: Record<string, unknown> }>
    } = {}
    new Function("window", script)(sandbox)
    expect(sandbox._POSTHOG_REMOTE_CONFIG?.phc_web?.config).toMatchObject({
      analytics: { endpoint: "/i/v0/e/" },
      supportedCompression: ["gzip", "gzip-js"],
    })
    expect(await (await fetch(`${server.url}/api/surveys/?token=phc_web`)).json()).toEqual({
      surveys: [],
    })
    expect(await (await fetch(`${server.url}/api/web_experiments/?token=phc_web`)).json()).toEqual({
      experiments: [],
    })
    for (const path of ["/static/recorder.js?v=1.433.2", "/static/1.433.2/recorder.js"]) {
      const response = await fetch(`${server.url}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("javascript")
    }
    const recording = await send(
      "/s/?compression=gzip-js",
      [{ event: "$snapshot", properties: { token: "phc_web" } }],
      "gzip-js",
    )
    expect(recording.statusCode).toBe(200)
  })
})
