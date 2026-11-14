import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

// Best guess from the vendor's published v2 OpenAPI (not oracle-verified):
// https://docs.firstpromoter.com/api-reference-v2/api-advanced/campaigns-api/openapi-v2-campaigns.json
// https://docs.firstpromoter.com/api-reference-v2/api-advanced/rewards/openapi-v2-rewards.json

type Campaign = {
  id: number
  name: string
  color: string
  is_default: boolean
  landing_url: string
  ref_token_param: string
  stats: {
    promoters_count: number
    referrals_count: number
    customers_count: number
    sales_count: number
    revenue_amount: number
  }
  rewards_for_promoters: { reward_id: number }[]
  rewards_for_referrals: { reward_id: number; reward: { coupon: string | null } }[]
}
type Reward = {
  id: number
  name: string
  is_promoter_reward: boolean
  coupon: string | null
  schemas: { unit: string; amount: number; flat_amount: boolean; rules: unknown[] }[]
}

const harness = () => {
  const runtime = createRuntime()
  const send = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.auth === false ? {} : { authorization: "Bearer fixture", "account-id": "acc" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  return { runtime, send }
}

describe("GET /v2/company/campaigns (best guess, not oracle-verified)", () => {
  test("lists the configured campaigns as a bare array with rewards, default flag and live stats", async () => {
    const { send } = harness()
    const created = (await (
      await send("/v2/company/promoters", { body: { email: "ada@example.test" } })
    ).json()) as { id: number }
    expect(
      (
        await send("/v2/track/signup", {
          body: { email: "lead@example.test", promoter_id: created.id },
        })
      ).status,
    ).toBe(200)
    const response = await send("/v2/company/campaigns")
    expect(response.status).toBe(200)
    const campaigns = (await response.json()) as Campaign[]
    expect(campaigns.map((c) => [c.id, c.name, c.is_default])).toEqual([
      [1, "Acme Referral Program", true],
      [2, "Partner Program", false],
    ])
    const [acme] = campaigns
    expect(acme?.landing_url).toBe("https://acme.example/referrals")
    expect(acme?.ref_token_param).toBe("fpr")
    expect(acme?.stats).toEqual({
      promoters_count: 1,
      referrals_count: 1,
      customers_count: 1,
      sales_count: 0,
      revenue_amount: 0,
    })
    expect(acme?.rewards_for_referrals[0]?.reward.coupon).toBe("ACME50")
    expect(acme?.rewards_for_promoters.map((r) => r.reward_id)).toEqual([12])
    expect(campaigns[1]?.stats.promoters_count).toBe(0)
  })

  test("needs the Bearer key and Account-ID like every v2 call", async () => {
    const { send } = harness()
    expect((await send("/v2/company/campaigns", { auth: false })).status).toBe(401)
  })
})

describe("GET /v2/company/rewards (best guess, not oracle-verified)", () => {
  test("lists every campaign reward; scope=promoters and scope=referrals filter by side", async () => {
    const { send } = harness()
    const all = (await (await send("/v2/company/rewards")).json()) as Reward[]
    expect(all.map((r) => [r.id, r.is_promoter_reward])).toEqual([
      [11, false],
      [12, true],
    ])
    const promoters = (await (await send("/v2/company/rewards?scope=promoters")).json()) as Reward[]
    expect(promoters).toEqual([
      expect.objectContaining({
        id: 12,
        name: "10% commission",
        is_promoter_reward: true,
        coupon: null,
        schemas: [{ unit: "cash", amount: 10, flat_amount: false, rules: [] }],
      }),
    ])
    const referrals = (await (await send("/v2/company/rewards?scope=referrals")).json()) as Reward[]
    expect(referrals).toEqual([
      expect.objectContaining({
        id: 11,
        is_promoter_reward: false,
        coupon: "ACME50",
        schemas: [{ unit: "cash", amount: 50, flat_amount: true, rules: [] }],
      }),
    ])
  })

  test("an unknown scope is 422 {message, code}", async () => {
    const { send } = harness()
    const response = await send("/v2/company/rewards?scope=everyone")
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      message: "scope must be one of promoters, referrals",
      code: "invalid_params",
    })
  })
})
