import {
  jsonResponse,
  type OperationContext,
  type OperationHandler,
} from "@crvouga/mockingbird-service"
import { invalidRequest, parameterInvalidEmpty, resourceMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import { mergeMetadata, optionalBoolean, parseUnitAmountDecimal, strip } from "./fields.js"
import { changedFields, type RequestScope, requestScope, type Services } from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams, SUPPORTED_CURRENCIES } from "./params.js"
import { createProduct, requireProduct, validateInlineProduct } from "./products.js"
import { renderPrice, renderProduct } from "./render.js"
import { type PriceRecord, type Recurring, seconds } from "./state.js"

/** Stripe caps recurring periods at three years. */
const MAX_INTERVAL_COUNT: Record<Recurring["interval"], { limit: number; adjective: string }> = {
  day: { limit: 1095, adjective: "daily" },
  week: { limit: 156, adjective: "weekly" },
  month: { limit: 36, adjective: "monthly" },
  year: { limit: 3, adjective: "yearly" },
}

export const normalizeCurrency = (raw: string, param = "currency") => {
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

const assertLookupKeyFree = (
  scope: RequestScope,
  lookupKey: string,
  selfId: string | undefined,
  transfer: boolean,
) => {
  const clashes = scope.account.prices.list({
    where: (price) => price.lookup_key === lookupKey && price.id !== selfId,
  })
  const clash = clashes[0]
  if (!clash) return
  if (transfer) {
    scope.account.prices.update(clash.id, { ...clash.value, lookup_key: null })
    return
  }
  throw invalidRequest(`A price (\`${clash.id}\`) already uses that lookup key.`, "lookup_key")
}

const applyShared = (scope: RequestScope, current: PriceRecord, params: Params): PriceRecord => {
  const next: PriceRecord = { ...current }
  next.active = optionalBoolean(params, "active", current.active) ?? true
  if (params.lookup_key !== undefined) {
    const lookupKey =
      strip(params.lookup_key as string) === "" ? null : (params.lookup_key as string)
    if (lookupKey !== null && lookupKey !== current.lookup_key)
      assertLookupKeyFree(scope, lookupKey, current.id, params.transfer_lookup_key === true)
    next.lookup_key = lookupKey
  }
  next.metadata = mergeMetadata(current.metadata, params.metadata)
  if (params.nickname !== undefined) next.nickname = strip(params.nickname as string)
  if (params.tax_behavior !== undefined)
    next.tax_behavior = params.tax_behavior as PriceRecord["tax_behavior"]
  return next
}

const expanders = (scope: RequestScope): ExpandResolvers => ({
  product: (id) => {
    const product = scope.account.products.get(id)
    return product ? renderProduct(product) : undefined
  },
})

export const priceHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, price: PriceRecord, params: Params) =>
    applyExpand(renderPrice(price), params.expand, expanders(scope))

  return {
    PostPrices: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const hasProduct = params.product !== undefined
      const hasProductData = params.product_data !== undefined
      if (hasProduct && hasProductData)
        throw invalidRequest(
          "You may only specify one of these parameters: product, product_data.",
          "product",
        )
      if (!hasProduct && !hasProductData)
        throw invalidRequest(
          "You must specify either `product` or `product_data` when creating a price.",
        )
      if (params.product === "") throw parameterInvalidEmpty("product")
      if (params.product_data === "") throw parameterInvalidEmpty("product_data")
      const inline = hasProductData
        ? validateInlineProduct(params.product_data as Params)
        : undefined
      const existing = hasProduct
        ? requireProduct(scope, params.product as string, "product", 400)
        : undefined
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
      const id = scope.ids.next("price_", 24)
      const base: PriceRecord = {
        id,
        active: true,
        created: seconds(scope.now),
        currency,
        lookup_key: null,
        metadata: {},
        nickname: null,
        product: existing?.id ?? "",
        recurring,
        tax_behavior: "unspecified",
        unit_amount_decimal,
      }
      const price = applyShared(scope, base, params)
      // Every complaint has been raised by now, so the inline product can be created atomically.
      if (inline) {
        const product = createProduct(scope, seconds(scope.now), inline)
        price.product = product.id
        scope.emit("product.created", renderProduct(product))
      }
      scope.account.prices.insert(id, price)
      scope.emit("price.created", render(scope, price, params))
      return jsonResponse(200, render(scope, price, params))
    },

    GetPrices: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const currency =
        typeof params.currency === "string" ? normalizeCurrency(params.currency) : undefined
      const productId = params.product
      if (typeof productId === "string" && productId !== "")
        requireProduct(scope, productId, "product", 400)
      const lookupKeys = params.lookup_keys as string[] | undefined
      const recurring = params.recurring as
        | { interval?: string; usage_type?: string }
        | ""
        | undefined
      const page = await paginate<PriceRecord>(scope.account.prices, params, {
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
      return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
    },

    GetPricesPrice: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const id = context.params.price ?? ""
      const price = scope.account.prices.get(id)
      if (!price) throw resourceMissing("price", id, "price")
      return jsonResponse(200, render(scope, price, params))
    },

    PostPricesPrice: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.price ?? ""
      const current = scope.account.prices.get(id)
      if (!current) throw resourceMissing("price", id, "price")
      const price = applyShared(scope, current, params)
      scope.account.prices.update(id, price)
      scope.emit(
        "price.updated",
        renderPrice(price),
        changedFields(renderPrice(current), renderPrice(price)),
      )
      return jsonResponse(200, render(scope, price, params))
    },
  }
}
