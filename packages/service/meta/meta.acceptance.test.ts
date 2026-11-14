import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, META_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type ConversionEvent,
  type Fetch,
  getMarketingObject,
  listInsights,
  MetaGraphError,
  sendConversionEvents,
} from "./test/consumer.js"

const API = "http://meta.mock"
const TOKEN = "meta_test_token"
const NOW = Date.UTC(2026, 0, 4, 12) / 1000
const HASH = "a".repeat(64)

const event = (patch: Partial<ConversionEvent> = {}): ConversionEvent => ({
  event_name: "Purchase",
  event_time: NOW,
  event_id: "order_42",
  action_source: "website",
  event_source_url: "https://example.test/checkout",
  user_data: { em: [HASH], external_id: [HASH], fbc: "fb.1.1760000000000.synthetic" },
  custom_data: { currency: "USD", value: 42 },
  ...patch,
})

const harness = () => {
  const runtime = createRuntime({ clock: createClock(() => NOW * 1000) })
  const fetchImpl = (input: string, init?: RequestInit) => runtime.fetch(new Request(input, init))
  const send = (events: ConversionEvent[], accessToken = TOKEN) =>
    sendConversionEvents({
      baseUrl: API,
      pixelId: "pixel_mockingbird",
      accessToken,
      events,
      testEventCode: "TEST42",
      fetchImpl,
    })
  return { runtime, fetchImpl, send }
}

describe("Meta acceptance", () => {
  test("CAPI preserves the Geviti event contract and deduplicates event_id", async () => {
    const { runtime, send } = harness()
    expect(await send([event()])).toMatchObject({ events_received: 1, messages: [] })
    expect(await send([event()])).toMatchObject({ events_received: 1, messages: [] })
    expect(runtime.instance().events()).toHaveLength(1)
    expect(runtime.instance().events()[0]).toMatchObject({
      pixelId: "pixel_mockingbird",
      event_name: "Purchase",
      event_id: "order_42",
      action_source: "website",
      user_data: { em: [HASH], fbc: "fb.1.1760000000000.synthetic" },
      custom_data: { currency: "USD", value: 42 },
      test_event_code: "TEST42",
    })
  })

  test("event age, hashes, auth, rate limits, and partial batches use Graph envelopes", async () => {
    const { runtime, send } = harness()
    await expect(send([event({ event_time: NOW - 604_801 })])).rejects.toMatchObject({
      status: 400,
      code: 100,
    })
    await expect(send([event({ user_data: { em: ["not-hashed"] } })])).rejects.toBeInstanceOf(
      MetaGraphError,
    )
    await runtime.fetch(
      new Request(`${API}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessTokens: [TOKEN] }),
      }),
    )
    await expect(send([event()], "wrong")).rejects.toMatchObject({ status: 401, code: 190 })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    await expect(send([event({ event_id: "limited" })])).rejects.toMatchObject({
      status: 429,
      transient: true,
    })
    runtime.applyPreset("partial_event_acceptance", "default", { count: 1 })
    const partial = await send([event({ event_id: "first" }), event({ event_id: "second" })])
    expect(partial.events_received).toBe(1)
    expect(partial.messages).toHaveLength(1)
  })

  test("ambiguous timeout persists once and retry deduplicates", async () => {
    const { runtime, send } = harness()
    runtime.applyPreset("accepted_then_drop", "default", { count: 1 })
    await expect(send([event()])).rejects.toBeInstanceOf(TypeError)
    expect(runtime.instance().events()).toHaveLength(1)
    await send([event()])
    expect(runtime.instance().events()).toHaveLength(1)
  })

  test("insights filter inclusively, paginate, and include requested breakdowns", async () => {
    const { fetchImpl } = harness()
    const first = await listInsights({
      baseUrl: API,
      accountId: "act_mockingbird",
      accessToken: TOKEN,
      since: "2026-01-01",
      until: "2026-01-03",
      limit: 2,
      breakdowns: ["country"],
      fetchImpl,
    })
    expect(first.data).toHaveLength(2)
    expect(first.data[0]).toMatchObject({ date_start: "2026-01-01", country: "US" })
    expect(first.paging.next).toContain("after=2")
    const second = await listInsights({
      baseUrl: API,
      accountId: "act_mockingbird",
      accessToken: TOKEN,
      since: "2026-01-01",
      until: "2026-01-03",
      limit: 2,
      after: first.paging.cursors.after,
      fetchImpl,
    })
    expect(second.data.map((row) => row.date_start)).toEqual(["2026-01-03"])
  })

  // Issue #764: the remaining Insights parameters and rate-limit envelopes. Best guess from
  // Meta's Insights and Graph error documentation, not oracle-verified.
  const insights = async (fetchImpl: Fetch, query: Record<string, string>) => {
    const response = await fetchImpl(
      `${API}/v26.0/act_mockingbird/insights?${new URLSearchParams({ access_token: TOKEN, ...query })}`,
    )
    return {
      status: response.status,
      body: (await response.json()) as {
        data: Array<Record<string, unknown>>
        paging: { cursors: { after: string }; next?: string }
        error?: { code: number; type: string }
      },
    }
  }
  const window = JSON.stringify({ since: "2026-01-01", until: "2026-01-03" })

  test("insights roll up by level and time_increment and return only the requested fields", async () => {
    const { fetchImpl } = harness()
    const total = await insights(fetchImpl, {
      level: "account",
      time_increment: "all_days",
      time_range: window,
      fields: "account_id,spend,impressions,actions,website_purchase_roas",
    })
    expect(total.status).toBe(200)
    expect(total.body.data).toEqual([
      {
        account_id: "act_mockingbird",
        spend: "75",
        impressions: "600",
        actions: [{ action_type: "purchase", value: "6" }],
        website_purchase_roas: [{ action_type: "purchase", value: "4" }],
        date_start: "2026-01-01",
        date_stop: "2026-01-03",
      },
    ])
    const twoDay = await insights(fetchImpl, {
      level: "ad",
      time_increment: "2",
      time_range: window,
      fields: "ad_id,ad_name,adset_id,clicks",
    })
    expect(twoDay.body.data).toEqual([
      {
        adset_id: "set_mockingbird",
        ad_id: "ad_mockingbird",
        ad_name: "Synthetic creative",
        date_start: "2026-01-01",
        date_stop: "2026-01-02",
        clicks: "30",
      },
      {
        adset_id: "set_mockingbird",
        ad_id: "ad_mockingbird",
        ad_name: "Synthetic creative",
        date_start: "2026-01-03",
        date_stop: "2026-01-03",
        clicks: "30",
      },
    ])
    const daily = await insights(fetchImpl, {
      level: "campaign",
      time_increment: "1",
      time_range: window,
      fields: "campaign_id,spend",
      limit: "1",
    })
    expect(daily.body.data).toEqual([
      {
        campaign_id: "cmp_mockingbird",
        spend: "12.5",
        date_start: "2026-01-01",
        date_stop: "2026-01-01",
      },
    ])
    expect(daily.body.paging.cursors.after).toBe("1")
    expect(daily.body.paging.next).toContain("after=1")
    expect(daily.body.paging.next).toContain("time_increment=1")
  })

  test("invalid level, time_increment and fields answer Graph error 100", async () => {
    const { fetchImpl } = harness()
    for (const query of [
      { level: "creative" },
      { time_increment: "91" },
      { fields: "spend,reach" },
    ]) {
      const result = await insights(fetchImpl, query)
      expect(result.status).toBe(400)
      expect(result.body.error).toMatchObject({ code: 100 })
    }
  })

  test("CAPI rejects an event without event_time or user_data", async () => {
    const { runtime, send } = harness()
    const { event_time: _time, ...noTime } = event({ event_id: "no_time" })
    const { user_data: _user, ...noUser } = event({ event_id: "no_user" })
    for (const invalid of [noTime, noUser]) {
      await expect(send([invalid as ConversionEvent])).rejects.toMatchObject({
        status: 400,
        code: 100,
      })
    }
    expect(runtime.instance().events()).toHaveLength(0)
  })

  test("rate-limit presets answer codes 17 and 80004 and an expired token carries its subcode", async () => {
    const { runtime, fetchImpl } = harness()
    const read = async () =>
      (await (await fetchImpl(`${API}/v26.0/cmp_mockingbird?access_token=${TOKEN}`)).json()) as {
        error: Record<string, unknown>
      }
    runtime.applyPreset("user_request_limit", "default", { count: 1 })
    expect((await read()).error).toMatchObject({
      type: "OAuthException",
      code: 17,
      error_subcode: 2446079,
      fbtrace_id: expect.any(String),
    })
    runtime.applyPreset("ad_account_rate_limit", "default", { count: 1 })
    expect((await read()).error).toMatchObject({ code: 80004, error_subcode: 2446079 })
    runtime.applyPreset("expired_token", "default", { count: 1 })
    expect((await read()).error).toMatchObject({
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
    })
  })

  test("campaign reads and namespaces are isolated", async () => {
    const { runtime, fetchImpl, send } = harness()
    expect(
      await getMarketingObject({
        baseUrl: API,
        id: "cmp_mockingbird",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).toMatchObject({ id: "cmp_mockingbird", status: "ACTIVE" })
    const namespaced = (namespace: string, id: string) =>
      runtime.fetch(
        new Request(`${API}/v26.0/pixel_mockingbird/events?access_token=${TOKEN}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
          body: JSON.stringify({ data: [event({ event_id: id })] }),
        }),
      )
    await namespaced("a", "a1")
    await namespaced("b", "b1")
    expect(
      runtime
        .instance("a")
        .events()
        .map((entry) => entry.event_id),
    ).toEqual(["a1"])
    expect(
      runtime
        .instance("b")
        .events()
        .map((entry) => entry.event_id),
    ).toEqual(["b1"])
    expect(runtime.instance().events()).toHaveLength(0)
    await send([event({ event_id: "default" })])
    expect(runtime.instance().events()).toHaveLength(1)
  })

  test("presets are registered and the served Node adapter accepts plain fetch", async () => {
    expect(Object.keys(META_PRESETS)).toEqual(
      expect.arrayContaining([
        "expired_token",
        "rate_limited",
        "server_error",
        "accepted_then_drop",
        "user_request_limit",
        "ad_account_rate_limit",
      ]),
    )
    const server = await createServer({ clock: createClock(() => NOW * 1000) })
    try {
      const response = await sendConversionEvents({
        baseUrl: server.url,
        pixelId: "pixel_mockingbird",
        accessToken: TOKEN,
        events: [event()],
        fetchImpl: fetch,
      })
      expect(response.events_received).toBe(1)
      expect((await fetch(`${server.url}/__admin/health`)).headers.get("x-mockingbird")).toMatch(
        /^meta@/,
      )
    } finally {
      await server.close()
    }
  })
})
