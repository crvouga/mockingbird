import { jsonRes, type OperationContext } from "@crvouga/mockingbird-service"
import type { FirstPromoterAPI } from "./index.js"
import type { PromoterRecord } from "./state.js"

/**
 * The legacy v1 API (`X-API-KEY`): promoters list/show/create/update/delete, signup tracking and
 * the campaigns report, over the same store as v2. Best guess from the vendor's published v1
 * OpenAPI (docs.firstpromoter.com/api-reference-v1), not oracle-verified. Documented options the
 * emulator has no state for answer 501 `mockingbird_unsupported` instead of being ignored.
 */

const error = (status: number, message: string) => jsonRes(status, { error: message })
const unsupported = (message: string) =>
  jsonRes(501, { message: `Mockingbird: ${message}`, code: "mockingbird_unsupported" })
const invalid = (message: string) => jsonRes(422, { message, code: "invalid_params" })
const NOT_FOUND = "Promoter not found."

/** v1 parameters travel in the query string; a form or JSON body is read too. */
const params = (context: OperationContext): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [key, value] of context.url.searchParams) out.set(key, value)
  const body = context.body
  if (
    (body.kind === "json" || body.kind === "form") &&
    body.value &&
    typeof body.value === "object"
  )
    for (const [key, value] of Object.entries(body.value as Record<string, unknown>))
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        out.set(key, String(value))
  return out
}

/** The first documented-but-unmodelled option present, if any. */
const firstUnmodelled = (values: Map<string, string>, names: readonly string[]) =>
  names.find((name) => values.has(name))

const PROFILE_OPTIONS = [
  "promo_code",
  "customer_promo_code",
  "temp_password",
  "landing_url",
  "url_tracking",
  "website",
  "paypal_email",
  "avatar_url",
  "parent_promoter_email",
  "linkedin_url",
  "twitter_url",
  "facebook_url",
  "instagram_url",
  "youtube_url",
  "country",
  "company_name",
  "phone_number",
  "address",
] as const
const CREATE_UNMODELLED = [
  ...PROFILE_OPTIONS,
  "parent_promoter_id",
  "created_at",
  "always_approve",
] as const
const UPDATE_UNMODELLED = [...PROFILE_OPTIONS, "campaign_id"] as const
const SIGNUP_UNMODELLED = [
  "promoter_email",
  "created_at",
  "username",
  "first_name",
  "last_name",
  "website",
  "custom_fields",
  "sub_id",
  "override_existing_lead",
] as const

const REPORT_FIELDS = [
  "revenue_amount",
  "clicks_count",
  "referrals_count",
  "customers_count",
  "active_customers",
  "monthly_churn",
  "net_revenue_amount",
  "sales_count",
  "refunds_count",
  "cancelled_customers_count",
  "promoter_earnings_amount",
  "non_link_customers",
  "referrals_to_customers_cr",
  "3m_epc",
  "6m_epc",
  "clicks_to_customers_cr",
  "clicks_to_referrals_cr",
  "promoter_paid_amount",
] as const
const MODELLED_REPORT_FIELDS = [
  "revenue_amount",
  "clicks_count",
  "referrals_count",
  "customers_count",
  "sales_count",
] as const
type ReportField = (typeof MODELLED_REPORT_FIELDS)[number]
const DEFAULT_REPORT_FIELDS: ReportField[] = [
  "revenue_amount",
  "clicks_count",
  "referrals_count",
  "customers_count",
]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAY_MS = 86_400_000

const money = (minor: number) =>
  `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export class V1 {
  constructor(private readonly api: FirstPromoterAPI) {}

  private get state() {
    return this.api.state
  }

  private live(promoter: PromoterRecord | undefined) {
    return promoter && promoter.state !== "archived" ? promoter : undefined
  }

  /** The v1 promoter without profile / promotions (as the signup event embeds it). */
  private summary(promoter: PromoterRecord) {
    const main = promoter.campaigns[0]
    return {
      id: promoter.id,
      status: promoter.state === "pending" ? "pending" : "approved",
      cust_id: promoter.cust_id,
      email: promoter.email,
      created_at: promoter.created_at,
      temp_password: null,
      default_promotion_id: main?.id ?? null,
      pref: main?.ref_token ?? null,
      default_ref_id: main?.ref_token ?? null,
      note: promoter.note,
      w8_form_url: null,
      w9_form_url: null,
      parent_promoter_id: null,
      earnings_balance: { cash: promoter.earnings_cash },
      current_balance: { cash: promoter.earnings_cash },
      paid_balance: { cash: 0 },
      auth_token: this.state.authToken(promoter),
    }
  }

  render(promoter: PromoterRecord) {
    const website = this.state.current().website
    return {
      ...this.summary(promoter),
      profile: {
        id: promoter.id + 1_000_000,
        first_name: promoter.first_name,
        last_name: promoter.last_name,
        website: null,
        company_name: null,
        phone_number: null,
        address: null,
        vat_id: null,
        country: null,
        paypal_email: null,
        avatar_url: null,
        description: null,
        social_accounts: {},
      },
      promotions: promoter.campaigns.map((enrolment) => {
        const campaign = this.state.campaign(enrolment.campaign_id)
        const reward = campaign?.referralRewards[0]
        const referrals = this.state.referrals
          .list({
            where: (r) => r.promoter_id === promoter.id && r.campaign_id === enrolment.campaign_id,
          })
          .map((row) => row.value)
        const ids = new Set(referrals.map((r) => r.id))
        const sales = this.state.sales
          .list({ where: (row) => ids.has(row.referral_id) })
          .map((row) => row.value)
        const customers = referrals.filter((r) => r.customer_since !== null).length
        const offer = reward
          ? {
              id: reward.reward_id,
              name: reward.name,
              amount: reward.amount ?? 0,
              unit: reward.unit ?? "cash",
              default_promo_code: reward.coupon ?? "",
            }
          : null
        return {
          id: enrolment.id,
          promoter_id: promoter.id,
          campaign_id: enrolment.campaign_id,
          status: "offer_running",
          ref_id: enrolment.ref_token,
          promo_code: null,
          customer_promo_code: null,
          referral_link: `${website}?fpr=${enrolment.ref_token}`,
          campaign_name: campaign?.name ?? `Campaign ${enrolment.campaign_id}`,
          hidden: false,
          target_reached_at: null,
          current_promotion_reward: null,
          current_target_reward: null,
          current_offer: offer,
          current_referral_reward:
            offer && reward ? { ...offer, per_of_sale: reward.per_of_sale ?? 0 } : null,
          visitors_count: this.state.clicks.list({
            where: (click) => click.ref_token === enrolment.ref_token,
          }).length,
          leads_count: referrals.length,
          customers_count: customers,
          refunds_count: 0,
          cancellations_count: 0,
          sales_count: sales.length,
          sales_total: sales.reduce((sum, sale) => sum + sale.sale_amount, 0),
          refunds_total: 0,
          active_customers_count: customers,
        }
      }),
      custom_fields: null,
      promo_codes: [],
    }
  }

  private findBy(values: Map<string, string>, keys: readonly string[]) {
    for (const key of keys) {
      const value = values.get(key)
      if (value === undefined || value === "") continue
      if (key === "id") return { key, promoter: this.live(this.state.find(value, "id")) }
      if (key === "email" || key === "promoter_email")
        return { key, promoter: this.live(this.state.find(value, "email")) }
      if (key === "ref_id") return { key, promoter: this.live(this.state.find(value, "ref_token")) }
      return {
        key,
        promoter: this.live(this.state.find(value, key as "cust_id" | "auth_token")),
      }
    }
    return undefined
  }

  private taken(field: "email" | "cust_id" | "ref_id", value: string, except?: number) {
    return this.state
      .all()
      .some(
        (p) =>
          p.id !== except &&
          p.state !== "archived" &&
          (field === "email"
            ? p.email.toLowerCase() === value.toLowerCase()
            : field === "cust_id"
              ? p.cust_id === value
              : p.campaigns.some((c) => c.ref_token === value)),
      )
  }

  list(context: OperationContext): Response {
    const raw = params(context).get("campaign_id")
    if (raw !== undefined && !this.state.campaign(Number(raw)))
      return error(422, "Campaign not found.")
    return jsonRes(
      200,
      this.state
        .all()
        .filter(
          (p) =>
            p.state !== "archived" &&
            (raw === undefined || p.campaigns.some((c) => c.campaign_id === Number(raw))),
        )
        .map((p) => this.render(p)),
    )
  }

  show(context: OperationContext): Response {
    const found = this.findBy(params(context), [
      "id",
      "promoter_email",
      "cust_id",
      "ref_id",
      "auth_token",
    ])
    if (!found)
      return error(422, "One of id, promoter_email, cust_id, ref_id or auth_token is required")
    return found.promoter ? jsonRes(200, this.render(found.promoter)) : error(404, NOT_FOUND)
  }

  create(context: OperationContext): Response {
    const values = params(context)
    const option = firstUnmodelled(values, CREATE_UNMODELLED)
    if (option) return unsupported(`v1 promoter option ${option} is not modelled`)
    const email = values.get("email")?.trim() ?? ""
    if (!email) return error(422, "Email can't be blank")
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return error(422, "Email is invalid")
    if (this.taken("email", email)) return error(422, "Email has already been taken")
    const custId = values.get("cust_id") || undefined
    if (custId !== undefined && this.taken("cust_id", custId))
      return error(422, "Cust has already been taken")
    const refId = values.get("ref_id") || undefined
    if (refId !== undefined && this.taken("ref_id", refId))
      return error(422, "Ref has already been taken")
    const campaignId = values.has("campaign_id")
      ? Number(values.get("campaign_id"))
      : this.state.current().defaultCampaignId
    if (!this.state.campaign(campaignId)) return error(422, "Campaign not found.")
    const seeded = this.api.seedPromoter({
      email,
      cust_id: custId,
      first_name: values.get("first_name"),
      last_name: values.get("last_name"),
      ref_token: refId,
      campaign_id: campaignId,
    })
    const note = values.get("note")
    const promoter = note === undefined ? seeded : { ...seeded, note }
    if (note !== undefined) this.state.promoters.update(String(promoter.id), promoter)
    return jsonRes(200, this.render(promoter))
  }

  update(context: OperationContext): Response {
    const values = params(context)
    const option = firstUnmodelled(values, UPDATE_UNMODELLED)
    if (option) return unsupported(`v1 promoter option ${option} is not modelled`)
    const found = this.findBy(values, ["id", "cust_id", "auth_token", "ref_id", "email"])
    if (!found) return error(422, "One of id or email is required")
    const promoter = found.promoter
    if (!promoter) return error(404, NOT_FOUND)
    const email = found.key === "email" ? undefined : values.get("email")
    if (email !== undefined && this.taken("email", email, promoter.id))
      return error(422, "Email has already been taken")
    const custId = values.get("new_cust_id")
    if (custId !== undefined && this.taken("cust_id", custId, promoter.id))
      return error(422, "Cust has already been taken")
    const refId = values.get("new_ref_id")
    if (refId !== undefined && this.taken("ref_id", refId, promoter.id))
      return error(422, "Ref has already been taken")
    const [main, ...rest] = promoter.campaigns
    const next: PromoterRecord = {
      ...promoter,
      ...(email !== undefined ? { email } : {}),
      ...(custId !== undefined ? { cust_id: custId } : {}),
      ...(values.has("note") ? { note: values.get("note") ?? null } : {}),
      ...(values.has("first_name") ? { first_name: values.get("first_name") ?? null } : {}),
      ...(values.has("last_name") ? { last_name: values.get("last_name") ?? null } : {}),
      ...(refId !== undefined && main
        ? { campaigns: [{ ...main, ref_token: refId }, ...rest] }
        : {}),
      updated_at: new Date(this.api.clockNow()).toISOString(),
    }
    this.state.promoters.update(String(promoter.id), next)
    return jsonRes(200, this.render(next))
  }

  remove(context: OperationContext): Response {
    const found = this.findBy(params(context), ["id", "cust_id", "ref_id", "auth_token"])
    if (!found) return error(422, "One of id, cust_id, ref_id or auth_token is required")
    const promoter = found.promoter
    if (!promoter) return error(404, NOT_FOUND)
    const now = new Date(this.api.clockNow()).toISOString()
    this.state.promoters.update(String(promoter.id), {
      ...promoter,
      state: "archived",
      archived_at: now,
      updated_at: now,
    })
    return jsonRes(200, { message: "Promoter removed." })
  }

  trackSignup(context: OperationContext): Response {
    const values = params(context)
    const option = firstUnmodelled(values, SIGNUP_UNMODELLED)
    if (option) return unsupported(`v1 signup option ${option} is not modelled`)
    const email = values.get("email") || undefined
    const uid = values.get("uid") || undefined
    if (!email && !uid) return jsonRes(400, { message: "Error. Email and uid can not be blank!" })
    if (!email) return unsupported("v1 signup tracking without email is not modelled")
    const visitorMissing = () =>
      jsonRes(404, {
        message:
          "Visitor  invalid, not found or you are trying to use the signup tracking test via API which doesn't work on API calls.",
      })
    const tid = values.get("tid") || undefined
    const refId = values.get("ref_id") || undefined
    const click = tid ? this.state.clicks.get(tid) : undefined
    const token = tid ? click?.ref_token : refId
    if (!token) return visitorMissing()
    const promoter = tid
      ? click && this.state.byId(click.promoter_id)
      : this.state.find(token, "ref_token")
    const enrolment = promoter?.campaigns.find((c) => c.ref_token === token)
    if (!promoter || !enrolment) return visitorMissing()
    if (promoter.state === "archived")
      return jsonRes(404, {
        message: "This promotion is blocked or does not allow tracking for this event type.",
      })
    const exists = this.state.referrals.list({
      where: (r) =>
        r.email.toLowerCase() === email.toLowerCase() || (uid !== undefined && r.uid === uid),
    }).length
    if (exists > 0)
      return jsonRes(422, {
        transaction_id: "there is already a signup event registered on this lead",
      })
    const lead = this.api.createReferral(promoter, enrolment, email, uid ?? null, tid ?? null)
    const shown = (this.state.current().autoConvert ? this.api.convert(lead.id) : undefined) ?? lead
    return jsonRes(200, {
      id: 94_000_000 + this.state.next("v1_event"),
      type: "signup",
      amount_cents: null,
      reward: null,
      lead: {
        id: shown.id,
        state: shown.state,
        email: shown.email,
        uid: shown.uid,
        customer_since: shown.customer_since,
        cancelled_at: null,
        plan_name: null,
        suspicion: "no_suspicion",
        username: null,
        website: null,
        created_at: shown.created_at,
        split_promotion_id: null,
        custom_fields: null,
        split_percentage_value: null,
        visitor_sub_id: null,
      },
      promoter: this.summary(this.state.byId(promoter.id) ?? promoter),
    })
  }

  campaignsReport(context: OperationContext): Response {
    const query = context.url.searchParams
    const requested = query.getAll("selected_fields[]")
    if (requested.some((f) => !REPORT_FIELDS.includes(f as (typeof REPORT_FIELDS)[number])))
      return invalid("Selected Fields invalid !")
    const unmodelled = requested.find((f) => !MODELLED_REPORT_FIELDS.includes(f as ReportField))
    if (unmodelled) return unsupported(`v1 report field ${unmodelled} is not modelled`)
    const fields: ReportField[] =
      requested.length > 0 ? [...new Set(requested as ReportField[])] : DEFAULT_REPORT_FIELDS
    const groupBy = query.get("group_by") ?? "month"
    if (groupBy !== "day" && groupBy !== "month" && groupBy !== "year")
      return invalid("Group by invalid !")
    const now = new Date(this.api.clockNow())
    const day = (value: string | null, fallback: Date, label: string) => {
      if (value === null) return { date: fallback }
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null
      return parsed && !Number.isNaN(parsed.getTime())
        ? { date: parsed }
        : { error: invalid(`${label} invalid !`) }
    }
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const yearAgo = new Date(
      Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()),
    )
    const start = day(query.get("start_date"), yearAgo, "Start date")
    if (start.error) return start.error
    const end = day(query.get("end_date"), today, "End date")
    if (end.error) return end.error
    const from = start.date as Date
    const to = end.date as Date
    if (from > to) return invalid("Start date must be before end date")
    if (groupBy === "day" && (to.getTime() - from.getTime()) / DAY_MS > 90)
      return invalid("Day grouping is limited to 90 days")
    const label = (date: Date) =>
      groupBy === "year"
        ? String(date.getUTCFullYear())
        : groupBy === "month"
          ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
          : date.toISOString().slice(0, 10)
    const periods: string[] = []
    for (let cursor = new Date(from); cursor <= to; ) {
      const name = label(cursor)
      if (periods.at(-1) !== name) periods.push(name)
      cursor =
        groupBy === "day"
          ? new Date(cursor.getTime() + DAY_MS)
          : groupBy === "month"
            ? new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
            : new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1))
    }
    const endExclusive = to.getTime() + DAY_MS
    const within = (at: string | null) => {
      if (at === null) return undefined
      const time = Date.parse(at)
      return time >= from.getTime() && time < endExclusive ? label(new Date(time)) : undefined
    }
    type Totals = Record<ReportField, number>
    const zero = (): Totals => ({
      revenue_amount: 0,
      clicks_count: 0,
      referrals_count: 0,
      customers_count: 0,
      sales_count: 0,
    })
    const buckets = new Map<string, Totals>()
    const add = (
      campaignId: number | null | undefined,
      at: string | null,
      field: ReportField,
      n = 1,
    ) => {
      const period = within(at)
      if (campaignId === null || campaignId === undefined || period === undefined) return
      const key = `${campaignId}\u0000${period}`
      const totals = buckets.get(key) ?? zero()
      totals[field] += n
      buckets.set(key, totals)
    }
    const referrals = this.state.referrals.list().map((row) => row.value)
    for (const referral of referrals) {
      add(referral.campaign_id, referral.created_at, "referrals_count")
      add(referral.campaign_id, referral.customer_since, "customers_count")
    }
    for (const { value: click } of this.state.clicks.list()) {
      const enrolment = this.state
        .byId(click.promoter_id)
        ?.campaigns.find((c) => c.ref_token === click.ref_token)
      add(enrolment?.campaign_id, click.at, "clicks_count")
    }
    for (const { value: sale } of this.state.sales.list()) {
      const campaignId = referrals.find((r) => r.id === sale.referral_id)?.campaign_id
      add(campaignId, sale.created_at, "sales_count")
      add(campaignId, sale.created_at, "revenue_amount", sale.sale_amount)
    }
    const project = (totals: Totals) =>
      Object.fromEntries(
        fields.map((field) => [
          field,
          field === "revenue_amount" ? money(totals.revenue_amount) : totals[field],
        ]),
      )
    return jsonRes(
      200,
      this.state.current().campaigns.map((campaign) => {
        const sum = zero()
        const items = periods.map((period) => {
          const totals = buckets.get(`${campaign.id}\u0000${period}`) ?? zero()
          for (const field of MODELLED_REPORT_FIELDS) sum[field] += totals[field]
          return { period, ...project(totals) }
        })
        return { campaign_name: campaign.name, campaign_id: campaign.id, ...project(sum), items }
      }),
    )
  }
}
