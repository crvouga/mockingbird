import {
  jsonResponse,
  type OperationContext,
  type OperationHandler,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing, StripeError } from "./errors.js"
import {
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireCoupon,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderCoupon, renderDeletedCoupon } from "./render.js"
import type { CouponRecord } from "./state.js"
import { seconds } from "./state.js"

type RecordValue = Record<string, unknown>
type CurrencyOption = { amount_off: number }

const formRecord = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "form" ||
    typeof context.body.value !== "object" ||
    context.body.value === null
  )
    return {}
  return context.body.value
}

/** Parse body fields while preserving Stripe's empty-string unset semantics for nested values. */
const parsedBody = (context: OperationContext, omitted: readonly string[]): Params => {
  const raw = formRecord(context)
  const value = { ...raw }
  for (const key of omitted) {
    // Open nested objects are parsed by the shared form schema; only empty strings need
    // stripping because Stripe treats them as an unset value.
    if (value[key] === "") delete value[key]
  }
  return bodyParams({ ...context, body: { kind: "form", value } })
}

const productsOf = (value: unknown): string[] => {
  if (value === "" || value === undefined) return []
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const products = (value as Record<string, unknown>).products
  if (Array.isArray(products)) return products.filter((id): id is string => typeof id === "string")
  if (typeof products === "string" && products !== "") return [products]
  return []
}

const appliesToOf = (context: OperationContext): string[] | undefined => {
  const raw = formRecord(context)
  if (!("applies_to" in raw)) return undefined
  return productsOf(raw.applies_to)
}

const currencyOptionsOf = (value: unknown): Record<string, CurrencyOption> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const result: Record<string, CurrencyOption> = {}
  for (const [currency, option] of Object.entries(value)) {
    if (typeof option !== "object" || option === null || Array.isArray(option)) continue
    const amount = (option as Record<string, unknown>).amount_off
    if (typeof amount === "number") result[currency] = { amount_off: amount }
  }
  return result
}

/** `applies_to` is includable: the generic expansion step adds it when asked for. */
const renderCouponExpanded = (
  _scope: RequestScope,
  coupon: CouponRecord,
  _expand: unknown,
): RecordValue => renderCoupon(coupon)

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

export const couponHandlers = (services: Services): Record<string, OperationHandler> => {
  const create: OperationHandler = async (context) => {
    const scope = requestScope(services, context)
    const params = parsedBody(context, ["applies_to", "metadata"])
    const raw = formRecord(context)
    const amountOff = typeof params.amount_off === "number" ? params.amount_off : null
    const percentOff = typeof params.percent_off === "number" ? params.percent_off : null
    const currency = stringOf(params, "currency")
    if (amountOff === null && percentOff === null) throw parameterMissing("amount_off")
    if (amountOff !== null && currency === null) throw parameterMissing("currency")
    if (amountOff !== null && percentOff !== null)
      throw invalidRequest("You must provide either amount_off or percent_off, but not both.")
    const duration = params.duration
    if (duration !== "once" && duration !== "repeating" && duration !== "forever")
      throw parameterMissing("duration")
    const durationInMonths =
      typeof params.duration_in_months === "number" ? params.duration_in_months : null
    if (duration === "repeating" && durationInMonths === null)
      throw parameterMissing("duration_in_months")
    const requested =
      stringOf(params, "id") ?? (typeof raw.id === "string" && raw.id !== "" ? raw.id : null)
    if (requested !== null && scope.account.coupons.get(requested))
      throw new StripeError({
        status: 400,
        code: "resource_already_exists",
        message: "Coupon already exists.",
        param: "id",
      })
    const id = requested ?? opaqueToken(scope.ids.next("coupon_"), 8)
    const record: CouponRecord = {
      id,
      amount_off: amountOff,
      applies_to_products: productsOf(raw.applies_to),
      created: seconds(scope.now),
      currency: amountOff === null ? null : currency,
      currency_options: currencyOptionsOf(params.currency_options),
      duration,
      duration_in_months: durationInMonths,
      livemode: false,
      max_redemptions: typeof params.max_redemptions === "number" ? params.max_redemptions : null,
      metadata: mergeRecordMetadata({}, raw.metadata),
      name: stringOf(params, "name"),
      percent_off: percentOff,
      redeem_by: typeof params.redeem_by === "number" ? params.redeem_by : null,
      times_redeemed: 0,
      valid: true,
    }
    scope.account.coupons.insert(id, record)
    scope.emit("coupon.created", renderCoupon(record))
    return jsonResponse(200, renderCouponExpanded(scope, record, params.expand))
  }

  return {
    GetCoupons: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const page = await paginate(scope.account.coupons, params, {
        url: "/v1/coupons",
        kind: "coupon",
        where: (record) => matchesCreated(record.created, params.created),
        render: (record) => renderCouponExpanded(scope, record, params.expand),
      })
      return jsonResponse(200, page)
    },
    PostCoupons: create,
    GetCouponsCoupon: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const coupon = requireCoupon(scope, context.params.coupon ?? "")
      return jsonResponse(200, renderCouponExpanded(scope, coupon, params.expand))
    },
    DeleteCouponsCoupon: async (context) => {
      const scope = requestScope(services, context)
      const coupon = requireCoupon(scope, context.params.coupon ?? "")
      scope.account.coupons.delete(coupon.id)
      scope.emit("coupon.deleted", renderCoupon({ ...coupon, valid: false }))
      return jsonResponse(200, renderDeletedCoupon(coupon.id))
    },
    PostCouponsCoupon: async (context) => {
      const scope = requestScope(services, context)
      const params = parsedBody(context, ["applies_to", "metadata"])
      const current = requireCoupon(scope, context.params.coupon ?? "")
      const appliesTo = appliesToOf(context)
      const next: CouponRecord = {
        ...current,
        applies_to_products: appliesTo === undefined ? current.applies_to_products : appliesTo,
        metadata: mergeRecordMetadata(current.metadata, formRecord(context).metadata),
        name: params.name === undefined ? current.name : stringOf(params, "name"),
        valid: current.max_redemptions === null || current.times_redeemed < current.max_redemptions,
      }
      scope.account.coupons.update(next.id, next)
      return jsonResponse(200, renderCouponExpanded(scope, next, params.expand))
    },
  }
}
