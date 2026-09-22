import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** A referral reward a campaign gives the referred friend (our checkout reads its coupon). */
export type CampaignReward = {
  reward_id: number
  apply_on: string
  name: string
  coupon: string | null
  amount: number | null
  unit: string | null
  per_of_sale: number | null
}

export type Campaign = {
  id: number
  name: string
  color: string
  /** Rewards for the referred friend (`rewards_for_referrals`). */
  referralRewards: CampaignReward[]
  /** Rewards for the promoter (`rewards_for_promoters`). */
  promoterRewards: CampaignReward[]
}

export type PromoterRecord = {
  id: number
  email: string
  cust_id: string | null
  note: string | null
  first_name: string | null
  last_name: string | null
  state: "accepted" | "pending" | "archived"
  /** Campaign enrolments: `[campaignId, enrolmentId, refToken]`. */
  campaigns: { campaign_id: number; id: number; ref_token: string; created_at: string }[]
  archived_at: string | null
  created_at: string
  updated_at: string
  /** Counters that stats and the webhook report. */
  clicks: number
  referrals: number
  customers: number
  earnings_cash: number
}

export type ReferralRecord = {
  id: number
  email: string
  uid: string | null
  state: "signup" | "active"
  promoter_id: number | null
  campaign_id: number | null
  ref_token: string | null
  tid: string | null
  created_at: string
  customer_since: string | null
}

/** A click on a promoter's link: the `tid` the browser carries into checkout. */
export type ClickRecord = { tid: string; promoter_id: number; ref_token: string; at: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Where `ref_link` points (the company website). */
  website: string
  /** Campaign new promoters join. */
  defaultCampaignId: number
  campaigns: Campaign[]
  /**
   * Convert a tracked signup to a customer at once (emitting `lead_becomes_referral`). Our
   * backend tracks the signup after the first invoice is paid, when FirstPromoter's Stripe
   * integration would already have seen the sale. Default `true`.
   */
  autoConvert: boolean
}

export const DEFAULT_CAMPAIGNS: Campaign[] = [
  {
    id: 1,
    name: "Geviti Referral Program",
    color: "#4F46E5",
    referralRewards: [
      {
        reward_id: 11,
        apply_on: "first_payment",
        name: "$50 off your first order",
        coupon: "GEVITI50",
        amount: 50,
        unit: "cash",
        per_of_sale: null,
      },
    ],
    promoterRewards: [
      {
        reward_id: 12,
        apply_on: "all_payments",
        name: "10% commission",
        coupon: null,
        amount: null,
        unit: "cash",
        per_of_sale: 10,
      },
    ],
  },
  {
    id: 2,
    name: "Partner Program",
    color: "#059669",
    referralRewards: [],
    promoterRewards: [],
  },
]

export const DEFAULT_SETTINGS: Settings = {
  website: "https://gogeviti.com/referrals",
  defaultCampaignId: 1,
  campaigns: DEFAULT_CAMPAIGNS,
  autoConvert: true,
}

const PROMOTER_ID_BASE = 4_800_000
const REFERRAL_ID_BASE = 91_000_000

export class FirstPromoterState {
  readonly promoters: Collection<PromoterRecord>
  readonly referrals: Collection<ReferralRecord>
  readonly clicks: Collection<ClickRecord>
  readonly settings: Collection<Settings>
  readonly counters: Collection<{ value: number }>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.promoters = new Collection(sqlite, namespace, "promoters")
    this.referrals = new Collection(sqlite, namespace, "referrals")
    this.clicks = new Collection(sqlite, namespace, "clicks")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** The next value of a named counter (1, 2, 3, …). */
  next(name: string): number {
    const value = (this.counters.get(name)?.value ?? 0) + 1
    this.counters.insert(name, { value })
    return value
  }

  nextPromoterId(): number {
    return PROMOTER_ID_BASE + this.next("promoter")
  }

  nextReferralId(): number {
    return REFERRAL_ID_BASE + this.next("referral")
  }

  campaign(id: number): Campaign | undefined {
    return this.current().campaigns.find((c) => c.id === id)
  }

  all(): PromoterRecord[] {
    return this.promoters.list({ order: "oldest" }).map((row) => row.value)
  }

  byId(id: number): PromoterRecord | undefined {
    return this.promoters.get(String(id))
  }

  /** `GET /v2/company/promoters/{value}?find_by=…` */
  find(value: string, by: "id" | "cust_id" | "ref_token" | "email"): PromoterRecord | undefined {
    if (by === "id") return /^\d+$/.test(value) ? this.byId(Number(value)) : undefined
    return this.all().find((p) => {
      if (by === "cust_id") return p.cust_id === value
      if (by === "email") return p.email.toLowerCase() === value.toLowerCase()
      return p.campaigns.some((c) => c.ref_token === value)
    })
  }

  /** A unique ref token in FirstPromoter's style: the first name plus two digits. */
  refToken(firstName: string | null, email: string): string {
    const stem =
      (firstName ?? email.split("@")[0] ?? "promoter").toLowerCase().replace(/[^a-z0-9]/g, "") ||
      "promoter"
    const taken = new Set(this.all().flatMap((p) => p.campaigns.map((c) => c.ref_token)))
    for (let n = this.next("ref_token"); ; n++) {
      const token = `${stem.slice(0, 20)}${(n % 90) + 10}${n >= 90 ? Math.floor(n / 90) : ""}`
      if (!taken.has(token)) return token
    }
  }
}
