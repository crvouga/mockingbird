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
import { Commissions } from "./commissions.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CampaignReward,
  type CommissionUnit,
  FirstPromoterState,
  type PromoterLookup,
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

const PROMOTER_LOOKUPS: readonly PromoterLookup[] = [
  "id",
  "cust_id",
  "auth_token",
  "ref_token",
  "promo_code",
  "email",
]

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
  readonly commissions: Commissions
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: LeadBecomesReferralWebhook) => void) | undefined

  constructor(options: FirstPromoterAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FIRSTPROMOTER_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new FirstPromoterState(sqlite, namespace, options.settings ?? {})
    this.commissions = new Commissions(this.state, this.now)
    const handlers = defineOperations<SupportedOperationId>({
      TrackSignup: (context) => this.trackSignup(context),
      TrackSale: (context) => this.trackSale(context),
      ListPromoters: (context) => this.listPromoters(context),
      CreatePromoter: (context) => this.createPromoter(context),
      ArchivePromoters: (context) => this.archivePromoters(context),
      GetPromoter: (context) => this.getPromoter(context),
      UpdatePromoter: (context) => this.updatePromoter(context),
      IframeLogin: (context) => this.iframeLogin(context),
      ListReferrals: (context) => this.listReferrals(context),
      GetReferral: (context) => this.getReferral(context),
      ListCommissions: (context) => this.commissions.list(context.url.searchParams),
      UpdateCommission: (context) => this.updateCommission(context),
      FulfillCommissions: (context) => this.commissionBatch(context, "mark_fulfilled"),
      DestroyCommissions: (context) => this.commissionBatch(context, "destroy"),
      ListBatchProcesses: (context) =>
        jsonRes(
          200,
          this.state.batches
            .list({
              order: "newest",
              where: (row) =>
                context.url.searchParams.has("filters[status]")
                  ? row.status === context.url.searchParams.get("filters[status]")
                  : row.status !== "completed",
            })
            .map((row) => row.value),
        ),
      GetBatchProcess: (context) => {
        const batch = this.state.batches.get(context.params.id ?? "")
        return batch ? jsonRes(200, batch) : error(404, "Batch process not found")
      },
      BatchProcessProgress: (context) =>
        jsonRes(
          200,
          Object.fromEntries(
            this.state.batches
              .list({
                where: (row) =>
                  context.url.searchParams.has("filters[status]")
                    ? row.status === context.url.searchParams.get("filters[status]")
                    : row.status !== "completed",
              })
              .map((row) => [row.value.id, row.value.progress]),
          ),
        ),
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
        this.commissions.settle()
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

  private updateCommission(context: OperationContext): Response {
    const body = record(context)
    const id = /^\d+$/.test(context.params.id ?? "") ? Number(context.params.id) : undefined
    if (id === undefined || !this.state.commissions.has(String(id)))
      return jsonRes(404, { message: "Commission not found", code: "not_found" })
    const invalid = validation(context)
    if (invalid) return invalid
    const row = this.commissions.updateNotes(id, {
      ...(typeof body.internal_note === "string" ? { internal_note: body.internal_note } : {}),
      ...(typeof body.external_note === "string" ? { external_note: body.external_note } : {}),
    })
    return row
      ? annotateResponse(jsonRes(200, this.commissions.render(row)), {
          ids: { commissionId: String(row.id) },
        })
      : jsonRes(404, { message: "Commission not found", code: "not_found" })
  }

  private commissionBatch(
    context: OperationContext,
    action: "mark_fulfilled" | "destroy",
  ): Response {
    const body = record(context)
    const invalid = validation(context)
    if (invalid) return invalid
    const batch = this.commissions.submit(
      body.ids as number[],
      action,
      faultEffect(context.request, "batch_partial_failure") !== undefined,
    )
    return jsonRes(batch.status === "pending" ? 202 : 200, batch)
  }

  private renderReferral(referral: ReferralRecord) {
    const promoter =
      referral.promoter_id === null ? undefined : this.state.byId(referral.promoter_id)
    const enrolment = promoter?.campaigns.find((c) => c.campaign_id === referral.campaign_id)
    const campaign =
      referral.campaign_id === null ? undefined : this.state.campaign(referral.campaign_id)
    return {
      id: referral.id,
      email: referral.email,
      uid: referral.uid,
      state: referral.state,
      metadata: {},
      entry_source: referral.tid ? "cookie" : "api",
      created_at: referral.created_at,
      customer_since: referral.customer_since,
      promoter_campaign:
        enrolment && promoter
          ? {
              id: enrolment.id,
              campaign_id: enrolment.campaign_id,
              promoter_id: promoter.id,
              created_at: enrolment.created_at,
              promoter: {
                id: promoter.id,
                email: promoter.email,
                name:
                  [promoter.first_name, promoter.last_name].filter(Boolean).join(" ") ||
                  promoter.email,
              },
              campaign: campaign
                ? { id: campaign.id, name: campaign.name, color: campaign.color }
                : null,
            }
          : null,
      fraud_check: "no_suspicion",
      created_by_user_email: null,
      username: null,
      split_details: [],
      first_name: null,
      last_name: null,
      website: null,
      comment: null,
      is_expired: false,
    }
  }

  private listReferrals(context: OperationContext): Response {
    const query = context.url.searchParams
    const search = query.get("q")?.toLowerCase() ?? ""
    const selected = query.getAll("ids[]")
    const promoter = query.get("filters[promoter_id]")
    const state = query.get("filters[state]")
    const type = query.get("filters[type]")
    const withinDates = (value: string | null, field: string) => {
      const from = query.get(`filters[${field}][from]`)
      const to = query.get(`filters[${field}][to]`)
      if (!from && !to) return true
      if (value === null) return false
      const day = value.slice(0, 10)
      return (!from || day >= from) && (!to || day <= to)
    }
    const rows = this.state.referrals
      .list({
        order: "newest",
        where: (referral) =>
          (!search ||
            [referral.email, referral.uid ?? ""].some((value) =>
              value.toLowerCase().includes(search),
            )) &&
          (selected.length === 0 || selected.includes(String(referral.id))) &&
          (!promoter || String(referral.promoter_id) === promoter) &&
          (!state || referral.state === state) &&
          (!type ||
            (type === "customer"
              ? referral.customer_since !== null
              : type === "lead" && referral.customer_since === null)) &&
          withinDates(referral.created_at, "created_at") &&
          withinDates(referral.customer_since, "customer_since"),
      })
      .map((row) => row.value)
    const page = Math.max(1, Math.floor(Number(query.get("page")) || 1))
    const size = Math.min(100, Math.max(1, Math.floor(Number(query.get("per_page")) || 20)))
    return jsonRes(
      200,
      rows.slice((page - 1) * size, page * size).map((referral) => this.renderReferral(referral)),
    )
  }

  private getReferral(context: OperationContext): Response {
    const value = context.params.id ?? ""
    const findBy = context.url.searchParams.get("find_by")
    const referral =
      findBy === "email" || findBy === "uid"
        ? this.state.referrals.list({
            where: (row) =>
              findBy === "email"
                ? row.email.toLowerCase() === value.toLowerCase()
                : row.uid === value,
          })[0]?.value
        : /^\d+$/.test(value)
          ? this.state.referrals.get(String(Number(value)))
          : undefined
    return referral
      ? annotateResponse(jsonRes(200, this.renderReferral(referral)), {
          ids: { referralId: String(referral.id) },
        })
      : error(404, "Referral not found")
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
    if (!PROMOTER_LOOKUPS.includes(by as PromoterLookup)) {
      return error(400, `find_by must be one of ${PROMOTER_LOOKUPS.join(", ")}`)
    }
    const promoter = this.state.find(context.params.id ?? "", by as PromoterLookup)
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
    const referral = this.createReferral(
      promoter,
      enrolment,
      email,
      typeof body.uid === "string" ? body.uid : null,
      tid,
    )
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

  /** A new lead attributed to `promoter` through `enrolment`; counts toward the promoter's referrals. */
  private createReferral(
    promoter: PromoterRecord,
    enrolment: PromoterRecord["campaigns"][number] | undefined,
    email: string,
    uid: string | null,
    tid: string | null,
  ): ReferralRecord {
    const referral: ReferralRecord = {
      id: this.state.nextReferralId(),
      email,
      uid,
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
    return referral
  }

  /**
   * Who a sale with no tracked lead is credited to, from `tid`, `ref_id` or (opt-in) `promo_code`:
   * the vendor's "bypass the signup tracking" path, which creates the lead and assigns the sale
   * in one step. `email` is required to name the new lead.
   */
  private saleOrigin(body: Json):
    | {
        promoter: PromoterRecord
        enrolment: PromoterRecord["campaigns"][number]
        tid: string | null
      }
    | undefined {
    const live = (promoter: PromoterRecord | undefined) =>
      promoter && promoter.state !== "archived" ? promoter : undefined
    if (typeof body.tid === "string") {
      const click = this.state.clicks.get(body.tid)
      const promoter = click ? live(this.state.byId(click.promoter_id)) : undefined
      const enrolment = promoter?.campaigns.find((c) => c.ref_token === click?.ref_token)
      return promoter && enrolment ? { promoter, enrolment, tid: body.tid } : undefined
    }
    if (typeof body.ref_id === "string") {
      const promoter = live(this.state.find(body.ref_id, "ref_token"))
      const enrolment = promoter?.campaigns.find((c) => c.ref_token === body.ref_id)
      return promoter && enrolment ? { promoter, enrolment, tid: null } : undefined
    }
    if (typeof body.promo_code === "string" && this.state.current().promoCodeCreatesReferral) {
      const code = this.state.promoCodes.get(body.promo_code)
      const owner = code ? this.commissions.enrolment(code.promoter_campaign_id) : undefined
      const promoter = live(owner?.promoter)
      return promoter && owner ? { promoter, enrolment: owner.entry, tid: null } : undefined
    }
    return undefined
  }

  private trackSale(context: OperationContext): Response {
    const body = record(context)
    if (!Number.isSafeInteger(body.amount) || Number(body.amount) <= 0)
      return error(400, "Error. Amount blank or invalid.")
    const invalid = validation(context)
    if (invalid) return invalid
    const eventId = String(body.event_id)
    if (this.state.sales.has(eventId))
      return error(409, `The 'sale' event with the id '${eventId}' already exists.`)
    const missing = () =>
      jsonRes(404, {
        message:
          "Referral corresponding to email or uid parameter not found or promoter is banned.",
        code: "not_found",
      })
    const tracked = this.state.referrals.list({
      where: (row) =>
        typeof body.uid === "string"
          ? row.uid === body.uid
          : row.email.toLowerCase() === String(body.email).toLowerCase(),
    })[0]?.value
    const origin = tracked ? undefined : this.saleOrigin(body)
    if (!tracked && (!origin || typeof body.email !== "string")) return missing()
    if (
      !tracked &&
      this.state.referrals.list({
        where: (row) => row.email.toLowerCase() === String(body.email).toLowerCase(),
      }).length > 0
    )
      return unprocessable({ email: ["has already been taken"] })
    const promoter =
      tracked === undefined
        ? origin?.promoter
        : tracked.promoter_id === null
          ? undefined
          : this.state.byId(tracked.promoter_id)
    const enrolment =
      tracked === undefined
        ? origin?.enrolment
        : promoter?.campaigns.find((c) => c.campaign_id === tracked.campaign_id)
    if (!promoter || promoter.state === "archived" || !enrolment) return missing()
    if (typeof body.ref_id === "string" && body.ref_id !== enrolment.ref_token) return missing()
    if (
      typeof body.tid === "string" &&
      this.state.clicks.get(body.tid)?.promoter_id !== promoter.id
    )
      return missing()
    if (
      typeof body.promo_code === "string" &&
      this.state.promoCodes.get(body.promo_code)?.promoter_campaign_id !== enrolment.id
    )
      return missing()
    const saleAmount = Number(body.amount)
    const reward = this.state.campaign(enrolment.campaign_id)?.promoterRewards[0]
    const earned = reward
      ? Math.round(
          reward.per_of_sale !== null
            ? (saleAmount * reward.per_of_sale) / 100
            : (reward.amount ?? 0),
        )
      : 0
    const units: CommissionUnit[] = [
      "cash",
      "credits",
      "points",
      "free_months",
      "mon_discount",
      "discount_per",
    ]
    const unit: CommissionUnit = units.find((value) => value === reward?.unit) ?? "cash"
    const { sale, referral } = this.sqlite.transaction(() => {
      const referral =
        tracked ??
        this.createReferral(
          promoter,
          enrolment,
          String(body.email),
          typeof body.uid === "string" ? body.uid : null,
          origin?.tid ?? null,
        )
      const commission = reward
        ? this.commissions.seed({
            promoter_campaign_id: enrolment.id,
            referral_id: referral.id,
            status: "approved",
            fulfilled: false,
            is_paid: false,
            commission_type: "sale",
            unit,
            amount: earned,
            sale_amount: saleAmount,
            original_sale_currency: typeof body.currency === "string" ? body.currency : null,
            event_id: eventId,
            plan_id: typeof body.plan === "string" ? body.plan : null,
          })
        : undefined
      const row = {
        id: 93_000_000 + this.state.next("sale"),
        event_id: eventId,
        referral_id: referral.id,
        commission_ids: commission ? [commission.id] : [],
        sale_amount: saleAmount,
        original_sale_currency: typeof body.currency === "string" ? body.currency : null,
        plan_id: typeof body.plan === "string" ? body.plan : null,
        created_at: this.iso(),
      }
      this.state.sales.insert(eventId, row)
      this.convertReferral(referral.id, saleAmount, unit === "cash" ? earned : 0)
      return { sale: row, referral }
    })
    return jsonRes(200, {
      id: sale.id,
      etype: "sale",
      sale_amount: sale.sale_amount,
      original_sale_amount: sale.sale_amount,
      original_sale_currency: sale.original_sale_currency,
      event_id: sale.event_id,
      plan_id: sale.plan_id,
      billing_period: null,
      created_at: sale.created_at,
      referral: { id: referral.id, email: referral.email, uid: referral.uid },
      commissions: sale.commission_ids.flatMap((id) => {
        const row = this.state.commissions.get(String(id))
        return row ? [this.commissions.render(row)] : []
      }),
    })
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
    return this.convertReferral(referralId, saleAmount)
  }

  private convertReferral(
    referralId: number,
    saleAmount: number,
    credit?: number,
  ): ReferralRecord | undefined {
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
      earnings_cash: promoter.earnings_cash + (credit ?? earned),
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
