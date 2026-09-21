import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { couponValidNow, parseDiscounts, resolveDiscountSource } from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import {
  intOf,
  type RequestScope,
  recordOf,
  requestScope,
  requirePrice,
  requireSession,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderCheckoutLineItem, renderCheckoutSession } from "./render.js"
import {
  type CheckoutSessionLineRecord,
  type CheckoutSessionRecord,
  type Metadata,
  seconds,
} from "./state.js"

type RequestedLine = {
  priceId: string | null
  product: string | null
  currency: string
  quantity: number
  unitAmount: number
  description: string | null
  recurring: boolean
}

/** `line_items[0][price]` / `line_items[0][price_data][…]`, decoded by the form codec. */
const requestedLines = (scope: RequestScope, params: Params): RequestedLine[] => {
  const raw = params.line_items
  if (!Array.isArray(raw) || raw.length === 0) throw parameterMissing("line_items")
  return raw.map((entry, index) => {
    const line = recordOf(entry) ?? {}
    const quantity = intOf(line.quantity) ?? 1
    const priceId = typeof line.price === "string" && line.price !== "" ? line.price : null
    if (priceId !== null) {
      const price = requirePrice(scope, priceId, `line_items[${index}][price]`)
      const product = scope.account.products.get(price.product)
      return {
        priceId,
        product: price.product,
        currency: price.currency,
        description: product?.name ?? null,
        quantity,
        unitAmount: Math.round(Number(price.unit_amount_decimal)),
        recurring: price.recurring !== null,
      }
    }
    const data = recordOf(line.price_data)
    if (data === undefined) throw parameterMissing(`line_items[${index}][price]`)
    const productId = typeof data.product === "string" && data.product !== "" ? data.product : null
    if (productId !== null && !scope.account.products.get(productId))
      throw resourceMissing("product", productId, `line_items[${index}][price_data][product]`)
    const productData = recordOf(data.product_data)
    const name =
      typeof productData?.name === "string"
        ? productData.name
        : productId === null
          ? null
          : (scope.account.products.get(productId)?.name ?? null)
    return {
      priceId: null,
      product: productId,
      currency: typeof data.currency === "string" ? data.currency : "usd",
      description: name,
      quantity,
      unitAmount: intOf(data.unit_amount) ?? 0,
      recurring: recordOf(data.recurring) !== undefined,
    }
  })
}

/** Line records with their share of every discount (percentage, then fixed amounts in order). */
const sessionLines = (
  scope: RequestScope,
  requested: RequestedLine[],
  discounts: Array<{ coupon: string | null }>,
): CheckoutSessionLineRecord[] => {
  const lines = requested.map((line) => ({
    id: scope.ids.next("li_", 24),
    amount_subtotal: line.unitAmount * line.quantity,
    amount_total: line.unitAmount * line.quantity,
    amount_discount: 0,
    currency: line.currency,
    description: line.description,
    price: line.priceId,
    quantity: line.quantity,
    unit_amount: line.unitAmount,
    product: line.product,
  }))
  for (const discount of discounts) {
    const coupon = discount.coupon === null ? undefined : scope.account.coupons.get(discount.coupon)
    if (!coupon) continue
    let budget = coupon.amount_off ?? Number.POSITIVE_INFINITY
    for (const line of lines) {
      if (
        coupon.applies_to_products.length > 0 &&
        (line.product === null || !coupon.applies_to_products.includes(line.product))
      )
        continue
      const take =
        coupon.percent_off !== null
          ? Math.round((line.amount_total * coupon.percent_off) / 100)
          : Math.min(line.amount_total, budget)
      if (coupon.percent_off === null) budget -= take
      line.amount_discount += take
      line.amount_total -= take
    }
  }
  return lines.map(({ product: _product, ...line }) => line)
}

const MIN_EXPIRY = 30 * 60
const MAX_EXPIRY = 24 * 60 * 60

export const checkoutSessionHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetCheckoutSessions: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const customer = stringOf(params, "customer")
    const status = stringOf(params, "status")
    const paymentIntent = stringOf(params, "payment_intent")
    const subscription = stringOf(params, "subscription")
    return jsonResponse(
      200,
      await paginate<CheckoutSessionRecord>(scope.account.checkoutSessions, params, {
        url: "/v1/checkout/sessions",
        kind: "checkout session",
        where: (record) =>
          matchesCreated(record.created, params.created) &&
          (customer === null || record.customer === customer) &&
          (status === null || record.status === status) &&
          (paymentIntent === null || record.payment_intent === paymentIntent) &&
          (subscription === null || record.subscription === subscription),
        render: renderCheckoutSession,
      }),
    )
  },
  PostCheckoutSessions: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const mode = stringOf(params, "mode") ?? "payment"
    if (mode !== "payment" && mode !== "setup" && mode !== "subscription")
      throw invalidRequest("Invalid mode.", "mode")
    const customer = stringOf(params, "customer")
    if (customer !== null) {
      const entry = scope.account.customers.get(customer)
      if (!entry || entry.kind === "deleted")
        throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
    }
    const successUrl = stringOf(params, "success_url")
    const requested =
      mode === "setup" && params.line_items === undefined ? [] : requestedLines(scope, params)
    if (mode === "subscription" && !requested.some((line) => line.recurring))
      throw invalidRequest(
        "You must provide at least one recurring price in `subscription` mode when using prices.",
        "line_items",
      )
    const discountRequests = parseDiscounts(params.discounts)
    const discountRefs =
      discountRequests === undefined || discountRequests === "clear"
        ? []
        : discountRequests.map((request, index) => {
            const source = resolveDiscountSource(scope, request, `discounts[${index}]`)
            const coupon = scope.account.coupons.get(source.coupon)
            if (coupon && !couponValidNow(coupon, seconds(scope.now)))
              throw invalidRequest(`Coupon expired: ${coupon.id}`, `discounts[${index}][coupon]`)
            return { coupon: source.coupon, promotion_code: source.promotion_code }
          })
    const lines = sessionLines(scope, requested, discountRefs)
    const subtotal = lines.reduce((total, line) => total + line.amount_subtotal, 0)
    const total = lines.reduce((total, line) => total + line.amount_total, 0)
    const currency = lines[0]?.currency ?? stringOf(params, "currency") ?? "usd"
    const now = seconds(scope.now)
    const expiresAt = intOf(params.expires_at)
    if (expiresAt !== undefined && (expiresAt < now + MIN_EXPIRY || expiresAt > now + MAX_EXPIRY))
      throw invalidRequest(
        "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.",
        "expires_at",
      )
    const intentData = recordOf(params.payment_intent_data)
    const subscriptionData = recordOf(params.subscription_data)
    const paymentMethodTypes = params.payment_method_types
    const id = scope.ids.next("cs_test_a1", 56)
    const record: CheckoutSessionRecord = {
      id,
      amount_subtotal: subtotal,
      amount_total: total,
      cancel_url: stringOf(params, "cancel_url"),
      created: now,
      currency,
      customer,
      customer_creation:
        stringOf(params, "customer_creation") ??
        (mode === "payment" && customer === null ? "if_required" : null),
      expires_at: expiresAt ?? now + MAX_EXPIRY,
      line_items: lines,
      livemode: false,
      metadata: (params.metadata as Metadata | undefined) ?? {},
      mode,
      payment_intent: null,
      payment_status: mode === "setup" ? "no_payment_required" : "unpaid",
      setup_intent: null,
      status: "open",
      subscription: null,
      success_url: successUrl,
      url: `${scope.base}/c/pay/${id}`,
      amount_discount: subtotal - total,
      discount_refs: discountRefs,
      payment_intent_data: {
        metadata: (intentData?.metadata as Metadata | undefined) ?? {},
        setup_future_usage:
          typeof intentData?.setup_future_usage === "string" ? intentData.setup_future_usage : null,
        description: typeof intentData?.description === "string" ? intentData.description : null,
      },
      subscription_data: {
        metadata: (subscriptionData?.metadata as Metadata | undefined) ?? {},
        trial_end:
          intOf(subscriptionData?.trial_end) ??
          (intOf(subscriptionData?.trial_period_days) === undefined
            ? null
            : now + (intOf(subscriptionData?.trial_period_days) as number) * 86_400),
      },
      payment_method_types: Array.isArray(paymentMethodTypes)
        ? paymentMethodTypes.filter((type): type is string => typeof type === "string")
        : ["card"],
      invoice: null,
      custom_text: (recordOf(params.custom_text) as Record<string, unknown> | undefined) ?? null,
    }
    scope.account.checkoutSessions.insert(id, record)
    return jsonResponse(200, renderCheckoutSession(record))
  },
  GetCheckoutSessionsSession: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const id = context.params.session ?? ""
    const session = scope.account.checkoutSessions.get(id)
    // Stripe words this one without quotes or a param.
    if (!session)
      throw new StripeError({
        status: 404,
        code: "resource_missing",
        message: `No such checkout.session: ${id}`,
      })
    return jsonResponse(200, renderCheckoutSession(session))
  },
  PostCheckoutSessionsSessionExpire: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = requireSession(scope, context.params.session ?? "")
    if (current.status !== "open")
      throw invalidRequest(
        `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${current.status}".`,
        undefined,
        "checkout_session_not_open",
      )
    const next: CheckoutSessionRecord = { ...current, status: "expired" }
    scope.account.checkoutSessions.update(next.id, next)
    scope.emit("checkout.session.expired", renderCheckoutSession(next))
    return jsonResponse(200, renderCheckoutSession(next))
  },
  GetCheckoutSessionsSessionLineItems: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const session = requireSession(scope, context.params.session ?? "")
    const limit = Math.min(100, Math.max(1, intOf(params.limit) ?? 10))
    return jsonResponse(200, {
      object: "list",
      data: session.line_items
        .slice(0, limit)
        .map((line) => renderCheckoutLineItem(line, scope.account)),
      has_more: session.line_items.length > limit,
      url: `/v1/checkout/sessions/${session.id}/line_items`,
    })
  },
})
