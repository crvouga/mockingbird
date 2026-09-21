/**
 * A port of our backend's FirstPromoter client and webhook receiver
 * (`B/global-services/services/first-promoter/first-promoter.service.ts`, its zod schemas in
 * `first-promoter.types.ts`, and `users.controller.ts` `POST /users/webhooks/first-promoter`):
 * the same URLs, headers, bodies, status branches and response validation. The database the
 * service writes to is an in-memory stand-in. The acceptance tests drive the mock through it.
 */
export type Fetch = (request: Request) => Promise<Response>

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === "number"
const isString = (value: unknown): value is string => typeof value === "string"
const optional = (value: unknown, check: (v: unknown) => boolean) =>
  value === undefined || check(value)
const nullish = (value: unknown, check: (v: unknown) => boolean) =>
  value === undefined || value === null || check(value)

const rewardOk = (value: unknown) =>
  isRecord(value) &&
  isString(value.apply_on) &&
  isNumber(value.reward_id) &&
  nullish(value.product_ids, Array.isArray) &&
  nullish(value.reward, isRecord) &&
  nullish(value.products, Array.isArray)

const campaignOk = (value: unknown) =>
  isRecord(value) &&
  isNumber(value.id) &&
  isNumber(value.campaign_id) &&
  isNumber(value.promoter_id) &&
  isString(value.state) &&
  isString(value.ref_link) &&
  optional(value.created_at, isString) &&
  optional(value.ref_token, isString) &&
  nullish(value.coupon, isString) &&
  optional(
    value.campaign,
    (c) => isRecord(c) && isNumber(c.id) && isString(c.name) && isString(c.color),
  ) &&
  optional(value.rewards_for_promoters, (r) => Array.isArray(r) && r.every(rewardOk)) &&
  optional(value.rewards_for_referrals, (r) => Array.isArray(r) && r.every(rewardOk)) &&
  optional(value.promo_codes, Array.isArray)

export type FirstPromoterV2 = {
  id: number
  email: string
  cust_id?: string | null
  promoter_campaigns: {
    id: number
    campaign_id: number
    promoter_id: number
    state: string
    ref_link: string
    ref_token?: string
    campaign?: { id: number; name: string; color: string }
    rewards_for_referrals?: {
      reward_id: number
      reward?: { name?: string | null; coupon?: string | null } | null
    }[]
  }[]
}

/** `FirstPromoterV2ResponseSchema.safeParse` (the fields it constrains). */
export const parsePromoterV2 = (value: unknown): FirstPromoterV2 | null =>
  isRecord(value) &&
  isNumber(value.id) &&
  isString(value.email) &&
  optional(value.name, isString) &&
  nullish(value.cust_id, isString) &&
  optional(value.state, isString) &&
  optional(value.stats, isRecord) &&
  optional(value.profile, (p) => isRecord(p) && isNumber(p.id)) &&
  nullish(value.archived_at, isString) &&
  Array.isArray(value.promoter_campaigns) &&
  value.promoter_campaigns.every(campaignOk)
    ? (value as FirstPromoterV2)
    : null

/** The local user row fields the service reads and the guarded claim writes. */
export type LocalUser = {
  id: number
  email: string
  firstName: string | null
  lastName: string | null
  promoterId: number | null
  referralUrl: string | null
}

/** In-memory stand-in for the DrizzleClientService calls the service makes. */
export class MemoryDb {
  readonly users = new Map<number, LocalUser>()
  readonly referrals: { promoterUserId: number; referredUserId: number }[] = []
  readonly earnings = new Map<number, { promoterId: number; referrals: number; earnings: number }>()
  readonly notifications: { type: string; payload: Json }[] = []

  add(user: Omit<LocalUser, "promoterId" | "referralUrl"> & Partial<LocalUser>): LocalUser {
    const row = { promoterId: null, referralUrl: null, ...user }
    this.users.set(row.id, row)
    return row
  }

  /** `claimFirstPromoterIdentity`: write only when no identity is stored yet. */
  claimFirstPromoterIdentity(userId: number, promoterId: number, referralUrl: string): boolean {
    const user = this.users.get(userId)
    if (!user || user.promoterId !== null) return false
    this.users.set(userId, { ...user, promoterId, referralUrl })
    return true
  }

  getUserByPromoterId(promoterId: number) {
    return [...this.users.values()].find((u) => u.promoterId === promoterId)
  }

  getUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email)
  }
}

export type ConsumerConfig = {
  apiUrl: string
  apiKey: string
  accountId: string
  /** `APP_ENV`: non-production never calls FirstPromoter to create a promoter. */
  environment: string
  webhookUsername?: string
  webhookPassword?: string
}

const SYNTHETIC_PROMOTER_ID_BASE = 900_000_000

export class FirstPromoterConsumer {
  constructor(
    private readonly config: ConsumerConfig,
    private readonly db: MemoryDb,
    private readonly send: Fetch,
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Account-ID": this.config.accountId,
      "Content-Type": "application/json",
    }
  }

  private request(url: string, init: RequestInit = {}) {
    return this.send(new Request(url, { ...init, headers: this.headers() }))
  }

  /** `getFirstPromoterDashboardUrl`: throws on any failure. */
  async getFirstPromoterDashboardUrl(promoterId: number): Promise<string> {
    const response = await this.request(
      `${this.config.apiUrl}/v2/promoters/iframe_login?promoter_id=${promoterId}`,
      { method: "POST" },
    )
    if (!response.ok) throw new Error("Failed to fetch FirstPromoter dashboard")
    const data: unknown = await response.json()
    if (!isRecord(data) || !isString(data.access_token) || !isNumber(data.expires_in)) {
      throw new Error("Failed to fetch FirstPromoter dashboard")
    }
    return `https://gogeviti.firstpromoter.com/iframe?tk=${data.access_token}`
  }

  /** `fetchPromoterList`: pages of 100 until a short page; stops (keeping what it has) on errors. */
  async fetchPromoterList(page = 1): Promise<FirstPromoterV2[]> {
    const all: FirstPromoterV2[] = []
    let current = page
    try {
      for (;;) {
        const response = await this.request(
          `${this.config.apiUrl}/v2/company/promoters?page=${current}&per_page=100`,
          { method: "GET" },
        )
        if (!response.ok) break
        const data: unknown = await response.json()
        if (
          !isRecord(data) ||
          !Array.isArray(data.data) ||
          !optional(data.meta, (m) => isRecord(m) && optional(m.pending_count, isNumber))
        ) {
          break
        }
        const promoters = data.data.map(parsePromoterV2)
        if (promoters.some((p) => p === null)) break
        all.push(...(promoters as FirstPromoterV2[]))
        if (promoters.length < 100) break
        current++
      }
    } catch {
      return []
    }
    return all
  }

  /** `findPromoterByCustId`: absent authorises a create, found an adopt, unavailable neither. */
  async findPromoterByCustId(
    custId: string,
  ): Promise<
    | { status: "absent" }
    | { status: "unavailable" }
    | { status: "found"; promoterId: number; referralUrl: string }
  > {
    try {
      const response = await this.request(
        `${this.config.apiUrl}/v2/company/promoters/${encodeURIComponent(custId)}?find_by=cust_id`,
        { method: "GET", signal: AbortSignal.timeout(10_000) },
      )
      if (response.status === 404) return { status: "absent" }
      if (!response.ok) return { status: "unavailable" }
      const parsed = parsePromoterV2(await response.json())
      if (!parsed) return { status: "unavailable" }
      const referralUrl = parsed.promoter_campaigns[0]?.ref_link
      if (!referralUrl) return { status: "unavailable" }
      return { status: "found", promoterId: parsed.id, referralUrl }
    } catch {
      return { status: "unavailable" }
    }
  }

  private claimOrYield(userId: number, promoterId: number, referralUrl: string) {
    if (this.db.claimFirstPromoterIdentity(userId, promoterId, referralUrl)) {
      return { userId, promoterId, referralUrl }
    }
    const current = this.db.users.get(userId)
    if (!current?.promoterId || !current.referralUrl) return null
    return { userId, promoterId: current.promoterId, referralUrl: current.referralUrl }
  }

  /**
   * `createFirstPromoterAccount`: adopt before create, keyed on `cust_id =
   * <environment>_<userId>`. Returns null on every failure (the queue job then throws).
   */
  async createFirstPromoterAccount(user: LocalUser) {
    if (this.config.environment !== "production") {
      return this.claimOrYield(
        user.id,
        SYNTHETIC_PROMOTER_ID_BASE + user.id,
        `https://gogeviti.com/referrals?fpr=dev-${user.id}`,
      )
    }
    const custId = `${this.config.environment}_${user.id}`
    const existing = await this.findPromoterByCustId(custId)
    if (existing.status === "unavailable") return null
    if (existing.status === "found") {
      return this.claimOrYield(user.id, existing.promoterId, existing.referralUrl)
    }
    const response = await this.send(
      new Request(`${this.config.apiUrl}/v2/company/promoters`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          email: user.email,
          cust_id: custId,
          profile: { first_name: user.firstName, last_name: user.lastName },
          drip_emails: false,
        }),
        signal: AbortSignal.timeout(10_000),
      }),
    )
    if (!response.ok) return null
    const parsed = parsePromoterV2(await response.json())
    if (!parsed) return null
    const referralUrl = parsed.promoter_campaigns[0]?.ref_link
    if (!referralUrl) return null
    return this.claimOrYield(user.id, parsed.id, referralUrl)
  }

  /** `deletePromoter`: archive; throws on non-2xx. */
  async deletePromoter(promoterId: number): Promise<true> {
    const response = await this.request(`${this.config.apiUrl}/v2/company/promoters/archive`, {
      method: "POST",
      body: JSON.stringify({ ids: [promoterId] }),
    })
    if (!response.ok) {
      throw new Error(`Failed to archive promoter ${promoterId} in FirstPromoter`)
    }
    return true
  }

  /** `updatePromoter`: set cust_id; throws on non-2xx. */
  async updatePromoter(promoterId: number, custId: string): Promise<true> {
    const response = await this.request(
      `${this.config.apiUrl}/v2/company/promoters/${promoterId}`,
      {
        method: "PUT",
        body: JSON.stringify({ cust_id: custId }),
      },
    )
    if (!response.ok) {
      throw new Error(`Failed to update promoter ${promoterId} in FirstPromoter`)
    }
    return true
  }

  /** `cleanupFirstPromoterAccounts`: the UPDATE_PROMOTER jobs it would queue. */
  async cleanupFirstPromoterAccounts(): Promise<{ id: number; custId: string }[]> {
    const map = new Map((await this.fetchPromoterList()).map((p) => [p.id, p]))
    const updates: { id: number; custId: string }[] = []
    for (const user of this.db.users.values()) {
      if (!user.promoterId) continue
      const promoter = map.get(user.promoterId)
      if (!promoter) continue
      if (!promoter.cust_id) {
        updates.push({ id: user.promoterId, custId: `${this.config.environment}_${user.id}` })
      }
    }
    return updates
  }

  /** `handleFirstPromoterTracking`: logs only; never throws. Returns what it logged. */
  async handleFirstPromoterTracking(email: string, tid: string): Promise<"tracked" | "failed"> {
    try {
      const response = await this.request(`${this.config.apiUrl}/v2/track/signup`, {
        method: "POST",
        body: JSON.stringify({ email, tid, skip_email_notification: true }),
      })
      if (response.ok) {
        await response.json()
        return "tracked"
      }
      return "failed"
    } catch {
      return "failed"
    }
  }

  /** `fetchPromoterByReferralId`: undefined on any failure. */
  async fetchPromoterByReferralId(referralId: string): Promise<FirstPromoterV2 | undefined> {
    const trimmed = referralId.trim()
    if (!trimmed) return undefined
    try {
      const response = await this.request(
        `${this.config.apiUrl}/v2/company/promoters/${encodeURIComponent(trimmed)}?find_by=ref_token`,
        { method: "GET" },
      )
      if (!response.ok) return undefined
      return parsePromoterV2(await response.json()) ?? undefined
    } catch {
      return undefined
    }
  }

  /** `handleFirstPromoterTrackingByRefId`: resolve the ref token, then track by promoter_id. */
  async handleFirstPromoterTrackingByRefId(email: string, refToken: string): Promise<boolean> {
    try {
      const promoter = await this.fetchPromoterByReferralId(refToken)
      if (!promoter) return false
      const response = await this.request(`${this.config.apiUrl}/v2/track/signup`, {
        method: "POST",
        body: JSON.stringify({ email, promoter_id: promoter.id, skip_email_notification: true }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /** `fetchCouponsByReferralId` (the checkout coupon preview). */
  async fetchCouponsByReferralId(referralId: string) {
    const trimmed = referralId.trim()
    if (!trimmed) return { coupons: [] }
    const promoter = await this.fetchPromoterByReferralId(trimmed)
    if (!promoter) return { coupons: [] }
    const promoterCampaign = promoter.promoter_campaigns[0]
    if (!promoterCampaign) return { coupons: [] }
    const referralRewards = promoterCampaign.rewards_for_referrals ?? []
    if (referralRewards.length === 0) return { coupons: [] }
    const rewardEntry =
      referralRewards.find((entry) => entry.reward?.coupon) ?? (referralRewards[0] as never)
    const reward = rewardEntry.reward
    if (!reward?.coupon) return { coupons: [] }
    return {
      coupons: [
        {
          id: rewardEntry.reward_id,
          name: reward.name ?? "Referral reward",
          default_promo_code: reward.coupon,
          campaign_id: promoterCampaign.campaign_id,
          campaign_name:
            promoterCampaign.campaign?.name ?? `Campaign ${promoterCampaign.campaign_id}`,
        },
      ],
    }
  }

  /** `validateWebhookBasicAuth`: throws "Unauthorized" variants. */
  validateWebhookBasicAuth(authHeader: string | null): void {
    const { webhookUsername, webhookPassword } = this.config
    if (!webhookUsername || !webhookPassword)
      throw new Error("FirstPromoter credentials misconfigured")
    if (!authHeader?.startsWith("Basic ")) throw new Error("Missing FirstPromoter credentials")
    const decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ""), "base64")
      .toString("utf8")
      .split(":")
    if (decoded.length !== 2) throw new Error("Invalid FirstPromoter credentials")
    const [username, password] = decoded
    if (username !== webhookUsername || password !== webhookPassword) {
      throw new Error("Invalid FirstPromoter credentials")
    }
  }

  /**
   * `handleNewCustomerWebhook`: envelope check, `lead_becomes_referral` only, match the
   * promoter's user (by promoterId, else the `cust_id` suffix), record the referral, notify,
   * upsert earnings. Returns what it did.
   */
  handleNewCustomerWebhook(payload: unknown): "ignored" | "no_user" | "applied" {
    if (
      !isRecord(payload) ||
      !isRecord(payload.event) ||
      !isNumber(payload.event.id) ||
      !isString(payload.event.type) ||
      !isString(payload.event.created_at)
    ) {
      throw new Error("Invalid FirstPromoter webhook payload")
    }
    if (payload.event.type !== "lead_becomes_referral") return "ignored"
    const data = payload.data
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (
      !isRecord(data) ||
      !isNumber(data.id) ||
      !isString(data.state) ||
      !isString(data.email) ||
      !email.test(data.email) ||
      !(data.customer_since === null || isString(data.customer_since)) ||
      !isRecord(data.promotion) ||
      !isNumber(data.promotion.id) ||
      !isNumber(data.promotion.promoter_id) ||
      !isString(data.promotion.ref_id) ||
      !isRecord(data.promoter) ||
      !isNumber(data.promoter.id) ||
      !(data.promoter.cust_id === null || isString(data.promoter.cust_id)) ||
      !isString(data.promoter.email) ||
      !email.test(data.promoter.email)
    ) {
      throw new Error("Invalid FirstPromoter webhook payload")
    }
    const promoter = data.promoter as {
      id: number
      cust_id: string | null
      earnings_balance?: { cash?: number } | null
    }
    const promotion = data.promotion as {
      customers_count?: number
      current_referral_reward?: {
        amount?: number | null
        unit: string
        name: string
        per_of_sale?: number | null
      } | null
    }
    let userId = this.db.getUserByPromoterId(promoter.id)?.id
    if (!userId && promoter.cust_id) {
      const parsedId = Number.parseInt(promoter.cust_id.split("_").at(-1) ?? "", 10)
      if (!Number.isNaN(parsedId)) userId = this.db.users.get(parsedId)?.id
    }
    if (!userId) return "no_user"
    const referrals = isNumber(promotion.customers_count) ? promotion.customers_count : 0
    const earnings = isNumber(promoter.earnings_balance?.cash) ? promoter.earnings_balance.cash : 0
    const referred = this.db.getUserByEmail(data.email)
    if (referred) {
      this.db.referrals.push({ promoterUserId: userId, referredUserId: referred.id })
      const rr = promotion.current_referral_reward
      let reward: string | undefined
      if (rr) {
        const amount = rr.amount ?? 0
        const perOfSale = rr.per_of_sale ?? 0
        if (amount > 0 && rr.unit === "cash") reward = `$${amount.toFixed(2)}`
        else if (perOfSale > 0 && rr.unit === "cash") reward = `${perOfSale}% commission`
        else if (rr.name) reward = rr.name
      }
      this.db.notifications.push({
        type: "marketing.referred_member_joins",
        payload: { userId, friendId: referred.id, reward },
      })
    }
    this.db.earnings.set(userId, { promoterId: promoter.id, referrals, earnings })
    return "applied"
  }
}
