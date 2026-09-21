/** The API version the vendored contract (and a request without `Stripe-Version`) follows. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia"

/** The version stripe-node 16.x pins, and what our backends send. */
export const LEGACY_API_VERSION = "2024-06-20"

/** The version stripe-node 17.x pins (partner-platform, the shop CLI). */
export const ACACIA_API_VERSION = "2025-02-24.acacia"

/**
 * Response shapes the mock renders. Stripe's breaking changes between the versions our
 * consumers pin fall into three bands:
 *
 * - `legacy` (before 2024-09-30.acacia): invoices carry `charge`, `payment_intent`,
 *   `subscription`, `paid` and the singular `discount`; subscriptions carry the period bounds;
 *   a discount embeds its coupon.
 * - `acacia` (2024-09-30.acacia up to basil): the same objects plus pretax credit amounts.
 * - `basil` (2025-03-31.basil and later, including the vendored dahlia contract): period bounds
 *   move onto subscription items, invoices lose their payment links and `discount`, and a
 *   discount names its coupon through `source`.
 */
export type ApiEra = "legacy" | "acacia" | "basil"

const ACACIA_START = "2024-09-30"
const BASIL_START = "2025-03-31"

/** A `Stripe-Version` value Stripe accepts: a date, optionally followed by a release name. */
export const isApiVersion = (value: string): boolean => /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(value)

export const eraOf = (version: string): ApiEra => {
  const date = version.slice(0, 10)
  if (date < ACACIA_START) return "legacy"
  if (date < BASIL_START) return "acacia"
  return "basil"
}
