import { jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterInvalidEmpty, resourceMissing } from "./errors.js"
import {
  mergeMetadata,
  optionalBoolean,
  parseUnitAmountDecimal,
  strip,
  unitAmountOf,
} from "./fields.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams, SUPPORTED_CURRENCIES } from "./params.js"
import { requireProduct } from "./products.js"
import { type PriceRecord, type Recurring, type StripeState, seconds } from "./state.js"

/** Stripe caps recurring periods at three years. */
const MAX_INTERVAL_COUNT: Record<Recurring["interval"], { limit: number; adjective: string }> = {
  day: { limit: 1095, adjective: "daily" },
  week: { limit: 156, adjective: "weekly" },
  month: { limit: 36, adjective: "monthly" },
  year: { limit: 3, adjective: "yearly" },
}

const renderPrice = (price: PriceRecord) => ({
  id: price.id,
  object: "price",
  active: price.active,
  billing_scheme: "per_unit",
  created: price.created,
  currency: price.currency,
  custom_unit_amount: null,
  livemode: false,
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
          meter: null,
          trial_period_days: null,
          usage_type: price.recurring.usage_type,
        },
  tax_behavior: price.tax_behavior,
  tiers_mode: null,
  transform_quantity: null,
  type: price.recurring === null ? "one_time" : "recurring",
  unit_amount: unitAmountOf(price.unit_amount_decimal),
  unit_amount_decimal: price.unit_amount_decimal,
})

const normalizeCurrency = (raw: string, param = "currency") => {
  const currency = raw.toLowerCase()
  if (!SUPPORTED_CURRENCIES.includes(currency))
    throw invalidRequest(
      `Invalid currency: ${raw}. Stripe currently supports these currencies: ${SUPPORTED_CURRENCIES.join(", ")}`,
      param,
    )
  return currency
}

const parseRecurring = (raw: unknown): Recurring => {
  const input = raw as {
    interval: Recurring["interval"]
    interval_count?: number
    usage_type?: Recurring["usage_type"]
  }
  const interval_count = input.interval_count ?? 1
  const cap = MAX_INTERVAL_COUNT[input.interval]
  if (interval_count > cap.limit)
    throw invalidRequest(
      `The interval_count for ${cap.adjective} prices can't be greater than ${cap.limit}`,
      "recurring[interval_count]",
    )
  const usage_type = input.usage_type ?? "licensed"
  if (usage_type === "metered")
    throw invalidRequest(
      "Starting with Stripe version `2025-03-31.basil`, metered prices must be backed by meters.",
    )
  return { interval: input.interval, interval_count, usage_type }
}

const assertLookupKeyFree = async (
  state: StripeState,
  lookupKey: string,
  selfId: string | undefined,
) => {
  const clashes = await state.prices.list({
    where: (price) => price.lookup_key === lookupKey && price.id !== selfId,
  })
  const clash = clashes[0]
  if (clash)
    throw invalidRequest(`A price (\`${clash.id}\`) already uses that lookup key.`, "lookup_key")
}

const applyShared = async (
  state: StripeState,
  current: PriceRecord,
  params: Params,
): Promise<PriceRecord> => {
  const next: PriceRecord = { ...current }
  next.active = optionalBoolean(params, "active", current.active) ?? true
  if (params.lookup_key !== undefined)
    next.lookup_key =
      strip(params.lookup_key as string) === "" ? null : (params.lookup_key as string)
  if (next.lookup_key !== null && next.lookup_key !== current.lookup_key)
    await assertLookupKeyFree(state, next.lookup_key, current.id)
  next.metadata = mergeMetadata(current.metadata, params.metadata)
  if (params.nickname !== undefined) next.nickname = strip(params.nickname as string)
  if (params.tax_behavior !== undefined)
    next.tax_behavior = params.tax_behavior as PriceRecord["tax_behavior"]
  return next
}

export const priceHandlers = (state: StripeState) => ({
  PostPrices: async (context: OperationContext) => {
    const params = bodyParams(context)
    if (params.product === undefined)
      throw invalidRequest(
        "You must specify either `product` or `product_data` when creating a price.",
      )
    if (params.product === "") throw parameterInvalidEmpty("product")
    const product = await requireProduct(state, params.product as string, "product", 400)
    const currency = normalizeCurrency(params.currency as string)
    const hasAmount = params.unit_amount !== undefined
    const hasDecimal = params.unit_amount_decimal !== undefined
    if (hasAmount && hasDecimal)
      throw invalidRequest(
        "You may only specify one of these parameters: unit_amount, unit_amount_decimal.",
        "unit_amount",
      )
    if (!hasAmount && !hasDecimal)
      throw invalidRequest(
        "Prices require an `unit_amount` or `unit_amount_decimal` parameter to be set.",
      )
    let unit_amount_decimal: string
    if (hasAmount) {
      const amount = params.unit_amount as number
      if (amount < 0) throw invalidRequest("Invalid non-negative integer", "unit_amount")
      unit_amount_decimal = String(amount)
    } else {
      unit_amount_decimal = parseUnitAmountDecimal(
        params.unit_amount_decimal as string,
        "unit_amount_decimal",
      )
    }
    const recurring =
      params.recurring === undefined || params.recurring === ""
        ? null
        : parseRecurring(params.recurring)
    const id = await state.ids.next("price_", 24)
    const base: PriceRecord = {
      id,
      active: true,
      created: seconds(context.now),
      currency,
      lookup_key: null,
      metadata: {},
      nickname: null,
      product: product.id,
      recurring,
      tax_behavior: "unspecified",
      unit_amount_decimal,
    }
    const price = await applyShared(state, base, params)
    await state.prices.insert(id, price)
    return jsonResponse(200, renderPrice(price))
  },

  GetPrices: async (context: OperationContext) => {
    const params = queryParams(context)
    const currency =
      typeof params.currency === "string" ? normalizeCurrency(params.currency) : undefined
    const productId = params.product
    if (typeof productId === "string" && productId !== "")
      await requireProduct(state, productId, "product", 400)
    const lookupKeys = params.lookup_keys as string[] | undefined
    const recurring = params.recurring as
      | { interval?: string; usage_type?: string }
      | ""
      | undefined
    const page = await paginate<PriceRecord>(state.prices, params, {
      url: "/v1/prices",
      kind: "price",
      where: (price) =>
        matchesCreated(price.created, params.created) &&
        (params.active === undefined || price.active === params.active) &&
        (currency === undefined || price.currency === currency) &&
        (typeof productId !== "string" || productId === "" || price.product === productId) &&
        (params.type === undefined ||
          params.type === "" ||
          (price.recurring === null ? "one_time" : "recurring") === params.type) &&
        (lookupKeys === undefined ||
          (price.lookup_key !== null && lookupKeys.includes(price.lookup_key))) &&
        (recurring === undefined ||
          recurring === "" ||
          ((recurring.interval === undefined ||
            recurring.interval === "" ||
            price.recurring?.interval === recurring.interval) &&
            (recurring.usage_type === undefined ||
              recurring.usage_type === "" ||
              price.recurring?.usage_type === recurring.usage_type))),
      render: renderPrice,
    })
    return jsonResponse(200, page)
  },

  GetPricesPrice: async (context: OperationContext) => {
    queryParams(context)
    const id = context.params.price ?? ""
    const price = await state.prices.get(id)
    if (!price) throw resourceMissing("price", id, "price")
    return jsonResponse(200, renderPrice(price))
  },

  PostPricesPrice: async (context: OperationContext) => {
    const params = bodyParams(context)
    const id = context.params.price ?? ""
    const current = await state.prices.get(id)
    if (!current) throw resourceMissing("price", id, "price")
    const price = await applyShared(state, current, params)
    await state.prices.update(id, price)
    return jsonResponse(200, renderPrice(price))
  },
})
