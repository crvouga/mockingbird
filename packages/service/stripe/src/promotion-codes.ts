import {
  jsonResponse,
  type OperationContext,
  type OperationHandler,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import {
  changedFields,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireCoupon,
  requireLiveCustomer,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderPromotionCode } from "./render.js"
import type { PromotionCodeRecord } from "./state.js"
import { seconds } from "./state.js"

type RecordValue = Record<string, unknown>
type Restrictions = PromotionCodeRecord["restrictions"]

type RawForm = Record<string, unknown>

const formRecord = (context: OperationContext): RawForm => {
  if (
    context.body.kind !== "form" ||
    typeof context.body.value !== "object" ||
    context.body.value === null
  )
    return {}
  return context.body.value
}

const parsedBody = (
  context: OperationContext,
  omitted: readonly string[],
  injectPromotion: boolean,
): Params => {
  const raw = formRecord(context)
  const value = { ...raw }
  for (const key of omitted) {
    // The schema now accepts open nested objects; strip only empty strings, which Stripe treats
    // as an unset value and which the object parser otherwise rejects.
    if (value[key] === "") delete value[key]
  }
  if (injectPromotion && value.promotion === undefined) {
    const coupon = raw.coupon
    value.promotion = { type: "coupon", coupon: typeof coupon === "string" ? coupon : "" }
  }
  return bodyParams({ ...context, body: { kind: "form", value } })
}

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const boolOf = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true"
  return fallback
}

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

const restrictionsOf = (value: unknown): Restrictions | undefined => {
  if (value === undefined) return undefined
  if (value === "" || typeof value !== "object" || value === null || Array.isArray(value))
    return { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null }
  const source = value as RawForm
  const currency = source.minimum_amount_currency
  return {
    first_time_transaction: boolOf(source.first_time_transaction, false),
    minimum_amount: numberOrNull(source.minimum_amount),
    minimum_amount_currency: typeof currency === "string" && currency !== "" ? currency : null,
  }
}

/** Coupon expansion (and `coupon.applies_to`) is applied generically after the handler. */
const renderPromotionExpanded = (
  scope: RequestScope,
  promotion: PromotionCodeRecord,
  _expand: unknown,
): RecordValue => renderPromotionCode(promotion, scope.account)

export const promotionCodeHandlers = (services: Services): Record<string, OperationHandler> => {
  const create: OperationHandler = async (context) => {
    const scope = requestScope(services, context)
    const params = parsedBody(context, ["metadata", "restrictions"], true)
    const raw = formRecord(context)
    const promotion = raw.promotion
    const nestedCoupon =
      typeof promotion === "object" && promotion !== null && !Array.isArray(promotion)
        ? (promotion as RawForm).coupon
        : undefined
    const couponId = typeof raw.coupon === "string" && raw.coupon !== "" ? raw.coupon : nestedCoupon
    if (typeof couponId !== "string" || couponId === "") throw parameterMissing("coupon")
    requireCoupon(scope, couponId)
    const customer = stringOf(params, "customer")
    if (customer !== null) requireLiveCustomer(scope, customer)
    const code =
      stringOf(params, "code") ?? opaqueToken(scope.ids.next("promo_code_"), 8).toUpperCase()
    const clash = scope.account.promotionCodes.list({
      where: (record) => record.active && record.code.toLowerCase() === code.toLowerCase(),
    })[0]
    if (clash !== undefined)
      throw invalidRequest(`An active promotion code with \`code: ${code}\` already exists.`)
    const restrictions = restrictionsOf(raw.restrictions) ?? {
      first_time_transaction: false,
      minimum_amount: null,
      minimum_amount_currency: null,
    }
    const id = scope.ids.next("promo_", 24)
    const record: PromotionCodeRecord = {
      id,
      active: typeof params.active === "boolean" ? params.active : true,
      code,
      coupon: couponId,
      created: seconds(scope.now),
      customer,
      expires_at: typeof params.expires_at === "number" ? params.expires_at : null,
      max_redemptions: typeof params.max_redemptions === "number" ? params.max_redemptions : null,
      metadata: mergeRecordMetadata({}, raw.metadata),
      restrictions,
      times_redeemed: 0,
    }
    scope.account.promotionCodes.insert(id, record)
    scope.emit("promotion_code.created", renderPromotionCode(record, scope.account))
    return jsonResponse(200, renderPromotionExpanded(scope, record, params.expand))
  }

  return {
    GetPromotionCodes: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const code = stringOf(params, "code")
      const customer = stringOf(params, "customer")
      const coupon = stringOf(params, "coupon")
      const active = typeof params.active === "boolean" ? params.active : undefined
      const page = await paginate(scope.account.promotionCodes, params, {
        url: "/v1/promotion_codes",
        kind: "promotion code",
        where: (record) =>
          matchesCreated(record.created, params.created) &&
          (code === null || record.code === code) &&
          (customer === null || record.customer === customer) &&
          (coupon === null || record.coupon === coupon) &&
          (active === undefined || record.active === active),
        render: (record) => renderPromotionExpanded(scope, record, params.expand),
      })
      return jsonResponse(200, page)
    },
    PostPromotionCodes: create,
    GetPromotionCodesPromotionCode: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const id = context.params.promotion_code ?? ""
      const record = scope.account.promotionCodes.get(id)
      if (!record) throw resourceMissing("promotion code", id, "promotion_code")
      return jsonResponse(200, renderPromotionExpanded(scope, record, params.expand))
    },
    PostPromotionCodesPromotionCode: async (context) => {
      const scope = requestScope(services, context)
      const params = parsedBody(context, ["metadata", "restrictions"], false)
      const id = context.params.promotion_code ?? ""
      const current = scope.account.promotionCodes.get(id)
      if (!current) throw resourceMissing("promotion code", id, "promotion_code")
      const raw = formRecord(context)
      const restrictions = restrictionsOf(raw.restrictions)
      const next: PromotionCodeRecord = {
        ...current,
        active: typeof params.active === "boolean" ? params.active : current.active,
        metadata: mergeRecordMetadata(current.metadata, raw.metadata),
        restrictions: restrictions ?? current.restrictions,
      }
      if (next.active && !current.active) {
        const clash = scope.account.promotionCodes.list({
          where: (record) =>
            record.id !== id &&
            record.active &&
            record.code.toLowerCase() === next.code.toLowerCase(),
        })[0]
        if (clash !== undefined)
          throw invalidRequest(
            `An active promotion code with \`code: ${next.code}\` already exists.`,
          )
      }
      scope.account.promotionCodes.update(id, next)
      scope.emit(
        "promotion_code.updated",
        renderPromotionCode(next, scope.account),
        changedFields(
          renderPromotionCode(current, scope.account),
          renderPromotionCode(next, scope.account),
        ),
      )
      return jsonResponse(200, renderPromotionExpanded(scope, next, params.expand))
    },
  }
}
