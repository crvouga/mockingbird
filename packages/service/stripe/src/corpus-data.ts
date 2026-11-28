import type { Corpus } from "./corpus.js"

export const DEFAULT_CORPUS: Corpus = {
  version: "synthetic-v1",
  source: "Synthetic stationery catalog",
  products: [
    {
      id: "prod_demo_notebook",
      name: "Notebook subscription",
      active: true,
      description: null,
      metadata: {},
      default_price: "price_demo_notebook",
    },
  ],
  prices: [
    {
      id: "price_demo_notebook",
      product: "prod_demo_notebook",
      unit_amount: 900,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
      lookup_key: "notebook_monthly",
      nickname: null,
      active: true,
      metadata: {},
    },
  ],
  coupons: [
    {
      id: "coupon_demo_intro",
      name: "Introductory discount",
      percent_off: 10,
      amount_off: null,
      currency: null,
      duration: "once",
      duration_in_months: null,
      max_redemptions: null,
      applies_to: ["prod_demo_notebook"],
    },
  ],
  promotionCodes: [
    {
      id: "promo_demo_intro",
      code: "NOTEBOOK10",
      coupon: "coupon_demo_intro",
      active: true,
      max_redemptions: null,
    },
  ],
}
