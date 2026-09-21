import type { ApiEra } from "./version.js"

type RecordValue = Record<string, unknown>

/**
 * Renderers produce one superset of every version's fields; this trims it to the fields the
 * requested API version returns. Keyed by the rendered `object`, per era: the fields that era
 * does not have.
 */
const ABSENT: Record<string, Record<ApiEra, readonly string[]>> = {
  invoice: {
    legacy: ["parent", "total_pretax_credit_amounts"],
    acacia: ["parent"],
    basil: [
      "charge",
      "discount",
      "paid",
      "paid_out_of_band",
      "payment_intent",
      "subscription",
      "subscription_details",
    ],
  },
  line_item: {
    legacy: ["parent", "pricing", "pretax_credit_amounts"],
    acacia: ["parent", "pricing"],
    basil: ["invoice_item", "plan", "price", "subscription", "subscription_item", "type"],
  },
  subscription: {
    legacy: [],
    acacia: [],
    basil: ["current_period_end", "current_period_start", "discount"],
  },
  subscription_item: {
    legacy: ["current_period_end", "current_period_start"],
    acacia: ["current_period_end", "current_period_start"],
    basil: [],
  },
  discount: {
    legacy: ["source"],
    acacia: ["source"],
    basil: ["coupon"],
  },
  promotion_code: {
    legacy: ["promotion"],
    acacia: ["promotion"],
    basil: ["coupon"],
  },
  payment_intent: {
    legacy: [],
    acacia: [],
    basil: ["invoice"],
  },
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Trim a rendered response (any depth: lists, expansions, events, error payloads) to `era`. */
export const shapeForEra = (value: unknown, era: ApiEra): unknown => {
  if (Array.isArray(value)) return value.map((item) => shapeForEra(item, era))
  if (!isRecord(value)) return value
  const absent = typeof value.object === "string" ? ABSENT[value.object]?.[era] : undefined
  const out: RecordValue = {}
  for (const [key, inner] of Object.entries(value)) {
    if (absent?.includes(key)) continue
    out[key] = shapeForEra(inner, era)
  }
  return out
}
