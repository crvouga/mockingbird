import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const harness = () => {
  const runtime = createRuntime({ settings: { autoConvert: false } })
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (
    path: string,
    body?: unknown,
    namespace = "default",
    auth = true,
    method?: string,
  ) =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          "x-mockingbird-namespace": namespace,
          ...(auth ? { authorization: "Bearer fixture", "account-id": "fixture" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const json = async (path: string, body?: unknown, status = 200, method?: string) => {
    const response = await send(path, body, "default", true, method)
    expect(response.status).toBe(status)
    return response.json()
  }
  const seed = async () => {
    const promoter = (await json("/v2/company/promoters", {
      email: "sale-promoter@example.test",
    })) as { id: number; promoter_campaigns: { id: number; ref_token: string }[] }
    const referral = (await json("/v2/track/signup", {
      email: "sale-customer@example.test",
      uid: "sale-customer",
      promoter_id: promoter.id,
    })) as { id: number }
    return { promoter, referral }
  }
  return { runtime, send, json, seed }
}

describe("FirstPromoter sale tracking", () => {
  test("sale attributes minor-unit revenue and a commission to the existing referral", async () => {
    const { runtime, json, seed } = harness()
    const { promoter, referral } = await seed()
    runtime.clock.advance(2000)
    const sale = (await json("/v2/track/sale", {
      event_id: "sale-one",
      amount: 1000,
      currency: "USD",
      uid: "sale-customer",
      skip_email_notification: true,
    })) as { commissions: { id: number; amount: number }[] }
    expect(sale).toMatchObject({
      etype: "sale",
      event_id: "sale-one",
      sale_amount: 1000,
      original_sale_amount: 1000,
      original_sale_currency: "USD",
      created_at: "2026-10-04T12:00:02.000Z",
      referral: { id: referral.id, email: "sale-customer@example.test", uid: "sale-customer" },
      commissions: [
        {
          status: "approved",
          amount: 100,
          unit: "cash",
          sale_amount: 1000,
          event_id: "sale-one",
          promoter_campaign: { promoter_id: promoter.id },
        },
      ],
    })
    expect(await json("/v2/company/commissions")).toEqual(sale.commissions)
    expect(await json(`/v2/company/referrals/${referral.id}`)).toMatchObject({
      state: "active",
      customer_since: "2026-10-04T12:00:02.000Z",
    })
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({
      earnings_cash: 100,
      customers: 1,
    })
    const events = (await json("/__admin/webhooks/events")) as { events: unknown[] }
    expect(events.events).toHaveLength(1)
  })

  test("same event ID yields the documented conflict without a second commission, credit or webhook", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    const body = { event_id: "sale-replay", amount: 1000, email: "sale-customer@example.test" }
    await json("/v2/track/sale", body)
    const before = runtime.instance("default").state.byId(promoter.id)
    const response = await send("/v2/track/sale", { ...body, amount: 2000 })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      message: "The 'sale' event with the id 'sale-replay' already exists.",
    })
    expect(runtime.instance("default").state.byId(promoter.id)).toEqual(before)
    expect(await json("/v2/company/commissions")).toHaveLength(1)
    expect(((await json("/__admin/webhooks/events")) as { events: unknown[] }).events).toHaveLength(
      1,
    )
    await json("/v2/track/sale", { ...body, event_id: "sale-renewal" })
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({
      customers: 1,
      earnings_cash: 200,
    })
  })

  test("unknown attribution, validation and HTTP faults do not record a sale or alter its referral", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    const body = { event_id: "sale-retry", amount: 1000, uid: "sale-customer" }
    const before = runtime.instance("default").state.byId(promoter.id)
    for (const extra of [
      { uid: "unknown" },
      { ref_id: "unknown" },
      { tid: "unknown" },
      { promo_code: "unknown" },
    ]) {
      const response = await send("/v2/track/sale", { ...body, ...extra })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message:
          "Referral corresponding to email or uid parameter not found or promoter is banned.",
        code: "not_found",
      })
    }
    expect((await send("/v2/track/sale", { ...body, amount: -1 })).status).toBe(400)
    expect((await send("/v2/track/sale", body, "default", false)).status).toBe(401)
    for (const [preset, status] of [
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await send("/v2/track/sale", body)).status).toBe(status)
    }
    expect(runtime.instance("default").state.byId(promoter.id)).toEqual(before)
    expect(await json("/v2/company/commissions")).toEqual([])
    await json("/v2/track/sale", body)
    expect(await json("/v2/company/commissions")).toHaveLength(1)
  })

  test("valid seeded promo codes share attribution; namespaces, reset and snapshots include deduplication", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    await json(
      "/__admin/promo-codes",
      { promo_code: "FIXTURE-CODE", promoter_campaign_id: promoter.promoter_campaigns[0]?.id },
      201,
    )
    const snapshot = (await json("/__admin/snapshots", {}, 201)) as { id: string }
    const body = {
      event_id: "sale-snapshot",
      amount: 1230,
      uid: "sale-customer",
      promo_code: "FIXTURE-CODE",
    }
    const sale = await json("/v2/track/sale", body)
    expect((await send("/v2/track/sale", body, "other")).status).toBe(404)
    await json(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await json("/v2/company/commissions")).toEqual([])
    expect(await json("/v2/track/sale", body)).toEqual(sale)
    await json("/__admin/reset", {})
    const next = await seed()
    await json("/v2/track/sale", { ...body, promo_code: undefined })
    expect(runtime.instance("default").state.byId(next.promoter.id)).toMatchObject({
      earnings_cash: 123,
    })
  })

  test("tid creates the lead and assigns the sale in one step", async () => {
    const { runtime, json, send } = harness()
    const promoter = (await json("/__admin/promoters", { email: "tid@example.test" }, 201)) as {
      id: number
      promoter_campaigns: { ref_token: string }[]
    }
    const click = (await json(
      "/__admin/clicks",
      { ref_token: promoter.promoter_campaigns[0]?.ref_token },
      201,
    )) as { tid: string }
    const body = {
      event_id: "one-step-tid",
      amount: 2000,
      email: "buyer@example.test",
      tid: click.tid,
    }
    const sale = (await json("/v2/track/sale", body)) as {
      referral: { id: number; email: string; uid: string | null }
      commissions: { amount: number; promoter_campaign: { promoter_id: number } }[]
    }
    expect(sale.referral).toMatchObject({ email: "buyer@example.test", uid: null })
    expect(sale.commissions).toMatchObject([
      { amount: 200, promoter_campaign: { promoter_id: promoter.id } },
    ])
    expect(await json(`/v2/company/referrals/${sale.referral.id}`)).toMatchObject({
      state: "active",
      entry_source: "cookie",
      promoter_campaign: { promoter_id: promoter.id },
    })
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({
      referrals: 1,
      customers: 1,
      earnings_cash: 200,
    })
    expect(((await json("/__admin/webhooks/events")) as { events: unknown[] }).events).toHaveLength(
      1,
    )
    // The lead exists now, so a renewal needs no attribution and signup tracking sees it taken.
    await json("/v2/track/sale", { event_id: "renewal", amount: 1000, email: "buyer@example.test" })
    const retake = await send("/v2/track/signup", { email: "buyer@example.test", tid: click.tid })
    expect(retake.status).toBe(422)
  })

  test("ref_id creates the lead and assigns the sale in one step; unresolvable attribution does not", async () => {
    const { json, send } = harness()
    const promoter = (await json("/__admin/promoters", { email: "ref@example.test" }, 201)) as {
      id: number
      promoter_campaigns: { ref_token: string }[]
    }
    const refId = promoter.promoter_campaigns[0]?.ref_token
    for (const extra of [{ ref_id: "unknown" }, { tid: "unknown" }, {}]) {
      const response = await send("/v2/track/sale", {
        event_id: "ref-fail",
        amount: 500,
        email: "ref-buyer@example.test",
        ...extra,
      })
      expect(response.status).toBe(404)
    }
    expect(await json("/v2/company/referrals")).toEqual([])
    // Naming the lead needs an email; a uid alone cannot create one.
    expect(
      (await send("/v2/track/sale", { event_id: "ref-fail", amount: 500, uid: "x", ref_id: refId }))
        .status,
    ).toBe(404)
    const sale = (await json("/v2/track/sale", {
      event_id: "ref-ok",
      amount: 500,
      email: "ref-buyer@example.test",
      ref_id: refId,
    })) as { referral: { email: string }; commissions: unknown[] }
    expect(sale.referral.email).toBe("ref-buyer@example.test")
    expect(sale.commissions).toHaveLength(1)
    expect(await json("/v2/company/referrals")).toHaveLength(1)
  })

  test("promo_code creates the lead only when promoCodeCreatesReferral is enabled", async () => {
    const { runtime, json, send } = harness()
    const promoter = (await json("/__admin/promoters", { email: "promo@example.test" }, 201)) as {
      id: number
      promoter_campaigns: { id: number }[]
    }
    await json(
      "/__admin/promo-codes",
      { promo_code: "SYNTH10", promoter_campaign_id: promoter.promoter_campaigns[0]?.id },
      201,
    )
    const body = {
      event_id: "promo-one-step",
      amount: 1000,
      email: "promo-buyer@example.test",
      promo_code: "SYNTH10",
    }
    // Best guess, not oracle-verified: off by default, an explicit opt-in.
    expect(await json("/__admin/settings")).toMatchObject({ promoCodeCreatesReferral: false })
    const refused = await send("/v2/track/sale", body)
    expect(refused.status).toBe(404)
    expect(await json("/v2/company/referrals")).toEqual([])
    expect(runtime.instance("default").state.sales.has("promo-one-step")).toBe(false)
    await json("/__admin/settings", { promoCodeCreatesReferral: true }, 200, "PUT")
    expect(await json("/__admin/settings")).toMatchObject({ promoCodeCreatesReferral: true })
    expect((await send("/v2/track/sale", { ...body, promo_code: "UNSEEDED" })).status).toBe(404)
    const sale = (await json("/v2/track/sale", body)) as {
      referral: { email: string }
      commissions: { promoter_campaign: { promoter_id: number } }[]
    }
    expect(sale.referral.email).toBe("promo-buyer@example.test")
    expect(sale.commissions[0]?.promoter_campaign.promoter_id).toBe(promoter.id)
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({ referrals: 1 })
  })

  test("served raw-fetch client tracks, lists and rejects replay with namespace-preserving URLs", async () => {
    const server = await createServer({ settings: { autoConvert: false } })
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${server.url}/__admin/ns/sales${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer fixture",
            "account-id": "fixture",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      const promoterResponse = await post("/v2/company/promoters", {
        email: "served-promoter@example.test",
      })
      expect(promoterResponse.status).toBe(200)
      const promoter = (await promoterResponse.json()) as { id: number }
      expect(
        (
          await post("/v2/track/signup", {
            email: "served-customer@example.test",
            promoter_id: promoter.id,
          })
        ).status,
      ).toBe(200)
      const body = { email: "served-customer@example.test", event_id: "served-sale", amount: 1000 }
      const sale = await post("/v2/track/sale", body)
      expect(sale.status).toBe(200)
      expect(await sale.json()).toMatchObject({ commissions: [{ amount: 100 }] })
      expect((await post("/v2/track/sale", body)).status).toBe(409)
      expect(server.runtime.instance("default").state.commissions.count()).toBe(0)
      expect(server.runtime.instance("sales").state.commissions.count()).toBe(1)
    } finally {
      await server.close()
    }
  })
})
