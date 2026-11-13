import {
  jsonResponse,
  type OperationContext,
  type OperationHandler,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import {
  assertCompatiblePrices,
  couponValidNow,
  INACTIVE_PRICE,
  parseDiscounts,
  resolveDiscountSource,
} from "./billing.js"
import { formatMoney } from "./checkout-page.js"
import {
  humanList,
  invalidRequest,
  parameterInvalidEmpty,
  parameterMissing,
  resourceMissing,
  StripeError,
} from "./errors.js"
import { parseUnitAmountDecimal } from "./fields.js"
import {
  booleanOf,
  clientSecretFor,
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
import { bodyParams, type Params, queryParams, requestVersion } from "./params.js"
import { normalizeCurrency, parseRecurring } from "./prices.js"
import { createProduct, validateInlineProduct } from "./products.js"
import { renderCheckoutLineItem, renderCheckoutSession, renderDiscount } from "./render.js"
import {
  type AccountState,
  type CheckoutSessionLineRecord,
  type CheckoutSessionRecord,
  type DiscountRecord,
  type Metadata,
  type PriceRecord,
  seconds,
} from "./state.js"

import { REQUEST_CHANGES, versionAtLeast } from "./version.js"

/**
 * `ui_mode` as the request's API version names it: `hosted` / `embedded` before 2026-03-25.dahlia
 * (plus `custom` from 2025-03-31.basil), `hosted_page` / `embedded_page` / `elements` after;
 * the other version's names are refused like any value outside the enum. Answers the current
 * name. Checkout Elements (`custom` / `elements`) is an explicit emulator limitation.
 */
const uiModeOf = (
  context: OperationContext,
  params: Params,
): { mode: "hosted_page" | "embedded_page"; name: string } => {
  const version = requestVersion(context)
  const allowed = versionAtLeast(version, REQUEST_CHANGES.checkoutUiModeRenamed)
    ? ["elements", "embedded_page", "hosted_page"]
    : versionAtLeast(version, REQUEST_CHANGES.singularDiscountRemoved)
      ? ["custom", "embedded", "hosted"]
      : ["embedded", "hosted"]
  const requested = stringOf(params, "ui_mode")
  if (requested === null) return { mode: "hosted_page", name: allowed.at(-1) as string }
  if (!allowed.includes(requested))
    throw invalidRequest(`Invalid ui_mode: must be one of ${humanList(allowed)}`, "ui_mode")
  if (requested === "custom" || requested === "elements")
    throw invalidRequest(
      `\`ui_mode=${requested}\` (Checkout with Elements) is not modelled by this mock.`,
      "ui_mode",
    )
  return {
    mode:
      requested === "embedded" || requested === "embedded_page" ? "embedded_page" : "hosted_page",
    name: requested,
  }
}

type RequestedLine = {
  priceId: string
  product: string
  currency: string
  quantity: number
  unitAmount: number
  description: string | null
  recurring: boolean
}

/** Inline objects a `price_data` line creates, inserted only once every line validated. */
type InlineObjects = { prices: PriceRecord[]; products: Params[] }

const RECURRING_IN_PAYMENT_MODE =
  "You specified `payment` mode but passed a recurring price. Either switch to `subscription` mode or use only one-time prices."

/**
 * `price_data` on a Checkout line generates a Price inline (inactive, like every inline price),
 * and `price_data[product_data]` a Product, so the line — and a subscription created from it —
 * references a real price id.
 */
const inlineLinePrice = (
  scope: RequestScope,
  data: Params,
  index: number,
  inline: InlineObjects,
): { price: PriceRecord; productName: string | null } => {
  const param = `line_items[${index}][price_data]`
  const productId = typeof data.product === "string" && data.product !== "" ? data.product : null
  const productData = recordOf(data.product_data)
  if (productId !== null && productData !== undefined)
    throw invalidRequest(
      "You may only specify one of these parameters: product, product_data.",
      `${param}[product]`,
    )
  if (productId === null && productData === undefined)
    throw parameterMissing(`${param}[product_data]`)
  const product = productId === null ? undefined : scope.account.products.get(productId)
  if (productId !== null && product === undefined)
    throw resourceMissing("product", productId, `${param}[product]`)
  const hasAmount = data.unit_amount !== undefined
  const hasDecimal = data.unit_amount_decimal !== undefined
  if (hasAmount && hasDecimal)
    throw invalidRequest(
      "You may only specify one of these parameters: unit_amount, unit_amount_decimal.",
      `${param}[unit_amount]`,
    )
  if (!hasAmount && !hasDecimal) throw parameterMissing(`${param}[unit_amount]`)
  const unitAmountDecimal = hasDecimal
    ? parseUnitAmountDecimal(String(data.unit_amount_decimal), `${param}[unit_amount_decimal]`)
    : String(intOf(data.unit_amount) ?? 0)
  const productRecord =
    productData === undefined ? undefined : { ...validateInlineProduct(productData) }
  const newProductId = productRecord === undefined ? null : scope.ids.next("prod_")
  if (productRecord !== undefined && newProductId !== null)
    inline.products.push({ ...productRecord, id: newProductId })
  const taxBehavior = data.tax_behavior
  const price: PriceRecord = {
    id: scope.ids.next("price_", 24),
    active: false,
    created: seconds(scope.now),
    currency: normalizeCurrency(String(data.currency ?? ""), `${param}[currency]`),
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: product?.id ?? (newProductId as string),
    recurring:
      data.recurring === undefined || data.recurring === "" ? null : parseRecurring(data.recurring),
    tax_behavior:
      taxBehavior === "exclusive" || taxBehavior === "inclusive" ? taxBehavior : "unspecified",
    unit_amount_decimal: unitAmountDecimal,
  }
  inline.prices.push(price)
  const productName =
    typeof productData?.name === "string" ? productData.name : (product?.name ?? null)
  return { price, productName }
}

/**
 * What a price charges in the session's `currency`: its own amount by default, or the matching
 * `currency_options` entry. Stripe refuses a currency the price is not offered in.
 */
const chargeIn = (price: PriceRecord, currency: string | undefined, mode: string) => {
  const own = { currency: price.currency, unit_amount_decimal: price.unit_amount_decimal }
  if (currency === undefined || currency === price.currency) return own
  const option = price.currency_options?.[currency]
  if (option === undefined)
    throw invalidRequest(
      `The price specified only supports \`${price.currency}\`. This doesn't match the expected currency: \`${currency}\`.`,
    )
  if (mode === "subscription")
    throw invalidRequest(
      "Subscription Checkout Sessions in a price's currency option are not modelled by this mock.",
      "currency",
    )
  return { currency, unit_amount_decimal: option.unit_amount_decimal }
}

/** `line_items[0][price]` / `line_items[0][price_data][…]`, decoded by the form codec. */
const requestedLines = (
  scope: RequestScope,
  params: Params,
  mode: string,
  inline: InlineObjects,
): RequestedLine[] => {
  const raw = params.line_items
  if (!Array.isArray(raw) || raw.length === 0) throw parameterMissing("line_items")
  const requestedCurrency = stringOf(params, "currency")
  const sessionCurrency =
    requestedCurrency === null ? undefined : normalizeCurrency(requestedCurrency)
  const lines = raw.map((entry, index) => {
    const line = recordOf(entry) ?? {}
    const quantity = intOf(line.quantity) ?? 1
    if (quantity < 1)
      throw invalidRequest(
        "This value must be greater than or equal to 1.",
        `line_items[${index}][quantity]`,
      )
    const priceId = typeof line.price === "string" && line.price !== "" ? line.price : null
    const data = recordOf(line.price_data)
    if (priceId !== null && data !== undefined)
      throw invalidRequest(
        "You may only specify one of these parameters: price, price_data.",
        `line_items[${index}][price]`,
      )
    let price: PriceRecord
    let name: string | null
    if (priceId !== null) {
      price = requirePrice(scope, priceId, `line_items[${index}][price]`)
      if (!price.active) throw invalidRequest(INACTIVE_PRICE, `line_items[${index}][price]`)
      name = scope.account.products.get(price.product)?.name ?? null
    } else {
      if (data === undefined) throw parameterMissing(`line_items[${index}][price]`)
      const created = inlineLinePrice(scope, data, index, inline)
      price = created.price
      name = created.productName
    }
    if (mode === "payment" && price.recurring !== null)
      throw invalidRequest(RECURRING_IN_PAYMENT_MODE, `line_items[${index}]`)
    const charge = chargeIn(price, sessionCurrency, mode)
    return {
      priceId: price.id,
      product: price.product,
      currency: charge.currency,
      description: name,
      quantity,
      unitAmount: Math.round(Number(charge.unit_amount_decimal)),
      recurring: price.recurring !== null,
    }
  })
  const currency = lines[0]?.currency
  lines.forEach((line, index) => {
    if (line.currency !== currency)
      throw invalidRequest(
        `The line items must all use the same currency, but line_items[${index}] is in ${line.currency.toUpperCase()} and line_items[0] is in ${String(currency).toUpperCase()}.`,
        `line_items[${index}]`,
      )
  })
  if (mode === "subscription")
    assertCompatiblePrices(
      lines
        .filter((line) => line.recurring)
        .map(
          (line) =>
            inline.prices.find((price) => price.id === line.priceId) ??
            requirePrice(scope, line.priceId),
        ),
      "line_items",
    )
  return lines
}

/** Line records with their share of every discount (percentage, then fixed amounts in order). */
const sessionLines = (
  scope: RequestScope,
  requested: RequestedLine[],
  discounts: ReadonlyArray<{ coupon: string | null }>,
): CheckoutSessionLineRecord[] =>
  discountLines(
    scope,
    requested.map((line) => ({
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
    })),
    discounts,
  )

/** Spread each discount over the lines it applies to, from their undiscounted amounts. */
const discountLines = (
  scope: Pick<RequestScope, "account">,
  base: CheckoutSessionLineRecord[],
  discounts: ReadonlyArray<{ coupon: string | null }>,
): CheckoutSessionLineRecord[] => {
  const lines = base.map((line) => ({
    ...line,
    amount_discount: 0,
    amount_total: line.amount_subtotal,
  }))
  for (const discount of discounts) {
    const coupon = discount.coupon === null ? undefined : scope.account.coupons.get(discount.coupon)
    if (!coupon) continue
    let budget = coupon.amount_off ?? Number.POSITIVE_INFINITY
    for (const line of lines) {
      const product =
        line.product ??
        (line.price === null ? null : (scope.account.prices.get(line.price)?.product ?? null))
      if (
        coupon.applies_to_products.length > 0 &&
        (product === null || !coupon.applies_to_products.includes(product))
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
  return lines
}

/**
 * `total_details.breakdown` (only when expanded, as Stripe's includable field): each discount's
 * share of the session total and the discount as an object; no taxes. The discount objects of a
 * session that has not created a subscription are synthesised with stable ids derived from the
 * session (best guess, not oracle-verified: Stripe creates them on its side).
 */
export const checkoutBreakdown = (
  account: AccountState,
  sessionId: string,
): Record<string, unknown> | undefined => {
  const session = account.checkoutSessions.get(sessionId)
  if (!session) return undefined
  const refs = session.discount_refs ?? []
  const subscription =
    session.subscription === null ? undefined : account.subscriptions.get(session.subscription)
  const totalWith = (count: number) =>
    discountLines({ account }, session.line_items, refs.slice(0, count)).reduce(
      (sum, line) => sum + (line.amount_discount ?? 0),
      0,
    )
  const discounts = refs.map((ref, index) => {
    const existing = subscription?.discount_ids
      .map((id) => account.discounts.get(id))
      .find((record) => record?.coupon === ref.coupon)
    const record: DiscountRecord = existing ?? {
      id: `di_${opaqueToken(`${session.id}:discount:${index}`, 24)}`,
      coupon: ref.coupon ?? "",
      promotion_code: ref.promotion_code,
      customer: session.customer,
      subscription: null,
      checkout_session: session.id,
      start: session.created,
      end: null,
    }
    return {
      amount: totalWith(index + 1) - totalWith(index),
      discount: renderDiscount(record, account),
    }
  })
  return { discounts, taxes: [] }
}

/** Re-price an open session after a promotion code is applied or removed on the hosted page. */
export const repriceSession = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  discountRefs: Array<{ coupon: string | null; promotion_code: string | null }>,
): CheckoutSessionRecord => {
  const lines = discountLines(scope, session.line_items, discountRefs)
  const subtotal = lines.reduce((total, line) => total + line.amount_subtotal, 0)
  const total = lines.reduce((total, line) => total + line.amount_total, 0)
  const next: CheckoutSessionRecord = {
    ...session,
    line_items: lines,
    amount_subtotal: subtotal,
    amount_total: total,
    amount_discount: subtotal - total,
    discount_refs: discountRefs,
  }
  scope.account.checkoutSessions.update(session.id, next)
  return next
}

/** Is there an earlier successful payment by this customer (promotion code first-time rules)? */
const hasPaidBefore = (scope: RequestScope, customer: string | null) =>
  customer !== null &&
  scope.account.charges.list({
    where: (charge) => charge.customer === customer && charge.status === "succeeded",
  }).length > 0

/**
 * The promotion code a shopper typed on the hosted page, as Checkout checks it: case-insensitive,
 * active, unexpired, under its redemption limits, for this customer, first-time and minimum-amount
 * restrictions met. Answers the discount to apply or the message Checkout shows.
 */
export const promotionCodeFor = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  code: string,
): { coupon: string; promotion_code: string } | { error: string } => {
  const invalid = { error: "This code is invalid." }
  const wanted = code.trim().toLowerCase()
  if (wanted === "") return invalid
  const promotion = scope.account.promotionCodes
    .list({ order: "newest", where: (entry) => entry.code.toLowerCase() === wanted })
    .map((entry) => entry.value)
    .find((entry) => entry.active)
  if (!promotion) return invalid
  if (promotion.customer !== null && promotion.customer !== session.customer) return invalid
  let source: { coupon: string; promotion_code: string | null }
  try {
    source = resolveDiscountSource(scope, { promotion_code: promotion.id }, "promotion_code")
  } catch (error) {
    if (error instanceof StripeError) return invalid
    throw error
  }
  const restrictions = promotion.restrictions
  if (restrictions.first_time_transaction && hasPaidBefore(scope, session.customer))
    return { error: "This code is only valid for first-time customers." }
  if (
    restrictions.minimum_amount !== null &&
    (restrictions.minimum_amount_currency === null ||
      restrictions.minimum_amount_currency === session.currency) &&
    session.amount_subtotal < restrictions.minimum_amount
  )
    return {
      error: `This code requires a minimum order of ${formatMoney(restrictions.minimum_amount, session.currency)}.`,
    }
  const coupon = scope.account.coupons.get(source.coupon)
  if (
    coupon &&
    coupon.applies_to_products.length > 0 &&
    !session.line_items.some(
      (line) => line.product != null && coupon.applies_to_products.includes(line.product),
    )
  )
    return { error: "This code is not valid for the items in your order." }
  return { coupon: source.coupon, promotion_code: promotion.id }
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
    const customerEmail = stringOf(params, "customer_email")
    if (customer !== null && customerEmail !== null)
      throw invalidRequest(
        "You may only specify one of these parameters: customer, customer_email.",
        "customer",
      )
    if (customer !== null) {
      const entry = scope.account.customers.get(customer)
      if (!entry || entry.kind === "deleted")
        throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
    }
    if (params.customer_creation !== undefined && mode !== "payment")
      throw invalidRequest(
        "`customer_creation` can only be used in `payment` mode.",
        "customer_creation",
      )
    if (params.payment_intent_data !== undefined && mode !== "payment")
      throw invalidRequest(
        `You can not pass \`payment_intent_data\` in \`${mode}\` mode.`,
        "payment_intent_data",
      )
    if (params.subscription_data !== undefined && mode !== "subscription")
      throw invalidRequest(
        `You can not pass \`subscription_data\` in \`${mode}\` mode.`,
        "subscription_data",
      )
    const allowPromotionCodes = booleanOf(params.allow_promotion_codes)
    if (allowPromotionCodes !== undefined && params.discounts !== undefined)
      throw invalidRequest(
        "You may only specify one of these parameters: allow_promotion_codes, discounts.",
        "allow_promotion_codes",
      )
    const successUrl = stringOf(params, "success_url")
    const uiMode = uiModeOf(context, params)
    const returnUrl = stringOf(params, "return_url")
    // Best guess, not oracle-verified: an embedded session redirects only to `return_url`, and a
    // hosted one has no use for it.
    if (uiMode.mode === "embedded_page") {
      for (const param of ["success_url", "cancel_url"])
        if (params[param] !== undefined)
          throw invalidRequest(
            `You cannot pass \`${param}\` when \`ui_mode\` is \`${uiMode.name}\`.`,
            param,
          )
      if (returnUrl === null)
        throw invalidRequest(
          `\`return_url\` is required when \`ui_mode\` is \`${uiMode.name}\`.`,
          "return_url",
        )
    } else if (returnUrl !== null)
      throw invalidRequest(
        `You can only pass \`return_url\` when \`ui_mode\` is \`${uiMode.name === "hosted" ? "embedded" : "embedded_page"}\`.`,
        "return_url",
      )
    const inline: InlineObjects = { prices: [], products: [] }
    const requested =
      mode === "setup" && params.line_items === undefined
        ? []
        : requestedLines(scope, params, mode, inline)
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
    const now = seconds(scope.now)
    const expiresAt = intOf(params.expires_at)
    if (expiresAt !== undefined && (expiresAt < now + MIN_EXPIRY || expiresAt > now + MAX_EXPIRY))
      throw invalidRequest(
        "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.",
        "expires_at",
      )
    const intentData = recordOf(params.payment_intent_data)
    const subscriptionData = recordOf(params.subscription_data)
    const trialDays = intOf(subscriptionData?.trial_period_days)
    const trialEndAt = intOf(subscriptionData?.trial_end)
    if (trialDays !== undefined && trialEndAt !== undefined)
      throw invalidRequest(
        "You may only specify one of these parameters: subscription_data[trial_end], subscription_data[trial_period_days].",
        "subscription_data[trial_end]",
      )
    if (trialEndAt !== undefined && trialEndAt < now + 2 * 86_400)
      throw invalidRequest(
        "`subscription_data[trial_end]` must be at least 48 hours in the future.",
        "subscription_data[trial_end]",
      )
    const trialBehavior = recordOf(
      recordOf(subscriptionData?.trial_settings)?.end_behavior,
    )?.missing_payment_method
    const collection = stringOf(params, "payment_method_collection")
    // Every parameter is valid: the inline catalog objects the lines reference can be stored.
    for (const product of inline.products) {
      const { id: productId, ...fields } = product
      createProduct(scope, now, fields, productId as string)
    }
    for (const price of inline.prices) scope.account.prices.insert(price.id, price)
    const lines = sessionLines(scope, requested, discountRefs)
    const subtotal = lines.reduce((total, line) => total + line.amount_subtotal, 0)
    const total = lines.reduce((total, line) => total + line.amount_total, 0)
    const currency = lines[0]?.currency ?? stringOf(params, "currency") ?? "usd"
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
        ...(intentData?.capture_method === "manual" ||
        intentData?.capture_method === "automatic" ||
        intentData?.capture_method === "automatic_async"
          ? { capture_method: intentData.capture_method }
          : {}),
      },
      subscription_data: {
        metadata: (subscriptionData?.metadata as Metadata | undefined) ?? {},
        trial_end: trialEndAt ?? (trialDays === undefined ? null : now + trialDays * 86_400),
        description:
          typeof subscriptionData?.description === "string" ? subscriptionData.description : null,
        trial_settings:
          trialBehavior === "cancel" ||
          trialBehavior === "create_invoice" ||
          trialBehavior === "pause"
            ? { end_behavior: { missing_payment_method: trialBehavior } }
            : null,
      },
      payment_method_types: Array.isArray(paymentMethodTypes)
        ? paymentMethodTypes.filter((type): type is string => typeof type === "string")
        : ["card"],
      invoice: null,
      custom_text: (recordOf(params.custom_text) as Record<string, unknown> | undefined) ?? null,
      client_reference_id: stringOf(params, "client_reference_id"),
      customer_email: customerEmail,
      payment_method_collection: collection === "if_required" ? "if_required" : "always",
      allow_promotion_codes: allowPromotionCodes ?? false,
      customer_details: null,
      ui_mode: uiMode.mode,
      client_secret: uiMode.mode === "embedded_page" ? clientSecretFor(id) : null,
      return_url: returnUrl,
    }
    scope.account.checkoutSessions.insert(id, record)
    return jsonResponse(200, renderCheckoutSession(record))
  },
  GetCheckoutSessionsSession: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    // Unlike other reads, Checkout refuses an empty `expand` before it looks the session up
    // (probed against live Stripe).
    if (params.expand === "") throw parameterInvalidEmpty("expand")
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
