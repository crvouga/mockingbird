import type { AccountState } from "./state.js"

/**
 * A recorded Stripe catalog (products, prices with lookup keys, coupons, promotion codes) that
 * cannot be synthesised: seeded DB fixtures carry these ids, so an account configured with
 * `corpus: true` answers them byte for byte. Customers, intents and subscriptions are never
 * recorded; tests create them.
 */
export type CorpusProduct = {
  id: string
  name: string
  active: boolean
  description: string | null
  metadata: Record<string, string>
  default_price: string | null
}

export type CorpusPrice = {
  id: string
  product: string
  unit_amount: number
  currency: string
  recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null
  lookup_key: string | null
  nickname: string | null
  active: boolean
  metadata: Record<string, string>
}

export type CorpusCoupon = {
  id: string
  name: string | null
  percent_off: number | null
  amount_off: number | null
  currency: string | null
  duration: "forever" | "once" | "repeating"
  duration_in_months: number | null
  max_redemptions: number | null
  applies_to: string[]
}

export type CorpusPromotionCode = {
  id: string
  code: string
  coupon: string
  active: boolean
  max_redemptions: number | null
}

export type Corpus = {
  version: string
  source: string
  products: CorpusProduct[]
  prices: CorpusPrice[]
  coupons: CorpusCoupon[]
  promotionCodes: CorpusPromotionCode[]
  /** Lookup keys the recorder attached (not present in the recording itself). */
  synthesizedLookupKeys?: string[]
}

const SEEDED = "corpus"

/** Recording time of every seeded object (a fixed instant, so seeded ids replay exactly). */
const RECORDED_AT = 1_758_326_400

/** Seed `corpus` into an account once (again after a reset). Returns whether it seeded. */
export const seedCorpus = (account: AccountState, corpus: Corpus): boolean => {
  if (account.meta.get(SEEDED) !== undefined) return false
  for (const product of corpus.products) {
    if (account.products.get(product.id)) continue
    account.products.insert(product.id, {
      id: product.id,
      active: product.active,
      created: RECORDED_AT,
      description: product.description,
      images: [],
      marketing_features: [],
      metadata: product.metadata,
      name: product.name,
      package_dimensions: null,
      shippable: null,
      statement_descriptor: null,
      unit_label: null,
      updated: RECORDED_AT,
      url: null,
      default_price: product.default_price,
    })
  }
  for (const price of corpus.prices) {
    if (account.prices.get(price.id)) continue
    account.prices.insert(price.id, {
      id: price.id,
      active: price.active,
      created: RECORDED_AT,
      currency: price.currency,
      lookup_key: price.lookup_key,
      metadata: price.metadata,
      nickname: price.nickname,
      product: price.product,
      recurring:
        price.recurring === null
          ? null
          : {
              interval: price.recurring.interval,
              interval_count: price.recurring.interval_count,
              usage_type: "licensed",
            },
      tax_behavior: "unspecified",
      unit_amount_decimal: String(price.unit_amount),
    })
  }
  for (const coupon of corpus.coupons) {
    if (account.coupons.get(coupon.id)) continue
    account.coupons.insert(coupon.id, {
      id: coupon.id,
      amount_off: coupon.amount_off,
      applies_to_products: coupon.applies_to,
      created: RECORDED_AT,
      currency: coupon.currency,
      currency_options: {},
      duration: coupon.duration,
      duration_in_months: coupon.duration_in_months,
      livemode: false,
      max_redemptions: coupon.max_redemptions,
      metadata: {},
      name: coupon.name,
      percent_off: coupon.percent_off,
      redeem_by: null,
      times_redeemed: 0,
      valid: true,
    })
  }
  for (const promotion of corpus.promotionCodes) {
    if (account.promotionCodes.get(promotion.id)) continue
    account.promotionCodes.insert(promotion.id, {
      id: promotion.id,
      active: promotion.active,
      code: promotion.code,
      coupon: promotion.coupon,
      created: RECORDED_AT,
      customer: null,
      expires_at: null,
      max_redemptions: promotion.max_redemptions,
      metadata: {},
      restrictions: {
        first_time_transaction: false,
        minimum_amount: null,
        minimum_amount_currency: null,
      },
      times_redeemed: 0,
    })
  }
  account.meta.insert(SEEDED, { version: corpus.version })
  return true
}
