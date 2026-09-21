import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CampaignReward,
  FirstPromoterState,
  type PromoterRecord,
  type ReferralRecord,
  type Settings,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  Campaign,
  CampaignReward,
  ClickRecord,
  PromoterRecord,
  ReferralRecord,
  Settings,
} from "./state.js"
export { DEFAULT_CAMPAIGNS, DEFAULT_SETTINGS } from "./state.js"

export const FIRSTPROMOTER_NAMESPACE = "firstpromoter"

/**
 * The webhook FirstPromoter posts when a referred lead becomes a paying customer. Our receiver
 * (`POST /users/webhooks/first-promoter`, Basic auth) processes only this type.
 */
export type LeadBecomesReferralWebhook = {
  event: { id: number; type: "lead_becomes_referral"; created_at: string }
  data: {
    id: number
    state: string
    email: string
    customer_since: string | null
    promotion: {
      id: number
      promoter_id: number
      ref_id: string
      leads_count: number
      customers_count: number
      current_referral_reward: {
        id: number
        amount: number
        type: string
        unit: string
        name: string
        per_of_sale: number
        default_promo_code: string
      } | null
    }
    promoter: {
      id: number
      cust_id: string | null
      email: string
      earnings_balance: { cash: number }
    }
  }
}

export type FirstPromoterAPIOptions = APIOptions & {
  /** Initial per-namespace settings (campaigns, website, autoConvert). */
  settings?: Partial<Settings>
  /** Called for every webhook-worthy event; the runtime signs and delivers it. */
  onWebhook?: (event: LeadBecomesReferralWebhook) => void
}

const error = (status: number, message: string) => jsonRes(status, { message })

const unprocessable = (errors: Record<string, string[]>) =>
  jsonRes(422, { message: "Validation failed", errors })

type Json = Record<string, unknown>

const record = (context: OperationContext): Json => {
  if (context.body.kind !== "json" || typeof context.body.value !== "object" || !context.body.value)
    throw new HttpError(422, {
      message: "Validation failed",
      errors: { base: ["request body must be a JSON object"] },
    })
  return context.body.value as Json
}

/** FirstPromoter-style field errors from the contract's validation issues. */
const validation = (context: OperationContext): Response | undefined => {
  const issues = bodyIssues(context)
  if (issues.length === 0) return undefined
  const errors: Record<string, string[]> = {}
  for (const issue of issues) {
    const missing = /^missing required property (.+)$/.exec(issue.message)
    const field = missing
      ? [issue.path, missing[1]].filter(Boolean).join(".")
      : issue.path || "base"
    const message = missing ? "can't be blank" : "is invalid"
    errors[field] = [...(errors[field] ?? []), message]
  }
  return unprocessable(errors)
}

const rewardJson = (reward: CampaignReward) => ({
  apply_on: reward.apply_on,
  product_ids: null,
  reward_id: reward.reward_id,
  reward: {
    name: reward.name,
    promoter_reward_type: "per_referral",
    hide_reward: false,
    tier_level: null,
    coupon: reward.coupon,
    amount: reward.amount,
    unit: reward.unit,
    reward_value: reward.amount ?? reward.per_of_sale,
    reward_unit: reward.per_of_sale !== null ? "percent" : reward.unit,
  },
  products: null,
})

/**
 * Stateful mock of FirstPromoter's v2 company API. Promoters join the default campaign on
 * creation (so they have a `ref_link`), tracked signups attribute to a promoter by click
 * `tid`, `promoter_id` or ref token, and conversions emit `lead_becomes_referral`.
 */
export class FirstPromoterAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: FirstPromoterState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: LeadBecomesReferralWebhook) => void) | undefined

  constructor(options: FirstPromoterAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FIRSTPROMOTER_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new FirstPromoterState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      TrackSignup: (context) => this.trackSignup(context),
      ListPromoters: (context) => this.listPromoters(context),
      CreatePromoter: (context) => this.createPromoter(context),
      ArchivePromoters: (context) => this.archivePromoters(context),
      GetPromoter: (context) => this.getPromoter(context),
      UpdatePromoter: (context) => this.updatePromoter(context),
      IframeLogin: (context) => this.iframeLogin(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "Not found"),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        if (!bearerToken(context.request)) return error(401, "Unauthorized")
        if (!context.request.headers.get("account-id")?.trim()) {
          return error(401, "Account-ID header is required")
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** The promoter as `GET /v2/company/promoters/{id}` renders it (FirstPromoterV2ResponseSchema). */
  render(promoter: PromoterRecord, options: { noCampaign?: boolean } = {}) {
    const settings = this.state.current()
    const name = [promoter.first_name, promoter.last_name].filter(Boolean).join(" ")
    return {
      id: promoter.id,
      email: promoter.email,
      name: name || promoter.email,
      cust_id: promoter.cust_id,
      note: promoter.note,
      state: promoter.state,
      stats: {
        clicks_count: promoter.clicks,
        referrals_count: promoter.referrals,
        sales_count: promoter.customers,
        customers_count: promoter.customers,
        revenue_amount: 0,
        active_customers_count: promoter.customers,
      },
      is_customized: false,
      fraud_suspicions: [],
      is_confirmed: true,
      invoice_details_status: "pending",
      profile: {
        id: promoter.id + 1_000_000,
        first_name: promoter.first_name,
        last_name: promoter.last_name,
        website: null,
        company_name: null,
        company_number: null,
        phone_number: null,
        vat_id: null,
        country: null,
        address: null,
        avatar: null,
        w8_form_url: null,
        w9_form_url: null,
        description: null,
      },
      joined_at: promoter.created_at,
      last_login_at: null,
      archived_at: promoter.archived_at,
      custom_fields: null,
      password_setup_url: null,
      created_at: promoter.created_at,
      updated_at: promoter.updated_at,
      promoter_campaigns: options.noCampaign
        ? []
        : promoter.campaigns.map((enrolment) => {
            const campaign = this.state.campaign(enrolment.campaign_id)
            return {
              id: enrolment.id,
              campaign_id: enrolment.campaign_id,
              promoter_id: promoter.id,
              state: promoter.state === "archived" ? "inactive" : "accepted",
              created_at: enrolment.created_at,
              campaign: {
                id: enrolment.campaign_id,
                name: campaign?.name ?? `Campaign ${enrolment.campaign_id}`,
                color: campaign?.color ?? "#000000",
              },
              ref_link: `${settings.website}?fpr=${enrolment.ref_token}`,
              ref_token: enrolment.ref_token,
              coupon: null,
              display_coupon: null,
              direct_url: null,
              track_ad_traffic: null,
              referral_rewards_customized: false,
              promoter_rewards_customized: false,
              rewards_for_promoters: (campaign?.promoterRewards ?? []).map(rewardJson),
              rewards_for_referrals: (campaign?.referralRewards ?? []).map(rewardJson),
              stats: {
                clicks_count: promoter.clicks,
                referrals_count: promoter.referrals,
                sales_count: promoter.customers,
                customers_count: promoter.customers,
                revenue_amount: 0,
              },
              promo_codes: [],
            }
          }),
    }
  }

  private promoterResponse(context: OperationContext, promoter: PromoterRecord, status = 200) {
    const noCampaign = faultEffect(context.request, "no_campaign") !== undefined
    return annotateResponse(jsonRes(status, this.render(promoter, { noCampaign })), {
      ids: { promoterId: String(promoter.id) },
    })
  }

  private listPromoters(context: OperationContext): Response {
    const page = Math.max(1, Number(context.url.searchParams.get("page") ?? "1") || 1)
    const perPage = Math.min(
      100,
      Math.max(1, Number(context.url.searchParams.get("per_page") ?? "20") || 20),
    )
    const live = this.state.all().filter((p) => p.state !== "archived")
    return jsonRes(200, {
      data: live.slice((page - 1) * perPage, page * perPage).map((p) => this.render(p)),
      meta: { pending_count: live.filter((p) => p.state === "pending").length },
    })
  }

  private createPromoter(context: OperationContext): Response {
    const body = record(context)
    const invalid = validation(context)
    if (invalid) return invalid
    const email = String(body.email)
    const custId = typeof body.cust_id === "string" ? body.cust_id : null
    const live = this.state.all().filter((p) => p.state !== "archived")
    const taken: Record<string, string[]> = {}
    if (live.some((p) => p.email.toLowerCase() === email.toLowerCase()))
      taken.email = ["has already been taken"]
    if (custId !== null && live.some((p) => p.cust_id === custId))
      taken.cust_id = ["has already been taken"]
    if (Object.keys(taken).length > 0) return unprocessable(taken)
    const settings = this.state.current()
    const campaignId =
      typeof body.initial_campaign_id === "number"
        ? body.initial_campaign_id
        : settings.defaultCampaignId
    if (!this.state.campaign(campaignId)) return error(404, "Campaign not found")
    const profile = (body.profile ?? {}) as { first_name?: string; last_name?: string }
    const now = this.iso()
    const promoter: PromoterRecord = {
      id: this.state.nextPromoterId(),
      email,
      cust_id: custId,
      note: null,
      first_name: profile.first_name ?? null,
      last_name: profile.last_name ?? null,
      state: "accepted",
      campaigns: [
        {
          campaign_id: campaignId,
          id: this.state.next("enrolment") + 7_000_000,
          ref_token: this.state.refToken(profile.first_name ?? null, email),
          created_at: now,
        },
      ],
      archived_at: null,
      created_at: now,
      updated_at: now,
      clicks: 0,
      referrals: 0,
      customers: 0,
      earnings_cash: 0,
    }
    this.state.promoters.insert(String(promoter.id), promoter)
    if (faultEffect(context.request, "created_but_500") !== undefined) {
      return annotateResponse(error(500, "Internal server error"), {
        ids: { promoterId: String(promoter.id) },
      })
    }
    return this.promoterResponse(context, promoter)
  }

  private getPromoter(context: OperationContext): Response {
    const by = context.url.searchParams.get("find_by") ?? "id"
    if (!["id", "cust_id", "ref_token", "email"].includes(by)) {
      return error(400, `find_by must be one of id, cust_id, ref_token, email`)
    }
    const promoter = this.state.find(
      context.params.id ?? "",
      by as "id" | "cust_id" | "ref_token" | "email",
    )
    if (!promoter) return error(404, "Promoter not found")
    return this.promoterResponse(context, promoter)
  }

  private updatePromoter(context: OperationContext): Response {
    const body = record(context)
    const promoter = this.state.find(context.params.id ?? "", "id")
    if (!promoter) return error(404, "Promoter not found")
    const invalid = validation(context)
    if (invalid) return invalid
    const others = this.state.all().filter((p) => p.id !== promoter.id && p.state !== "archived")
    const taken: Record<string, string[]> = {}
    if (typeof body.cust_id === "string" && others.some((p) => p.cust_id === body.cust_id))
      taken.cust_id = ["has already been taken"]
    if (
      typeof body.email === "string" &&
      others.some((p) => p.email.toLowerCase() === String(body.email).toLowerCase())
    )
      taken.email = ["has already been taken"]
    if (Object.keys(taken).length > 0) return unprocessable(taken)
    const profile = (body.profile ?? {}) as { first_name?: string; last_name?: string }
    const next: PromoterRecord = {
      ...promoter,
      ...(typeof body.email === "string" ? { email: body.email } : {}),
      ...(typeof body.cust_id === "string" ? { cust_id: body.cust_id } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(profile.first_name !== undefined ? { first_name: profile.first_name } : {}),
      ...(profile.last_name !== undefined ? { last_name: profile.last_name } : {}),
      updated_at: this.iso(),
    }
    this.state.promoters.update(String(promoter.id), next)
    return this.promoterResponse(context, next)
  }

  private archivePromoters(context: OperationContext): Response {
    const body = record(context)
    const invalid = validation(context)
    if (invalid) return invalid
    const ids = body.ids as number[]
    const now = this.iso()
    const errors: string[] = []
    let processed = 0
    for (const id of ids) {
      const promoter = this.state.byId(id)
      if (!promoter) {
        errors.push(`Promoter ${id} not found`)
        continue
      }
      processed++
      if (promoter.state === "archived") continue
      this.state.promoters.update(String(id), {
        ...promoter,
        state: "archived",
        archived_at: now,
        updated_at: now,
      })
    }
    return annotateResponse(
      jsonRes(200, {
        id: this.state.next("batch") + 300_000,
        status: "completed",
        total: ids.length,
        selected_total: ids.length,
        processed_count: processed,
        failed_count: errors.length,
        action_label: "archive",
        created_at: now,
        updated_at: now,
        meta: {},
        progress: 100,
        processing_errors: errors,
      }),
      { ids: { promoterIds: ids.join(",") } },
    )
  }

  private iframeLogin(context: OperationContext): Response {
    const raw = context.url.searchParams.get("promoter_id") ?? ""
    const promoter = this.state.find(raw, "id")
    if (!promoter) return error(404, "Promoter not found")
    return annotateResponse(
      jsonRes(200, {
        access_token: opaqueToken(`iframe:${promoter.id}:${this.now()}`, 40),
        expires_in: 7200,
      }),
      { ids: { promoterId: String(promoter.id) } },
    )
  }

  private trackSignup(context: OperationContext): Response {
    const body = record(context)
    const invalid = validation(context)
    if (invalid) return invalid
    const email = String(body.email)
    let promoter: PromoterRecord | undefined
    let tid: string | null = null
    if (typeof body.tid === "string" && body.tid) {
      const click = this.state.clicks.get(body.tid)
      if (!click) return error(404, "Visitor with this tid was not found")
      tid = click.tid
      promoter = this.state.byId(click.promoter_id)
    } else if (typeof body.promoter_id === "number") {
      promoter = this.state.byId(body.promoter_id)
      if (!promoter) return error(404, "Promoter not found")
    } else if (typeof body.ref_id === "string" && body.ref_id) {
      promoter = this.state.find(body.ref_id, "ref_token")
      if (!promoter) return error(404, "Promoter not found")
    } else {
      return error(400, "One of tid, ref_id or promoter_id is required")
    }
    if (!promoter || promoter.state === "archived") return error(404, "Promoter not found")
    const existing = this.state.referrals
      .list({ where: (r) => r.email.toLowerCase() === email.toLowerCase() })
      .at(0)?.value
    if (existing) return unprocessable({ email: ["has already been taken"] })
    const enrolment = promoter.campaigns[0]
    const referral: ReferralRecord = {
      id: this.state.nextReferralId(),
      email,
      uid: typeof body.uid === "string" ? body.uid : null,
      state: "signup",
      promoter_id: promoter.id,
      campaign_id: enrolment?.campaign_id ?? null,
      ref_token: enrolment?.ref_token ?? null,
      tid,
      created_at: this.iso(),
      customer_since: null,
    }
    this.state.referrals.insert(String(referral.id), referral)
    this.state.promoters.update(String(promoter.id), {
      ...promoter,
      referrals: promoter.referrals + 1,
      updated_at: this.iso(),
    })
    const converted = this.state.current().autoConvert ? this.convert(referral.id) : undefined
    const shown = converted ?? referral
    return annotateResponse(
      jsonRes(200, {
        id: shown.id,
        email: shown.email,
        uid: shown.uid,
        state: shown.state,
        created_at: shown.created_at,
        customer_since: shown.customer_since,
        promoter_campaign: enrolment
          ? {
              id: enrolment.id,
              campaign_id: enrolment.campaign_id,
              promoter_id: promoter.id,
              ref_token: enrolment.ref_token,
            }
          : null,
      }),
      { ids: { referralId: String(referral.id), promoterId: String(promoter.id) } },
    )
  }

  /** A promoter's link was clicked: the `tid` a browser would carry into checkout. */
  click(refToken: string): { tid: string; promoterId: number } | undefined {
    const promoter = this.state.find(refToken, "ref_token")
    if (!promoter) return undefined
    const tid = `${opaqueToken(`tid:${refToken}:${this.state.next("click")}`, 8)}-${this.state.next("click")}`
    this.state.clicks.insert(tid, {
      tid,
      promoter_id: promoter.id,
      ref_token: refToken,
      at: this.iso(),
    })
    this.state.promoters.update(String(promoter.id), { ...promoter, clicks: promoter.clicks + 1 })
    return { tid, promoterId: promoter.id }
  }

  /**
   * The referred lead paid: mark it a customer, credit the promoter (`saleAmount` × the
   * promoter reward's percent, or its flat cash amount), and emit `lead_becomes_referral`.
   */
  convert(referralId: number, saleAmount = 0): ReferralRecord | undefined {
    const referral = this.state.referrals.get(String(referralId))
    if (!referral || referral.promoter_id === null) return undefined
    const promoter = this.state.byId(referral.promoter_id)
    if (!promoter) return undefined
    const campaign =
      referral.campaign_id !== null ? this.state.campaign(referral.campaign_id) : undefined
    const now = this.iso()
    const first = referral.state !== "active"
    const next: ReferralRecord = {
      ...referral,
      state: "active",
      customer_since: referral.customer_since ?? now,
    }
    this.state.referrals.update(String(referral.id), next)
    const promoterReward = campaign?.promoterRewards[0]
    const earned = promoterReward
      ? promoterReward.per_of_sale !== null
        ? (saleAmount * promoterReward.per_of_sale) / 100
        : (promoterReward.amount ?? 0)
      : 0
    const updated: PromoterRecord = {
      ...promoter,
      customers: promoter.customers + (first ? 1 : 0),
      earnings_cash: promoter.earnings_cash + earned,
      updated_at: now,
    }
    this.state.promoters.update(String(promoter.id), updated)
    const reward = campaign?.referralRewards[0]
    const enrolment = promoter.campaigns.find((c) => c.campaign_id === referral.campaign_id)
    this.onWebhook?.({
      event: {
        id: this.state.next("event") + 50_000_000,
        type: "lead_becomes_referral",
        created_at: now,
      },
      data: {
        id: next.id,
        state: next.state,
        email: next.email,
        customer_since: next.customer_since,
        promotion: {
          id: enrolment?.id ?? 0,
          promoter_id: promoter.id,
          ref_id: enrolment?.ref_token ?? referral.ref_token ?? "",
          leads_count: updated.referrals,
          customers_count: updated.customers,
          current_referral_reward: reward
            ? {
                id: reward.reward_id,
                amount: reward.amount ?? 0,
                type: reward.per_of_sale !== null ? "percentage" : "fixed",
                unit: reward.unit ?? "cash",
                name: reward.name,
                per_of_sale: reward.per_of_sale ?? 0,
                default_promo_code: reward.coupon ?? "",
              }
            : null,
        },
        promoter: {
          id: promoter.id,
          cust_id: promoter.cust_id,
          email: promoter.email,
          earnings_balance: { cash: updated.earnings_cash },
        },
      },
    })
    return next
  }

  /** Seed a promoter directly (for suites that start with an existing affiliate). */
  seedPromoter(input: {
    email: string
    cust_id?: string | null | undefined
    first_name?: string | null | undefined
    last_name?: string | null | undefined
    ref_token?: string | undefined
    campaign_id?: number | undefined
  }): PromoterRecord {
    const now = this.iso()
    const promoter: PromoterRecord = {
      id: this.state.nextPromoterId(),
      email: input.email,
      cust_id: input.cust_id ?? null,
      note: null,
      first_name: input.first_name ?? null,
      last_name: input.last_name ?? null,
      state: "accepted",
      campaigns: [
        {
          campaign_id: input.campaign_id ?? this.state.current().defaultCampaignId,
          id: this.state.next("enrolment") + 7_000_000,
          ref_token: input.ref_token ?? this.state.refToken(input.first_name ?? null, input.email),
          created_at: now,
        },
      ],
      archived_at: null,
      created_at: now,
      updated_at: now,
      clicks: 0,
      referrals: 0,
      customers: 0,
      earnings_cash: 0,
    }
    this.state.promoters.insert(String(promoter.id), promoter)
    return promoter
  }
}

export type { FirstPromoterRuntime, FirstPromoterRuntimeOptions } from "./runtime.js"
export { createRuntime, FIRSTPROMOTER_PRESETS, WEBHOOK_PATH } from "./runtime.js"
