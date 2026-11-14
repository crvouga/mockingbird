import { jsonRes } from "@crvouga/mockingbird-service"
import type { Campaign, CampaignReward, FirstPromoterState } from "./state.js"

/**
 * `GET /v2/company/campaigns` and `GET /v2/company/rewards`: the configured campaigns and their
 * rewards in the shapes of the vendor's published v2 OpenAPI (`api-advanced/campaigns-api`,
 * `api-advanced/rewards`). Best guess, not oracle-verified: account-level campaign settings the
 * emulator has no state for (cookie life, approval flags, links) are fixed defaults.
 */

/** The `created_at` / `updated_at` of seeded rewards: they exist before any request. */
const SEEDED_AT = "2024-01-01T00:00:00.000Z"

/** Campaign stats derived from stored promoters, referrals and sales. */
const stats = (state: FirstPromoterState, campaign: Campaign) => {
  const referrals = state.referrals
    .list({ where: (row) => row.campaign_id === campaign.id })
    .map((row) => row.value)
  const ids = new Set(referrals.map((r) => r.id))
  const sales = state.sales.list({ where: (row) => ids.has(row.referral_id) }).map((r) => r.value)
  return {
    referrals_count: referrals.length,
    sales_count: sales.length,
    customers_count: referrals.filter((r) => r.customer_since !== null).length,
    promoters_count: state
      .all()
      .filter(
        (p) => p.state !== "archived" && p.campaigns.some((c) => c.campaign_id === campaign.id),
      ).length,
    revenue_amount: sales.reduce((sum, sale) => sum + sale.sale_amount, 0),
  }
}

export const listCampaigns = (
  state: FirstPromoterState,
  query: URLSearchParams,
  rewardJson: (reward: CampaignReward) => unknown,
): Response => {
  const settings = state.current()
  const page = Math.max(1, Math.floor(Number(query.get("page")) || 1))
  const size = Math.min(50, Math.max(1, Math.floor(Number(query.get("per_page")) || 10)))
  return jsonRes(
    200,
    settings.campaigns.slice((page - 1) * size, page * size).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      color: campaign.color,
      stats: stats(state, campaign),
      landing_url: settings.website,
      visitor_cookie_life: 60,
      ref_token_param: "fpr",
      auto_approve_leads: true,
      track_ad_traffic: "allow",
      auto_approve_promoters: true,
      is_private: false,
      is_default: campaign.id === settings.defaultCampaignId,
      upgrade_details: null,
      signup_url: null,
      links: [],
      rewards_for_promoters: campaign.promoterRewards.map(rewardJson),
      rewards_for_referrals: campaign.referralRewards.map(rewardJson),
    })),
  )
}

const SCOPES = ["promoters", "referrals"] as const

export const listRewards = (state: FirstPromoterState, query: URLSearchParams): Response => {
  const scope = query.get("scope")
  if (scope !== null && !SCOPES.includes(scope as (typeof SCOPES)[number]))
    return jsonRes(422, {
      message: `scope must be one of ${SCOPES.join(", ")}`,
      code: "invalid_params",
    })
  const render = (reward: CampaignReward, promoter: boolean) => ({
    id: reward.reward_id,
    name: reward.name,
    is_promoter_reward: promoter,
    promoter_reward_type: promoter ? "sale" : null,
    coupon: reward.coupon,
    editable: true,
    hide_reward: false,
    provider_coupon_id: null,
    duration: promoter ? null : "once",
    duration_in_months: null,
    max_redemptions: null,
    new_customers_only: false,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
    provider: promoter ? null : "stripe",
    tier_reward_mode: null,
    tier_level: null,
    schemas: [
      {
        unit: reward.per_of_sale !== null ? "cash" : (reward.unit ?? "cash"),
        amount: reward.per_of_sale ?? reward.amount ?? 0,
        flat_amount: reward.per_of_sale === null,
        rules: [],
      },
    ],
  })
  const seen = new Map<number, ReturnType<typeof render>>()
  for (const campaign of state.current().campaigns) {
    if (scope !== "promoters")
      for (const reward of campaign.referralRewards)
        if (!seen.has(reward.reward_id)) seen.set(reward.reward_id, render(reward, false))
    if (scope !== "referrals")
      for (const reward of campaign.promoterRewards)
        if (!seen.has(reward.reward_id)) seen.set(reward.reward_id, render(reward, true))
  }
  return jsonRes(
    200,
    [...seen.values()].sort((a, b) => a.id - b.id),
  )
}
