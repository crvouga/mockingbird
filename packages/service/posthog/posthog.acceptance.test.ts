import { afterEach, describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, POSTHOG_PRESETS, type PostHogRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  deriveState,
  EmrFeatureFlagsService,
  evaluatePostHogFlag,
  type Fetcher,
  fetchProjectFlags,
  MakorPostHogClient,
  MemberAppFlagsAdapter,
  PostHogHogqlClient,
  PostHogServerAdapter,
  PostHogTrackingService,
  ReactNativeLikeClient,
  resetServerFlagCache,
  SERVER_FLAG_SENTINEL_DISTINCT_ID,
  WEBSITE_PURCHASE_EVENT,
  WebsitePostHogPurchaseSink,
  websitePurchaseCaptureUuid,
} from "./test/consumer.js"
import page1 from "./test/fixtures/posthog-page-1.json" with { type: "json" }
import page2 from "./test/fixtures/posthog-page-2.json" with { type: "json" }

const params = fcParameters(process.env)
const HOST = "http://posthog.mock"
const TOKEN = "phc_localStackToken"

// posthog-node logs a deprecation warning per getFeatureFlag/isFeatureEnabled call.
console.warn = () => {}

/** A runtime plus the in-process `fetch` every consumer port is given. */
const harness = () => {
  const runtime = createRuntime()
  const fetcher: Fetcher = (url, init) => runtime.fetch(new Request(url, init))
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "PUT",
  ) => {
    const response = await runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { runtime, fetcher, admin }
}

const closers: (() => Promise<unknown>)[] = []
const track = <T extends { onModuleDestroy?: () => Promise<void>; shutdown?: () => Promise<void> }>(
  client: T,
) => {
  closers.push(async () => {
    await client.onModuleDestroy?.()
    await client.shutdown?.()
  })
  return client
}
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()))
  resetServerFlagCache()
})

const backend = (fetcher: Fetcher, host = HOST, token = TOKEN) =>
  track(new PostHogServerAdapter({ POSTHOG_API_KEY: token, POSTHOG_HOST: host }, fetcher))

describe("S6.6 acceptance: posthog-node through the backend adapter", () => {
  test("getAllFlagsAndPayloads / getFeatureFlag read admin values with the adapter's value mapping", async () => {
    const { admin, fetcher } = harness()
    await admin("/flags", {
      flags: {
        "shop-coupons": { default: true },
        "mobile-smart-links": { default: false },
        "b2b-member-tagging": { default: "test" },
      },
    })
    const adapter = backend(fetcher)
    expect(await adapter.getEvaluation("shop-coupons", "101")).toBe(true)
    expect(await adapter.getEvaluation("mobile-smart-links", "101")).toBe(false)
    // A non-empty variant string means enabled…
    expect(await adapter.getEvaluation("b2b-member-tagging", "101")).toBe(true)
    // …and an absent key is "not decided by PostHog".
    expect(await adapter.getEvaluation("never-created", "101")).toBeUndefined()
    expect(await adapter.isEnabled("never-created", "101", true)).toBe(true)

    // The strict path (getFeatureFlag, 1 s race, uncached) only resolves real booleans.
    expect(await adapter.resolveStrictBoolean("shop-coupons", "101")).toEqual({
      status: "resolved",
      enabled: true,
    })
    expect(await adapter.resolveStrictBoolean("mobile-smart-links", "101")).toEqual({
      status: "resolved",
      enabled: false,
    })
    expect(await adapter.resolveStrictBoolean("b2b-member-tagging", "101")).toEqual({
      status: "unresolved",
      reason: "not_a_boolean",
    })
    expect(await adapter.resolveStrictBoolean("never-created", "101")).toEqual({
      status: "unresolved",
      reason: "not_a_boolean",
    })
  })

  test("SHOP_COUPONS strict-boolean flips per test (the strict path is not cached)", async () => {
    const { admin, fetcher } = harness()
    const adapter = backend(fetcher)
    for (const value of [true, false, true]) {
      await admin("/flags/shop-coupons", { default: value })
      expect(await adapter.isStrictBooleanEnabled("shop-coupons", "7")).toBe(value)
    }
    await admin("/flags/shop-coupons", undefined, "DELETE")
    expect(await adapter.resolveStrictBoolean("shop-coupons", "7")).toEqual({
      status: "unresolved",
      reason: "not_a_boolean",
    })
  })

  test("a payload set via admin reaches backend getConfig (object payloads only)", async () => {
    const { admin, fetcher } = harness()
    // Catalog names RX_CATEGORY_INTAKE (B/erx/services/rx-category-intake.gate.ts); that gate
    // is gone from the consumer today, so the key here is illustrative.
    await admin("/flags/rx-category-intake", {
      default: true,
      payload: { categories: ["trt", "glp1"], version: 2 },
    })
    await admin("/flags/string-payload", { default: true, payload: "just-a-string" })
    await admin("/flags/off-with-payload", { default: false, payload: { hidden: true } })
    const adapter = backend(fetcher)
    expect(await adapter.getConfig("rx-category-intake", "55")).toEqual({
      categories: ["trt", "glp1"],
      version: 2,
    })
    expect(await adapter.getConfig("string-payload", "55")).toBeUndefined()
    // Payloads only travel with an enabled flag.
    expect(await adapter.getConfig("off-with-payload", "55")).toBeUndefined()
  })

  test("targeting: by distinct_id, by person_properties.email, then the default", async () => {
    const { admin, fetcher } = harness()
    await admin("/flags/advanced-hormone-pdfs", {
      default: false,
      overrides: [
        { distinct_id: "42", value: true, payload: { tier: "vip" } },
        { email: "Ops@Geviti.test", value: "beta" },
      ],
    })
    const adapter = backend(fetcher)
    expect(await adapter.getEvaluation("advanced-hormone-pdfs", "42")).toBe(true)
    expect(await adapter.getConfig("advanced-hormone-pdfs", "42")).toEqual({ tier: "vip" })
    expect(await adapter.getEvaluation("advanced-hormone-pdfs", "43")).toBe(false)
    // The EMR frontend sends person_properties.email; matching is case-insensitive.
    const env = { NEXT_PUBLIC_POSTHOG_KEY: TOKEN, NEXT_PUBLIC_POSTHOG_HOST: HOST }
    expect(
      await evaluatePostHogFlag(
        env,
        "advanced-hormone-pdfs",
        { distinctId: "practitioner-9", personProperties: { email: "ops@geviti.test" } },
        fetcher,
      ),
    ).toBe(true)
  })

  test("two tokens hold different values for the same key at the same time", async () => {
    const { admin, fetcher } = harness()
    await admin("/credentials", { credentials: { phc_worker_a: "wa", phc_worker_b: "wb" } })
    await admin("/flags/shop-coupons?namespace=wa", { default: true, payload: { pct: 10 } })
    await admin("/flags/shop-coupons?namespace=wb", { default: false })
    const a = backend(fetcher, HOST, "phc_worker_a")
    const b = backend(fetcher, HOST, "phc_worker_b")
    // A third worker picks its namespace by host prefix instead.
    await admin("/flags/shop-coupons?namespace=wc", { default: "variant-c" })
    const c = backend(fetcher, `${HOST}/ns/wc`, "phc_unmapped")
    const [ra, rb, rc] = await Promise.all([
      a.resolveStrictBoolean("shop-coupons", "1"),
      b.resolveStrictBoolean("shop-coupons", "1"),
      c.getEvaluation("shop-coupons", "1"),
    ])
    expect(ra).toEqual({ status: "resolved", enabled: true })
    expect(rb).toEqual({ status: "resolved", enabled: false })
    expect(rc).toBe(true)
    expect(await a.getConfig("shop-coupons", "1")).toEqual({ pct: 10 })
    expect(await b.getConfig("shop-coupons", "1")).toBeUndefined()
  })
})

describe("S6.4 semantics across every consumer", () => {
  test("absent vs enabled:false: the member app falls through only for an absent key", async () => {
    const { admin, fetcher } = harness()
    await admin("/flags/explicit-off", { default: false })
    await admin("/flags/explicit-on", { default: true, payload: { banner: "hi" } })
    await admin("/flags/unset-default", {
      overrides: [{ distinct_id: "someone-else", value: true }],
    })
    const client = new ReactNativeLikeClient(TOKEN, { host: HOST }, fetcher)
    closers.push(() => client.shutdown())
    client.identify("member-1")
    const adapter = new MemberAppFlagsAdapter(client)
    await adapter.init()
    expect(adapter.hasFlag("explicit-off")).toBe(true)
    expect(adapter.isEnabled("explicit-off", true)).toBe(false)
    expect(adapter.hasFlag("unset-default")).toBe(false)
    expect(adapter.isEnabled("unset-default", true)).toBe(true)
    expect(adapter.hasFlag("never-created")).toBe(false)
    expect(adapter.isEnabled("explicit-on")).toBe(true)
    expect(adapter.getConfig("explicit-on")).toEqual({ banner: "hi" })
  })

  test("variants: RN getValue returns the variant; every boolean consumer maps it to true", async () => {
    const { admin, fetcher } = harness()
    await admin("/flags/checkout-copy", { default: "post" })
    const client = new ReactNativeLikeClient(TOKEN, { host: HOST }, fetcher)
    closers.push(() => client.shutdown())
    const adapter = new MemberAppFlagsAdapter(client)
    await adapter.init()
    expect(adapter.getValue("checkout-copy")).toBe("post")
    expect(
      await new MakorPostHogClient(TOKEN, HOST, fetcher).getEvaluation("checkout-copy", "x"),
    ).toBe(true)
    expect(
      await evaluatePostHogFlag(
        { NEXT_PUBLIC_POSTHOG_KEY: TOKEN, NEXT_PUBLIC_POSTHOG_HOST: HOST },
        "checkout-copy",
        { distinctId: SERVER_FLAG_SENTINEL_DISTINCT_ID },
        fetcher,
      ),
    ).toBe(true)
  })

  test("EMR frontend server: POST /flags?v=2 (no slash, api_key) reads flags, absent → undefined", async () => {
    const { admin, runtime } = harness()
    await admin("/flags/emr-on", { default: true })
    await admin("/flags/emr-off", { default: false })
    const seen: string[] = []
    const fetcher: Fetcher = async (url, init) => {
      seen.push(`${init.method} ${url} ${String(init.body)}`)
      return runtime.fetch(new Request(url, init))
    }
    const env = { NEXT_PUBLIC_POSTHOG_KEY: TOKEN, NEXT_PUBLIC_POSTHOG_HOST: `${HOST}/` }
    const id = { distinctId: SERVER_FLAG_SENTINEL_DISTINCT_ID }
    expect(await evaluatePostHogFlag(env, "emr-on", id, fetcher)).toBe(true)
    expect(await evaluatePostHogFlag(env, "emr-off", id, fetcher)).toBe(false)
    expect(await evaluatePostHogFlag(env, "emr-absent", id, fetcher)).toBeUndefined()
    expect(seen[0]).toStartWith(`POST ${HOST}/flags?v=2 {"api_key":"${TOKEN}"`)
  })

  test("EMR backend gates (isFeatureEnabled): true only when explicitly enabled", async () => {
    const { admin, fetcher } = harness()
    await admin("/flags/rx-id-verification", {
      default: false,
      overrides: [{ distinct_id: "501" }],
    })
    const emr = track(new EmrFeatureFlagsService(TOKEN, HOST, fetcher))
    expect(await emr.isRxIdVerificationRequired("501")).toBe(true)
    expect(await emr.isRxIdVerificationRequired("502")).toBe(false)
    // Undecided (flag not created yet) is false too.
    expect(await emr.isMemberTaggingProgramEnabled("staff-1")).toBe(false)
  })

  test("makor /decide/?v=3 answers the legacy maps with JSON-string payloads", async () => {
    const { admin, runtime, fetcher } = harness()
    await admin("/flags/supplements", { default: true, payload: { max: 3 } })
    const makor = new MakorPostHogClient(TOKEN, HOST, fetcher)
    expect(await makor.isEnabled("supplements", "u")).toBe(true)
    expect(await makor.isEnabled("missing", "u", true)).toBe(true)
    const raw = (await (
      await runtime.fetch(
        new Request(`${HOST}/decide/?v=3`, {
          method: "POST",
          body: JSON.stringify({ api_key: TOKEN, distinct_id: "u" }),
        }),
      )
    ).json()) as Record<string, unknown>
    expect(raw.featureFlags).toEqual({ supplements: true })
    expect(raw.featureFlagPayloads).toEqual({ supplements: '{"max":3}' })
    expect(raw.flags).toBeUndefined()
  })

  test("property: every admin value maps the same way through every consumer", async () => {
    const value = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.constantFrom("control", "test", "variant-b"),
    )
    await fc.assert(
      fc.asyncProperty(value, fc.integer({ min: 1, max: 99_999 }), async (flagValue, user) => {
        const { admin, fetcher } = harness()
        // Each run is a fresh app process: the EMR frontend's module-level cache starts empty.
        resetServerFlagCache()
        await admin("/flags/prop-flag", { default: flagValue })
        const distinctId = String(user)
        const expected = flagValue === null ? undefined : flagValue !== false
        const adapter = backend(fetcher)
        expect(await adapter.getEvaluation("prop-flag", distinctId)).toBe(expected)
        expect(
          await new MakorPostHogClient(TOKEN, HOST, fetcher).getEvaluation("prop-flag", distinctId),
        ).toBe(expected ?? null)
        expect(
          await evaluatePostHogFlag(
            { NEXT_PUBLIC_POSTHOG_KEY: TOKEN, NEXT_PUBLIC_POSTHOG_HOST: HOST },
            "prop-flag",
            { distinctId },
            fetcher,
          ),
        ).toBe(expected)
        expect(await adapter.resolveStrictBoolean("prop-flag", distinctId)).toEqual(
          typeof flagValue === "boolean"
            ? { status: "resolved", enabled: flagValue }
            : { status: "unresolved", reason: "not_a_boolean" },
        )
      }),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 60_000)
})

describe("capture: events reach GET /__admin/events", () => {
  test("posthog-node capture (gzip /batch/): lifecycle $set, $set, custom events", async () => {
    const { runtime, admin } = harness()
    const encodings: (string | null)[] = []
    const fetcher: Fetcher = (url, init) => {
      const request = new Request(url, init)
      if (url.endsWith("/batch/")) encodings.push(request.headers.get("content-encoding"))
      return runtime.fetch(request)
    }
    const tracking = new PostHogTrackingService(
      { POSTHOG_API_KEY: TOKEN, POSTHOG_HOST: HOST },
      fetcher,
    )
    tracking.trackLifecycleEvent(
      "77",
      "bloodwork_booked",
      { method: "at_home" },
      "appointment_set",
      {
        bloodwork_method: "at_home",
      },
    )
    tracking.setPersonProperties("77", { plan: "core" })
    tracking.track("78", "shop_viewed", { sku: "x" })
    await tracking.onModuleDestroy()
    expect(encodings.length).toBeGreaterThan(0)
    expect(encodings.every((e) => e === "gzip")).toBe(true)
    const events = (await admin("/events?distinct_id=77")).body.events as {
      event: string
      properties: Record<string, unknown>
    }[]
    expect(events.map((e) => e.event)).toEqual(["bloodwork_booked", "$set"])
    expect(events[0]?.properties.$set).toMatchObject({
      lifecycle_stage: "appointment_set",
      bloodwork_method: "at_home",
    })
    expect(events[1]?.properties.$set).toEqual({ plan: "core" })
    const shop = (await admin("/events?event=shop_viewed")).body.events as unknown[]
    expect(shop).toHaveLength(1)
  })

  test("website purchase sink: raw /i/v0/e/ with a v5 uuid; a replay is deduplicated", async () => {
    const { admin, fetcher } = harness()
    const sink = new WebsitePostHogPurchaseSink(
      {
        MARKETING_SPLIT_POSTHOG_WEBSITE_KEY: "phc_website",
        APP_ENV: "production",
        POSTHOG_HOST: HOST,
      },
      fetcher,
    )
    const capture = {
      distinctId: "anon-123",
      orderId: "ord_1",
      eventTime: "2026-09-20T10:00:00.000Z",
      amountInCents: 19_900,
      currency: "usd",
    }
    expect(await sink.capturePurchase(capture)).toBe("sent")
    expect(await sink.capturePurchase(capture)).toBe("sent")
    const events = (await admin(`/events?event=${WEBSITE_PURCHASE_EVENT}`)).body.events as {
      uuid: string
      timestamp: string
      properties: Record<string, unknown>
    }[]
    expect(events).toHaveLength(1)
    expect(events[0]?.uuid).toBe(websitePurchaseCaptureUuid("anon-123", "ord_1"))
    expect(events[0]?.timestamp).toBe(capture.eventTime)
    expect(events[0]?.properties).toMatchObject({ order_id: "ord_1", value: 199, currency: "USD" })
    // Non-production APP_ENV never sends.
    const dev = new WebsitePostHogPurchaseSink(
      { MARKETING_SPLIT_POSTHOG_WEBSITE_KEY: "phc_website", APP_ENV: "dev", POSTHOG_HOST: HOST },
      fetcher,
    )
    expect(await dev.capturePurchase(capture)).toBe("skipped")
  })

  test("$exception keeps no message or stack; free-text properties are never stored", async () => {
    const { runtime, admin } = harness()
    await runtime.fetch(
      new Request(`${HOST}/batch/`, {
        method: "POST",
        body: JSON.stringify({
          api_key: TOKEN,
          batch: [
            {
              event: "$exception",
              distinct_id: "9",
              properties: {
                $exception_list: [{ type: "Error", value: "patient DOB 1970-01-01 invalid" }],
                $exception_message: "patient DOB 1970-01-01 invalid",
                $exception_stack_trace_raw: "at x (y.ts:1)",
                $exception_level: "error",
                $lib: "posthog-node",
              },
            },
            {
              event: "message_sent",
              distinct_id: "9",
              properties: {
                message_body: "hello doctor",
                channel: "sms",
                $set: { note: "x", a: 1 },
              },
            },
          ],
        }),
      }),
    )
    const events = (await admin("/events?distinct_id=9")).body.events as {
      event: string
      properties: Record<string, unknown>
    }[]
    expect(events[0]?.properties).toEqual({ $exception_level: "error", $lib: "posthog-node" })
    expect(events[1]?.properties).toEqual({ channel: "sms", $set: { a: 1 } })
    const journal = JSON.stringify((await admin("/requests")).body)
    expect(journal).not.toContain("1970-01-01")
    expect(journal).not.toContain("hello doctor")
  })

  test("events filter by since (mock clock); /s/ is counted and discarded", async () => {
    const { runtime, admin } = harness()
    const capture = (event: string) =>
      runtime.fetch(
        new Request(`${HOST}/i/v0/e/`, {
          method: "POST",
          body: JSON.stringify({ api_key: TOKEN, event, distinct_id: "s1" }),
        }),
      )
    await capture("before")
    runtime.clock.advance(60_000)
    const since = runtime.clock.now()
    await capture("after")
    const events = (await admin(`/events?since=${since}`)).body.events as { event: string }[]
    expect(events.map((e) => e.event)).toEqual(["after"])
    await runtime.fetch(
      new Request(`${HOST}/s/?compression=gzip-js`, {
        method: "POST",
        body: JSON.stringify({ api_key: TOKEN, event: "$snapshot", properties: {} }),
      }),
    )
    expect((await admin("/recordings")).body).toEqual({ count: 1 })
    expect((await admin("/events?event=$snapshot")).body.events).toEqual([])
  })
})

describe("fault presets", () => {
  test("every catalog preset is registered", () => {
    expect(Object.keys(POSTHOG_PRESETS)).toEqual(
      expect.arrayContaining([
        "flags_5xx",
        "flags_429",
        "flags_hang",
        "errors_while_computing",
        "quota_limited",
      ]),
    )
  })

  const preset = (runtime: PostHogRuntime, name: string) =>
    runtime.applyPreset(name, "default", { count: 10 })

  test("flags_5xx / flags_429: the backend falls back, the strict path is provider_rejected", async () => {
    for (const name of ["flags_5xx", "flags_429"]) {
      const { runtime, admin, fetcher } = harness()
      await admin("/flags/shop-coupons", { default: true })
      preset(runtime, name)
      const adapter = backend(fetcher)
      expect(await adapter.isEnabled("shop-coupons", "1", false)).toBe(false)
      // posthog-node swallows the HTTP error: getFeatureFlag resolves undefined.
      expect(await adapter.resolveStrictBoolean("shop-coupons", "2")).toEqual({
        status: "unresolved",
        reason: "not_a_boolean",
      })
      expect(
        await evaluatePostHogFlag(
          { NEXT_PUBLIC_POSTHOG_KEY: `${TOKEN}-${name}`, NEXT_PUBLIC_POSTHOG_HOST: HOST },
          "shop-coupons",
          { distinctId: "3" },
          fetcher,
        ),
      ).toBeUndefined()
      expect(
        await new MakorPostHogClient(TOKEN, HOST, fetcher).getEvaluation("shop-coupons", "4"),
      ).toBeNull()
    }
  })

  test("flags_hang (>1 s) trips the backend strict race and the EMR 1 s race", async () => {
    const { runtime, admin, fetcher } = harness()
    await admin("/flags/shop-coupons", { default: true })
    await admin("/flags/b2b-member-tagging", { default: true })
    preset(runtime, "flags_hang")
    const adapter = backend(fetcher)
    const emr = track(new EmrFeatureFlagsService(TOKEN, HOST, fetcher))
    const [strict, gate] = await Promise.all([
      adapter.resolveStrictBoolean("shop-coupons", "1"),
      emr.isMemberTaggingProgramEnabled("staff"),
    ])
    // Both races fire at 1 s, before the 1.5 s answer; without the fault both would be true.
    expect(strict).toEqual({ status: "unresolved", reason: "provider_timeout" })
    expect(gate).toBe(false)
  }, 10_000)

  test("errors_while_computing: flags still arrive with errorsWhileComputingFlags true", async () => {
    const { runtime, admin, fetcher } = harness()
    await admin("/flags/shop-coupons", { default: true })
    preset(runtime, "errors_while_computing")
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      expect(await backend(fetcher).getEvaluation("shop-coupons", "1")).toBe(true)
    } finally {
      console.error = original
    }
    expect(String(errors[0])).toContain("Error while computing feature flags")
  })

  test("quota_limited: posthog-node sees no flags; the member app keeps its defaults", async () => {
    const { runtime, admin, fetcher } = harness()
    await admin("/flags/shop-coupons", { default: true })
    preset(runtime, "quota_limited")
    expect(await backend(fetcher).isEnabled("shop-coupons", "1", false)).toBe(false)
    const client = new ReactNativeLikeClient(TOKEN, { host: HOST }, fetcher)
    closers.push(() => client.shutdown())
    const adapter = new MemberAppFlagsAdapter(client)
    await adapter.init()
    expect(adapter.hasFlag("shop-coupons")).toBe(false)
    expect(adapter.isEnabled("shop-coupons", true)).toBe(true)
  })
})

describe("admin: import, bulk, bump; tooling and crons", () => {
  test("POST /__admin/flags/import seeds dev and prod state from state.json", async () => {
    const { admin, fetcher } = harness()
    const dev = await admin(
      "/flags/import?namespace=dev",
      { from: "state.json", env: "dev" },
      "POST",
    )
    const prod = await admin(
      "/flags/import?namespace=prod",
      { from: "state.json", env: "prod" },
      "POST",
    )
    expect(dev.body.imported).toBe(101)
    expect(prod.body.imported).toBeGreaterThan(40)
    await admin("/credentials", { credentials: { phc_dev: "dev", phc_prod: "prod" } })
    const devAdapter = backend(fetcher, HOST, "phc_dev")
    const prodAdapter = backend(fetcher, HOST, "phc_prod")
    // advanced-hormone-pdfs: dev "live", prod "rollout 0".
    expect(await devAdapter.getEvaluation("advanced-hormone-pdfs", "1")).toBe(true)
    expect(await prodAdapter.getEvaluation("advanced-hormone-pdfs", "1")).toBe(false)
    // shop-coupons: dev "live", prod "inactive" (PostHog omits inactive flags).
    expect(await devAdapter.getEvaluation("shop-coupons", "1")).toBe(true)
    expect(await prodAdapter.getEvaluation("shop-coupons", "1")).toBeUndefined()
    // mobile-smart-links: prod "targeted" → off for an untargeted user.
    expect(await prodAdapter.getEvaluation("mobile-smart-links", "1")).toBe(false)
  })

  test("feature-flags-cli pages through the management API and classifies the imported state", async () => {
    const { admin, fetcher } = harness()
    await admin("/credentials", { credentials: { phx_personal: "cli" } })
    await admin("/flags/import?namespace=cli", { env: "dev" }, "POST")
    const flags = await fetchProjectFlags(HOST, 338122, "phx_personal", fetcher)
    expect(flags).toHaveLength(101)
    const states = new Map(flags.map((flag) => [flag.key, deriveState(flag)]))
    expect(states.get("advanced-hormone-pdfs")).toBe("live")
    expect([...states.values()].filter((s) => s === "live")).toHaveLength(94)
    expect([...states.values()].filter((s) => s === "rollout 0")).toHaveLength(7)
  })

  test("management API create/patch with the CLI's fixture filters evaluates deterministically", async () => {
    const { runtime, admin, fetcher } = harness()
    const auth = { authorization: "Bearer phx_personal", "content-type": "application/json" }
    for (const flag of [...page1.results, ...page2.results]) {
      const response = await runtime.fetch(
        new Request(`${HOST}/api/projects/338122/feature_flags/`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ key: flag.key, active: flag.active, filters: flag.filters }),
        }),
      )
      expect(response.status).toBe(201)
    }
    const evaluated = (await admin("/flags/evaluate?distinct_id=anyone")).body.flags
    // live → on; cohort-only → off (cohorts are not modelled); 25 % → off; inactive → absent.
    expect(evaluated).toEqual({
      "sample-live": true,
      "sample-staged": false,
      "sample-ramping": false,
    })
    const listed = await fetchProjectFlags(HOST, 338122, "phx_personal", fetcher)
    expect(listed.map((f) => [f.key, deriveState(f)])).toEqual([
      ["sample-live", "live"],
      ["sample-ramping", "rollout 0"],
      ["sample-retired", "inactive"],
      ["sample-staged", "rollout 0"],
    ])
    const patched = await runtime.fetch(
      new Request(`${HOST}/api/projects/338122/feature_flags/4/`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ active: true, filters: { groups: [{ rollout_percentage: 100 }] } }),
      }),
    )
    expect(patched.status).toBe(200)
    expect((await admin("/flags/evaluate?distinct_id=anyone")).body.flags).toMatchObject({
      "sample-retired": true,
    })
    const duplicate = await runtime.fetch(
      new Request(`${HOST}/api/projects/338122/feature_flags/`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ key: "sample-live" }),
      }),
    )
    expect(duplicate.status).toBe(400)
    expect(((await duplicate.json()) as { code: string }).code).toBe("unique")
    const anonymous = await runtime.fetch(new Request(`${HOST}/api/projects/338122/feature_flags/`))
    expect(anonymous.status).toBe(401)
  })

  test("HogQL: canned results through the cron client; {results: []} by default", async () => {
    const { admin, fetcher } = harness()
    const client = new PostHogHogqlClient(
      { MARKETING_METRICS_POSTHOG_READ_KEY: "phx_read" },
      HOST,
      fetcher,
    )
    expect(await client.query("SELECT 1")).toEqual([])
    await admin("/settings", {
      queryResults: [
        { match: "intake_started", columns: ["day", "n"], results: [["2026-09-19", 12]] },
      ],
    })
    expect(
      await client.query("SELECT day, count() FROM events WHERE event = 'intake_started'"),
    ).toEqual([["2026-09-19", 12]])
  })

  test("bulk PUT replaces, bump is a no-op marker, reset restores the seed", async () => {
    const runtime = createRuntime({
      flags: { seeded: { default: true, payload: null, overrides: [] } },
    })
    const admin = async (path: string, body: unknown, method: string) =>
      (await runtime
        .fetch(new Request(`${HOST}/__admin${path}`, { method, body: JSON.stringify(body) }))
        .then((r) => r.json())) as Record<string, unknown>
    const bulk = await admin(
      "/flags",
      { replace: true, flags: { a: { default: true }, b: {} } },
      "PUT",
    )
    expect((bulk.flags as { key: string }[]).map((f) => f.key)).toEqual(["a", "b"])
    expect((await admin("/flags/bump", {}, "POST")).generation).toBe(1)
    expect((await admin("/flags/bump", {}, "POST")).generation).toBe(2)
    await admin("/reset", {}, "POST")
    const after = (await runtime
      .fetch(new Request(`${HOST}/__admin/flags`))
      .then((r) => r.json())) as {
      flags: { key: string }[]
    }
    expect(after.flags.map((f) => f.key)).toEqual(["seeded"])
    const bad = await runtime.fetch(
      new Request(`${HOST}/__admin/flags/x`, {
        method: "PUT",
        body: JSON.stringify({ default: 3 }),
      }),
    )
    expect(bad.status).toBe(400)
  })
})

describe("served over HTTP", () => {
  test("posthog-node against the node server: /ns/<name> host, gzip batch, and a real 1 s timeout", async () => {
    const server = await createServer()
    try {
      const admin = (path: string, body: unknown, method = "PUT") =>
        fetch(`${server.url}/__admin${path}`, { method, body: JSON.stringify(body) })
      await admin("/flags/shop-coupons?namespace=w1", { default: true })
      const adapter = new PostHogServerAdapter({
        POSTHOG_API_KEY: TOKEN,
        POSTHOG_HOST: `${server.url}/ns/w1`,
      })
      const tracking = new PostHogTrackingService({
        POSTHOG_API_KEY: TOKEN,
        POSTHOG_HOST: `${server.url}/ns/w1`,
      })
      try {
        expect(await adapter.isStrictBooleanEnabled("shop-coupons", "1")).toBe(true)
        tracking.track("1", "served_event")
        await tracking.flush()
        const events = (await (
          await fetch(`${server.url}/__admin/events?namespace=w1`)
        ).json()) as {
          events: { event: string }[]
        }
        expect(events.events.map((e) => e.event)).toContain("served_event")
        await admin("/faults?namespace=w1", { preset: "flags_hang", count: 1 }, "POST")
        expect(await adapter.resolveStrictBoolean("shop-coupons", "2")).toEqual({
          status: "unresolved",
          reason: "provider_timeout",
        })
        const health = await fetch(`${server.url}/health`)
        expect(health.headers.get("x-mockingbird")).toMatch(/^posthog@/)
      } finally {
        await adapter.onModuleDestroy()
        await tracking.onModuleDestroy()
      }
    } finally {
      await server.close()
    }
  }, 15_000)
})
