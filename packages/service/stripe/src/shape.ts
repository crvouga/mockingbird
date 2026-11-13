import { type ApiEra, REQUEST_CHANGES, versionAtLeast } from "./version.js"

type RecordValue = Record<string, unknown>

/**
 * Renderers produce one superset of every version's fields; this trims it to the fields the
 * requested API version returns. Keyed by the rendered `object`, per era: the fields that era
 * does not have.
 */
const ABSENT: Record<string, Record<ApiEra, readonly string[]>> = {
  invoice: {
    legacy: ["parent", "payments", "total_pretax_credit_amounts"],
    acacia: ["parent", "payments"],
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
  charge: {
    legacy: [],
    acacia: [],
    basil: ["invoice"],
  },
  payment_intent: {
    legacy: [],
    acacia: [],
    basil: ["invoice"],
  },
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Enum values Stripe renamed, keyed by `object` then field: the current name → the name a
 * request pinned before `since` sees. Renderers use the current names.
 */
const RENAMED: Record<string, Record<string, { since: string; names: Record<string, string> }>> = {
  "checkout.session": {
    ui_mode: {
      since: REQUEST_CHANGES.checkoutUiModeRenamed,
      names: { hosted_page: "hosted", embedded_page: "embedded", elements: "custom" },
    },
  },
}

/**
 * Trim a rendered response (any depth: lists, expansions, events, error payloads) to `era`, and
 * with `version` give renamed enum values their names at that version.
 */
export const shapeForEra = (value: unknown, era: ApiEra, version?: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => shapeForEra(item, era, version))
  if (!isRecord(value)) return value
  const object = typeof value.object === "string" ? value.object : undefined
  const absent = object === undefined ? undefined : ABSENT[object]?.[era]
  const renamed = object === undefined ? undefined : RENAMED[object]
  const out: RecordValue = {}
  for (const [key, inner] of Object.entries(value)) {
    if (absent?.includes(key)) continue
    const rename = renamed?.[key]
    if (
      rename !== undefined &&
      version !== undefined &&
      typeof inner === "string" &&
      !versionAtLeast(version, rename.since)
    ) {
      out[key] = rename.names[inner] ?? inner
      continue
    }
    out[key] = shapeForEra(inner, era, version)
  }
  return out
}
