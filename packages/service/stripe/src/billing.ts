import { DEFAULT_PAYMENT_RETRIES, type PaymentRetryPolicy } from "./accounts.js"
import {
  invalidRequest,
  parameterMissing,
  resourceMissing,
  StripeError,
  stateError,
} from "./errors.js"
import { parseUnitAmountDecimal } from "./fields.js"
import {
  applyBalanceTransaction,
  changedFields,
  clientSecretFor,
  customerNow,
  findCustomer,
  intOf,
  priceAmount,
  type RequestScope,
  recordOf,
  requireCoupon,
  requirePrice,
} from "./internal.js"
import { confirmIntent, defaultPaymentMethodOf, resolvePaymentMethod } from "./payments.js"
import { normalizeCurrency } from "./prices.js"
import {
  renderCheckoutSession,
  renderDiscount,
  renderInvoice,
  renderInvoiceItem,
  renderPaymentIntent,
  renderSubscription,
} from "./render.js"
import {
  type CouponRecord,
  type DiscountRecord,
  type InvoiceItemRecord,
  type InvoiceLineRecord,
  type InvoiceRecord,
  type Metadata,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  type PriceRecord,
  type Recurring,
  type SubscriptionItemRecord,
  type SubscriptionRecord,
  type SubscriptionScheduleRecord,
  seconds,
} from "./state.js"

type RecordValue = Record<string, unknown>

const DAY = 86_400

// --- periods ------------------------------------------------------------------------------------

/** Stripe's calendar arithmetic: months keep the anchor day, clamped to the month's end. */
export const addInterval = (
  start: number,
  interval: Recurring["interval"],
  count: number,
): number => {
  if (interval === "day") return start + count * DAY
  if (interval === "week") return start + count * 7 * DAY
  const date = new Date(start * 1000)
  const months = interval === "month" ? count : count * 12
  const day = date.getUTCDate()
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ),
  )
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return Math.floor(target.getTime() / 1000)
}

export const recurringOf = (scope: RequestScope, subscription: SubscriptionRecord): Recurring => {
  const first = subscription.item_ids
    .map((id) => scope.account.subscriptionItems.get(id))
    .find((item) => item !== undefined)
  const price = first === undefined ? undefined : scope.account.prices.get(first.price)
  return (
    price?.recurring ?? {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
      trial_period_days: null,
    }
  )
}

// --- discounts ----------------------------------------------------------------------------------

export type DiscountRequest = { coupon?: string; promotion_code?: string; discount?: string }

/** `discounts[0][coupon]=…` / `discounts=""` as decoded by the form codec. */
export const parseDiscounts = (raw: unknown): DiscountRequest[] | "clear" | undefined => {
  if (raw === undefined) return undefined
  if (raw === "") return "clear"
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((entry): entry is RecordValue => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      ...(typeof entry.coupon === "string" && entry.coupon !== "" ? { coupon: entry.coupon } : {}),
      ...(typeof entry.promotion_code === "string" && entry.promotion_code !== ""
        ? { promotion_code: entry.promotion_code }
        : {}),
      ...(typeof entry.discount === "string" && entry.discount !== ""
        ? { discount: entry.discount }
        : {}),
    }))
}

export const couponValidNow = (coupon: CouponRecord, now: number) =>
  (coupon.max_redemptions === null || coupon.times_redeemed < coupon.max_redemptions) &&
  (coupon.redeem_by === null || coupon.redeem_by > now)

/** Count one redemption against a coupon (and its promotion code). */
export const redeem = (scope: RequestScope, couponId: string, promotionId: string | null) => {
  const coupon = scope.account.coupons.get(couponId)
  if (coupon) {
    const times = coupon.times_redeemed + 1
    scope.account.coupons.update(coupon.id, {
      ...coupon,
      times_redeemed: times,
      valid:
        (coupon.max_redemptions === null || times < coupon.max_redemptions) &&
        (coupon.redeem_by === null || coupon.redeem_by > seconds(scope.now)),
    })
  }
  if (promotionId !== null) {
    const promotion = scope.account.promotionCodes.get(promotionId)
    if (promotion)
      scope.account.promotionCodes.update(promotion.id, {
        ...promotion,
        times_redeemed: promotion.times_redeemed + 1,
      })
  }
}

/** Validate a coupon/promotion code pair and return the coupon a discount would carry. */
export const resolveDiscountSource = (
  scope: RequestScope,
  request: DiscountRequest,
  param: string,
): { coupon: string; promotion_code: string | null } => {
  if (request.promotion_code !== undefined) {
    const promotion = scope.account.promotionCodes.get(request.promotion_code)
    if (!promotion)
      throw resourceMissing("promotion code", request.promotion_code, `${param}[promotion_code]`)
    if (!promotion.active)
      throw invalidRequest(
        `This promotion code is inactive: '${promotion.code}'.`,
        `${param}[promotion_code]`,
      )
    if (promotion.expires_at !== null && promotion.expires_at <= seconds(scope.now))
      throw invalidRequest(
        `This promotion code has expired: '${promotion.code}'.`,
        `${param}[promotion_code]`,
      )
    if (promotion.max_redemptions !== null && promotion.times_redeemed >= promotion.max_redemptions)
      throw invalidRequest(
        `This promotion code has been used the maximum number of times: '${promotion.code}'.`,
        `${param}[promotion_code]`,
      )
    const coupon = requireCoupon(scope, promotion.coupon, `${param}[promotion_code]`)
    if (!couponValidNow(coupon, seconds(scope.now)))
      throw invalidRequest(`Coupon expired: ${coupon.id}`, `${param}[promotion_code]`)
    return { coupon: coupon.id, promotion_code: promotion.id }
  }
  const couponId = request.coupon ?? ""
  const coupon = requireCoupon(scope, couponId, `${param}[coupon]`)
  if (!couponValidNow(coupon, seconds(scope.now)))
    throw invalidRequest(`Coupon expired: ${coupon.id}`, `${param}[coupon]`)
  return { coupon: coupon.id, promotion_code: null }
}

/**
 * Turn requested discounts into discount records on `target`. Existing discounts named by id
 * (`{discount: "di_…"}`) keep their id and start; new coupons and promotion codes are redeemed.
 */
export const applyDiscountRequests = (
  scope: RequestScope,
  requests: DiscountRequest[],
  target: {
    customer: string | null
    subscription?: string | null
    invoice?: string | null
    checkout_session?: string | null
  },
  existing: readonly string[] = [],
  param = "discounts",
  /** `false` when the caller reports the change itself (`discountsReplaced`). */
  announce = true,
): string[] => {
  const ids: string[] = []
  requests.forEach((request, index) => {
    if (request.discount !== undefined) {
      if (!existing.includes(request.discount))
        throw resourceMissing("discount", request.discount, `${param}[${index}][discount]`)
      ids.push(request.discount)
      return
    }
    const source = resolveDiscountSource(scope, request, `${param}[${index}]`)
    const coupon = scope.account.coupons.get(source.coupon) as CouponRecord
    const start = customerNow(scope, target.customer)
    const id = scope.ids.next("di_", 24)
    const record: DiscountRecord = {
      id,
      coupon: source.coupon,
      promotion_code: source.promotion_code,
      customer: target.customer,
      subscription: target.subscription ?? null,
      invoice: target.invoice ?? null,
      checkout_session: target.checkout_session ?? null,
      start,
      end:
        coupon.duration === "repeating" && coupon.duration_in_months !== null
          ? addInterval(start, "month", coupon.duration_in_months)
          : null,
    }
    scope.account.discounts.insert(id, record)
    redeem(scope, source.coupon, source.promotion_code)
    // Discounts on a subscription or a customer announce themselves; invoice and Checkout
    // discounts do not.
    if (announce && record.invoice === null && record.checkout_session === null)
      emitDiscount(scope, "created", id)
    ids.push(id)
  })
  return ids
}

/** `customer.discount.created|updated|deleted`, with the discount as `data.object`. */
export const emitDiscount = (
  scope: RequestScope,
  change: "created" | "updated" | "deleted",
  id: string,
  previous?: RecordValue,
) => {
  const record = scope.account.discounts.get(id)
  if (record)
    scope.emit(`customer.discount.${change}`, renderDiscount(record, scope.account), previous)
}

/**
 * Discounts that left a subscription or customer: `customer.discount.deleted` for each one no
 * longer in `kept`. The records stay, since invoices that used them still name them.
 */
export const discountsRemoved = (
  scope: RequestScope,
  before: readonly string[],
  kept: readonly string[],
) => {
  for (const id of before) if (!kept.includes(id)) emitDiscount(scope, "deleted", id)
}

/** `DELETE …/discount`: the removed discount, marked deleted (no `end`, as Stripe answers). */
export const renderDeletedDiscount = (scope: RequestScope, id: string): RecordValue => {
  const record = scope.account.discounts.get(id)
  if (!record) return { id, object: "discount", deleted: true }
  const { end: _end, ...rest } = renderDiscount(record, scope.account)
  return { ...rest, deleted: true }
}

/**
 * Report a subscription's or customer's discounts changing from `before` to `after` (created with
 * `announce=false`): `customer.discount.deleted` for each removed one, `.created` for each new one.
 * The legacy singular `coupon` / `promotion_code` swapping one discount for another is one
 * `customer.discount.updated` instead (best guess, not oracle-verified).
 */
export const discountsReplaced = (
  scope: RequestScope,
  before: readonly string[],
  after: readonly string[],
  singular = false,
) => {
  const removed = before.filter((id) => !after.includes(id))
  const added = after.filter((id) => !before.includes(id))
  const [old] = removed
  const [fresh] = added
  if (singular && removed.length === 1 && added.length === 1 && old && fresh) {
    const previous = scope.account.discounts.get(old)
    emitDiscount(
      scope,
      "updated",
      fresh,
      previous === undefined
        ? undefined
        : { coupon: renderDiscount(previous, scope.account).coupon, id: previous.id },
    )
    return
  }
  discountsRemoved(scope, before, after)
  for (const id of added) emitDiscount(scope, "created", id)
}

/** Does a coupon's `applies_to` restriction allow this line? */
const couponApplies = (scope: RequestScope, coupon: CouponRecord, priceId: string | null) => {
  if (coupon.applies_to_products.length === 0) return true
  if (priceId === null) return false
  const price = scope.account.prices.get(priceId)
  return price !== undefined && coupon.applies_to_products.includes(price.product)
}

/**
 * Per-line and per-discount amounts: percentage coupons take their share of every applicable
 * line; fixed-amount coupons are spread across applicable lines in order, capped at each line.
 */
export const discountLines = (
  scope: RequestScope,
  discountIds: readonly string[],
  lines: ReadonlyArray<{
    amount: number
    price: string | null
    currency: string
    discountable?: boolean
  }>,
): {
  perLine: Array<Array<{ amount: number; discount: string }>>
  totals: Array<{ discount: string; amount: number }>
} => {
  const remaining = lines.map((line) => line.amount)
  const perLine: Array<Array<{ amount: number; discount: string }>> = lines.map(() => [])
  const totals: Array<{ discount: string; amount: number }> = []
  for (const id of discountIds) {
    const discount = scope.account.discounts.get(id)
    const coupon = discount === undefined ? undefined : scope.account.coupons.get(discount.coupon)
    if (!discount || !coupon) continue
    let total = 0
    let budget =
      coupon.amount_off === null
        ? Number.POSITIVE_INFINITY
        : (coupon.currency_options[lines[0]?.currency ?? "usd"]?.amount_off ?? coupon.amount_off)
    lines.forEach((line, index) => {
      if (line.discountable === false || !couponApplies(scope, coupon, line.price)) return
      const left = remaining[index] ?? 0
      const take =
        coupon.percent_off !== null
          ? Math.round((left * coupon.percent_off) / 100)
          : Math.min(left, budget)
      if (coupon.percent_off === null) budget -= take
      remaining[index] = left - take
      total += take
      perLine[index]?.push({ amount: take, discount: id })
    })
    totals.push({ discount: id, amount: total })
  }
  return { perLine, totals }
}

// --- invoices -----------------------------------------------------------------------------------

/** Re-derive an invoice's money fields from its lines, discounts and applied balance. */
export const recomputeInvoice = (scope: RequestScope, invoice: InvoiceRecord): InvoiceRecord => {
  const { perLine, totals } = discountLines(scope, invoice.discount_ids, invoice.lines)
  const lines = invoice.lines.map((line, index) => ({
    ...line,
    discount_amounts: perLine[index] ?? [],
  }))
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0)
  const discounted = totals.reduce((sum, entry) => sum + entry.amount, 0)
  const total = Math.max(0, subtotal - discounted)
  const credit = invoice.starting_balance ?? 0
  const due = Math.max(0, total + credit)
  return {
    ...invoice,
    lines,
    subtotal,
    total,
    discount_amounts: totals,
    amount_due: due,
    amount_remaining: Math.max(0, due - invoice.amount_paid),
  }
}

export type InvoiceInput = {
  customer: string
  subscription: string | null
  lines: InvoiceLineRecord[]
  billingReason: string
  metadata?: Metadata
  discountIds?: string[]
  collectionMethod?: "charge_automatically" | "send_invoice"
  daysUntilDue?: number | null
  autoAdvance?: boolean
  description?: string | null
  defaultPaymentMethod?: string | null
  period?: { start: number; end: number }
  subscriptionMetadata?: Metadata | null
}

/**
 * A subscription invoice without discounts of its own uses the customer's discount (the legacy
 * customer-level `coupon` / `promotion_code`), while that discount lasts.
 */
const invoiceDiscounts = (scope: RequestScope, input: InvoiceInput, at: number): string[] => {
  if (input.discountIds !== undefined && input.discountIds.length > 0) return input.discountIds
  if (input.subscription === null) return input.discountIds ?? []
  const id = findCustomer(scope, input.customer)?.discount?.id
  const discount = typeof id === "string" ? scope.account.discounts.get(id) : undefined
  return discount !== undefined && (discount.end === null || discount.end > at) ? [discount.id] : []
}

/** A draft invoice; emits `invoice.created`. */
export const createDraftInvoice = (scope: RequestScope, input: InvoiceInput): InvoiceRecord => {
  const id = scope.ids.next("in_", 24)
  const created = customerNow(scope, input.customer)
  const customer = findCustomer(scope, input.customer)
  const previous = scope.account.invoices.list({
    where: (invoice) => invoice.customer === input.customer,
  }).length
  const period = input.period ?? { start: created, end: created }
  const draft: InvoiceRecord = {
    id,
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    attempt_count: 0,
    attempted: false,
    auto_advance: input.autoAdvance ?? false,
    billing_reason: input.billingReason,
    charge: null,
    collection_method: input.collectionMethod ?? "charge_automatically",
    created,
    currency: input.lines[0]?.currency ?? customer?.currency ?? "usd",
    customer: input.customer,
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    description: input.description ?? null,
    discount_ids: invoiceDiscounts(scope, input, created),
    due_date: null,
    ending_balance: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    metadata: input.metadata ?? {},
    next_payment_attempt: null,
    number: `${customer?.invoice_prefix ?? "MOCKING"}-DRAFT-${String(previous + 1).padStart(4, "0")}`,
    paid: false,
    payment_intent: null,
    period_end: period.end,
    period_start: period.start,
    status: "draft",
    status_transitions: {
      finalized_at: null,
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null,
    },
    subscription: input.subscription,
    subtotal: 0,
    total: 0,
    lines: input.lines,
    subscription_metadata: input.subscriptionMetadata ?? null,
    default_payment_method: input.defaultPaymentMethod ?? null,
    days_until_due: input.daysUntilDue ?? null,
    paid_out_of_band: false,
    starting_balance: 0,
    discount_amounts: [],
  }
  const computed = recomputeInvoice(scope, { ...draft, number: null })
  scope.account.invoices.insert(id, computed)
  scope.emit("invoice.created", renderInvoice(computed, scope.account))
  return computed
}

const newIntentRecord = (
  scope: RequestScope,
  input: {
    amount: number
    currency: string
    customer: string | null
    invoice: string | null
    metadata?: Metadata
    description?: string | null
    setupFutureUsage?: string | null
    paymentMethodTypes?: string[]
    captureMethod?: PaymentIntentRecord["capture_method"]
  },
): PaymentIntentRecord => {
  const id = scope.ids.next("pi_", 24)
  const intent: PaymentIntentRecord = {
    id,
    amount: input.amount,
    amount_capturable: 0,
    amount_received: 0,
    capture_method: input.captureMethod ?? "automatic_async",
    charge_ids: [],
    client_secret: clientSecretFor(id),
    confirmation_method: "automatic",
    created: seconds(scope.now),
    currency: input.currency,
    customer: input.customer,
    description: input.description ?? null,
    invoice: input.invoice,
    last_payment_error: null,
    latest_charge: null,
    metadata: input.metadata ?? {},
    payment_method: null,
    payment_method_types: input.paymentMethodTypes ?? ["card"],
    receipt_email: null,
    setup_future_usage: input.setupFutureUsage ?? null,
    status: "requires_payment_method",
    canceled_at: null,
    cancellation_reason: null,
    automatic_payment_methods: null,
    next_action: null,
  }
  scope.account.paymentIntents.insert(id, intent)
  scope.emit("payment_intent.created", renderPaymentIntent(intent))
  return intent
}

export { newIntentRecord }

/**
 * Finalize a draft: apply the customer's credit balance, number it, and either mark it paid
 * (nothing due) or open it with a PaymentIntent the customer (or a renewal) can pay.
 */
export const finalizeInvoice = (scope: RequestScope, draft: InvoiceRecord): InvoiceRecord => {
  if (draft.status !== "draft")
    throw invalidRequest(
      `This invoice is already finalized, you can't re-finalize a non-draft invoice.`,
      undefined,
      "invoice_not_editable",
    )
  const now = customerNow(scope, draft.customer)
  const customer = draft.customer === null ? undefined : findCustomer(scope, draft.customer)
  const priced = recomputeInvoice(scope, draft)
  let starting = 0
  if (customer && customer.balance !== 0 && priced.total > 0) {
    const balance = customer.balance
    const applied = balance < 0 ? Math.max(balance, -priced.total) : balance
    starting = applied
    applyBalanceTransaction(scope, {
      customer,
      amount: -applied,
      currency: priced.currency,
      description: null,
      metadata: {},
      type: "applied_to_invoice",
      invoice: priced.id,
    })
  }
  const previous = scope.account.invoices.list({
    where: (invoice) => invoice.customer === draft.customer && invoice.number !== null,
  }).length
  const opened = recomputeInvoice(scope, {
    ...priced,
    starting_balance: starting,
    ending_balance: 0,
    number: `${customer?.invoice_prefix ?? "MOCKING"}-${String(previous + 1).padStart(4, "0")}`,
    status: "open",
    hosted_invoice_url: `https://invoice.stripe.com/i/${priced.id}`,
    invoice_pdf: `https://pay.stripe.com/invoice/${priced.id}/pdf`,
    due_date:
      priced.collection_method === "send_invoice"
        ? now + (priced.days_until_due ?? 30) * DAY
        : null,
    status_transitions: { ...priced.status_transitions, finalized_at: now },
  })
  let record = opened
  if (opened.amount_due > 0 && opened.collection_method === "charge_automatically") {
    const intent = newIntentRecord(scope, {
      amount: opened.amount_due,
      currency: opened.currency,
      customer: opened.customer,
      invoice: opened.id,
      description: opened.description,
    })
    record = { ...opened, payment_intent: intent.id }
  }
  scope.account.invoices.update(record.id, record)
  scope.emit("invoice.finalized", renderInvoice(record, scope.account))
  if (record.amount_due === 0) return markInvoicePaid(scope, record, undefined)
  return record
}

/**
 * Settle an open invoice: `paid`, amounts moved, `invoice.paid` + `invoice.payment_succeeded`;
 * a subscription waiting on it becomes active.
 */
export const markInvoicePaid = (
  scope: RequestScope,
  invoice: InvoiceRecord,
  intent: PaymentIntentRecord | undefined,
  outOfBand = false,
): InvoiceRecord => {
  const paidAt = customerNow(scope, invoice.customer)
  const paid: InvoiceRecord = {
    ...invoice,
    amount_paid: invoice.amount_due,
    amount_remaining: 0,
    attempted: invoice.amount_due > 0 ? true : invoice.attempted,
    attempt_count:
      invoice.amount_due > 0 && !outOfBand ? invoice.attempt_count + 1 : invoice.attempt_count,
    charge: intent?.latest_charge ?? invoice.charge,
    next_payment_attempt: null,
    paid: true,
    paid_out_of_band: outOfBand,
    payment_intent: intent?.id ?? invoice.payment_intent,
    status: "paid",
    status_transitions: {
      ...invoice.status_transitions,
      finalized_at: invoice.status_transitions.finalized_at ?? paidAt,
      paid_at: paidAt,
    },
  }
  scope.account.invoices.update(paid.id, paid)
  const rendered = renderInvoice(paid, scope.account)
  scope.emit("invoice.paid", rendered)
  scope.emit("invoice.payment_succeeded", rendered)
  if (paid.subscription !== null) activateAfterPayment(scope, paid.subscription, intent)
  return paid
}

/** An incomplete or past-due subscription whose invoice got paid becomes active. */
const activateAfterPayment = (
  scope: RequestScope,
  subscriptionId: string,
  intent: PaymentIntentRecord | undefined,
) => {
  const subscription = scope.account.subscriptions.get(subscriptionId)
  if (!subscription) return
  const saveDefault =
    subscription.payment_settings?.save_default_payment_method === "on_subscription" &&
    intent?.payment_method !== null &&
    intent?.payment_method !== undefined &&
    subscription.default_payment_method === null
  if (!["incomplete", "past_due", "unpaid"].includes(subscription.status) && !saveDefault) return
  const next: SubscriptionRecord = {
    ...subscription,
    status: ["incomplete", "past_due", "unpaid"].includes(subscription.status)
      ? subscription.trial_end !== null &&
        subscription.trial_end > customerNow(scope, subscription.customer)
        ? "trialing"
        : "active"
      : subscription.status,
    default_payment_method: saveDefault
      ? (intent?.payment_method ?? null)
      : subscription.default_payment_method,
  }
  saveSubscription(scope, subscription, next)
}

/**
 * Record a failed collection attempt on an open invoice and schedule the next automatic retry:
 * a subscription invoice retries `scheduleDays` after its first failure, then stops
 * (`next_payment_attempt: null`). Other invoices keep the flat three-day hint.
 */
const markPaymentFailed = (scope: RequestScope, invoice: InvoiceRecord): InvoiceRecord => {
  const now = customerNow(scope, invoice.customer)
  const attempts = invoice.attempt_count + 1
  let next: number | null = now + 3 * DAY
  if (invoice.subscription !== null) {
    const days = scope.services.paymentRetries(scope.account.account).scheduleDays
    // Days count from the first failure, whichever time the earlier retries actually ran.
    const first =
      attempts === 1 || invoice.next_payment_attempt === null
        ? now
        : invoice.next_payment_attempt - (days[attempts - 2] ?? 0) * DAY
    const day = days[attempts - 1]
    next = day === undefined ? null : first + day * DAY
  }
  const failed: InvoiceRecord = {
    ...invoice,
    attempt_count: attempts,
    attempted: true,
    next_payment_attempt: next,
  }
  scope.account.invoices.update(failed.id, failed)
  scope.emit("invoice.payment_failed", renderInvoice(failed, scope.account))
  return failed
}

const NO_PAYMENT_METHOD =
  "This customer has no attached payment source or default payment method. Please consider adding a default payment method. For more information, visit https://stripe.com/docs/billing/subscriptions/payment-methods-setting#payment-method-priority."

/** The payment method an invoice charges: explicit, the invoice's, the subscription's, the customer's. */
export const invoicePaymentMethod = (
  scope: RequestScope,
  invoice: InvoiceRecord,
  explicit: string | null,
): PaymentMethodRecord | undefined => {
  if (explicit !== null) return resolvePaymentMethod(scope, explicit)
  if (invoice.default_payment_method) {
    const method = scope.account.paymentMethods.get(invoice.default_payment_method)
    if (method) return method
  }
  const subscription =
    invoice.subscription === null
      ? undefined
      : scope.account.subscriptions.get(invoice.subscription)
  if (subscription?.default_payment_method) {
    const method = scope.account.paymentMethods.get(subscription.default_payment_method)
    if (method) return method
  }
  return defaultPaymentMethodOf(scope, invoice.customer)
}

/**
 * Charge an open invoice. A decline records the failed attempt, emits
 * `invoice.payment_failed`, and throws the 402 `card_error` to the caller.
 */
export const payInvoice = (
  scope: RequestScope,
  current: InvoiceRecord,
  options: {
    paymentMethod?: string | null
    offSession: boolean
    outOfBand?: boolean
    /** The customer is present and completes 3-D Secure (a hosted page's Pay button). */
    autoAuthenticate?: boolean
  },
): InvoiceRecord => {
  let invoice = current
  if (invoice.status === "draft") invoice = finalizeInvoice(scope, invoice)
  if (invoice.status === "paid")
    throw invalidRequest("Invoice is already paid", undefined, "invoice_already_paid") // unreachable for callers that check
  if (invoice.status !== "open")
    throw invalidRequest(
      `This invoice can no longer be paid because it has a status of ${invoice.status}.`,
      undefined,
      "invoice_not_editable",
    )
  if (options.outOfBand) return markInvoicePaid(scope, invoice, undefined, true)
  if (invoice.amount_due === 0) return markInvoicePaid(scope, invoice, undefined)
  const method = invoicePaymentMethod(scope, invoice, options.paymentMethod ?? null)
  if (method === undefined)
    throw invalidRequest(NO_PAYMENT_METHOD, undefined, "invoice_no_customer_line_items")
  let intent =
    invoice.payment_intent === null
      ? undefined
      : scope.account.paymentIntents.get(invoice.payment_intent)
  if (intent === undefined || intent.status === "canceled") {
    intent = newIntentRecord(scope, {
      amount: invoice.amount_due,
      currency: invoice.currency,
      customer: invoice.customer,
      invoice: invoice.id,
    })
    invoice = { ...invoice, payment_intent: intent.id }
    scope.account.invoices.update(invoice.id, invoice)
  }
  try {
    const settled = confirmIntent(scope, intent, method, {
      offSession: options.offSession,
      ...(options.autoAuthenticate ? { autoAuthenticate: true } : {}),
    })
    if (settled.status !== "succeeded") return invoice
    return markInvoicePaid(scope, invoice, settled)
  } catch (error) {
    if (error instanceof StripeError && error.init.type === "card_error")
      markPaymentFailed(scope, scope.account.invoices.get(invoice.id) ?? invoice)
    throw error
  }
}

/** A PaymentIntent paid through the API (e.g. Stripe.js) settles the invoice it belongs to. */
export const afterIntentSucceeded = (scope: RequestScope, intent: PaymentIntentRecord) => {
  if (intent.status !== "succeeded" || intent.invoice === null) return
  const invoice = scope.account.invoices.get(intent.invoice)
  if (invoice?.status === "open") markInvoicePaid(scope, invoice, intent)
}

export const voidInvoice = (scope: RequestScope, invoice: InvoiceRecord): InvoiceRecord => {
  if (invoice.status !== "open")
    throw stateError("You can only pass in open invoices. This invoice isn't open.")
  const now = customerNow(scope, invoice.customer)
  const voided: InvoiceRecord = {
    ...invoice,
    amount_remaining: 0,
    status: "void",
    status_transitions: { ...invoice.status_transitions, voided_at: now },
  }
  scope.account.invoices.update(voided.id, voided)
  if (invoice.payment_intent !== null) {
    const intent = scope.account.paymentIntents.get(invoice.payment_intent)
    if (intent && intent.status !== "succeeded" && intent.status !== "canceled") {
      const canceled: PaymentIntentRecord = {
        ...intent,
        status: "canceled",
        canceled_at: seconds(scope.now),
        cancellation_reason: "void_invoice",
      }
      scope.account.paymentIntents.update(intent.id, canceled)
      scope.emit("payment_intent.canceled", renderPaymentIntent(canceled))
    }
  }
  scope.emit("invoice.voided", renderInvoice(voided, scope.account))
  return voided
}

/** `uncollectible`: stop collecting an open invoice (`invoice.marked_uncollectible`). */
export const markInvoiceUncollectible = (
  scope: RequestScope,
  invoice: InvoiceRecord,
): InvoiceRecord => {
  if (invoice.status !== "open")
    throw stateError("You can only mark open invoices as uncollectible.", "invoice_not_editable")
  const now = customerNow(scope, invoice.customer)
  const marked: InvoiceRecord = {
    ...invoice,
    next_payment_attempt: null,
    status: "uncollectible",
    status_transitions: { ...invoice.status_transitions, marked_uncollectible_at: now },
  }
  scope.account.invoices.update(marked.id, marked)
  scope.emit("invoice.marked_uncollectible", renderInvoice(marked, scope.account))
  return marked
}

// --- invoice lines ------------------------------------------------------------------------------

export const lineFromPrice = (
  scope: RequestScope,
  price: PriceRecord,
  quantity: number,
  period: { start: number; end: number },
  extra: {
    subscription?: string | null
    subscriptionItem?: string | null
    amount?: number
    description?: string | null
  } = {},
): InvoiceLineRecord => {
  const amount = extra.amount ?? Math.round(Number(price.unit_amount_decimal) * quantity)
  const product = scope.account.products.get(price.product)
  return {
    id: scope.ids.next("il_", 24),
    amount,
    currency: price.currency,
    description: extra.description ?? `${quantity} × ${product?.name ?? price.product}`,
    discount_amounts: [],
    invoice_item: null,
    metadata: {},
    period,
    price: price.id,
    quantity,
    proration: false,
    subtotal: amount,
    type: "subscription",
    subscription: extra.subscription ?? null,
    subscription_item: extra.subscriptionItem ?? null,
  }
}

// --- add_invoice_items --------------------------------------------------------------------------

/** One validated `add_invoice_items[n]` entry; an inline price is stored once it is used. */
export type AddInvoiceItem = {
  price: PriceRecord
  inline: boolean
  quantity: number
  metadata: Metadata
  discountable: boolean | undefined
}

/** Sub-parameters of `add_invoice_items[n]` the emulator does not model: refused, never ignored. */
const UNMODELLED_ADD_INVOICE_ITEM = ["discounts", "period", "tax_rates"] as const

const RECURRING_INVOICE_ITEM =
  "The price specified is set to `type=recurring` but this field only accepts prices with `type=one_time`."

/**
 * `add_invoice_items[n]`: a one-time `price` or inline `price_data` (an inactive one-time Price,
 * as Stripe generates), `quantity`, `metadata` and `discountable`. Validated in full before the
 * caller writes anything.
 */
export const parseAddInvoiceItems = (
  scope: RequestScope,
  raw: unknown,
  currency: string | null,
  param = "add_invoice_items",
): AddInvoiceItem[] => {
  if (raw === undefined || raw === "") return []
  if (!Array.isArray(raw)) throw invalidRequest("Invalid array", param)
  return raw.map((value, index) => {
    const at = `${param}[${index}]`
    const entry = recordOf(value) ?? {}
    for (const key of UNMODELLED_ADD_INVOICE_ITEM)
      if (entry[key] !== undefined)
        throw invalidRequest(
          `\`${key}\` on add_invoice_items is not modelled by this mock.`,
          `${at}[${key}]`,
        )
    const priceId = typeof entry.price === "string" && entry.price !== "" ? entry.price : null
    const data = recordOf(entry.price_data)
    if (priceId !== null && data !== undefined)
      throw invalidRequest(
        "You may only specify one of these parameters: price, price_data.",
        `${at}[price]`,
      )
    let price: PriceRecord
    if (priceId !== null) {
      price = requirePrice(scope, priceId, `${at}[price]`)
      if (price.recurring !== null) throw invalidRequest(RECURRING_INVOICE_ITEM, `${at}[price]`)
      if (!price.active) throw invalidRequest(INACTIVE_PRICE, `${at}[price]`)
    } else {
      if (data === undefined) throw parameterMissing(`${at}[price]`)
      price = inlineInvoiceItemPrice(scope, data, `${at}[price_data]`)
    }
    if (currency !== null && price.currency !== currency)
      throw invalidRequest(
        `The currency of ${at} (\`${price.currency}\`) must match the subscription's currency (\`${currency}\`).`,
        `${at}[price]`,
      )
    const quantity = intOf(entry.quantity) ?? 1
    if (quantity < 0)
      throw invalidRequest("This value must be greater than or equal to 0.", `${at}[quantity]`)
    const discountable = entry.discountable
    return {
      price,
      inline: priceId === null,
      quantity,
      metadata: (recordOf(entry.metadata) as Metadata | undefined) ?? {},
      discountable:
        discountable === undefined ? undefined : discountable === true || discountable === "true",
    }
  })
}

/** `price_data` on an invoice item: product, currency and a (possibly negative) unit amount. */
const inlineInvoiceItemPrice = (
  scope: RequestScope,
  data: RecordValue,
  param: string,
): PriceRecord => {
  const product = typeof data.product === "string" ? data.product : ""
  if (product === "") throw parameterMissing(`${param}[product]`)
  if (!scope.account.products.get(product))
    throw resourceMissing("product", product, `${param}[product]`)
  if (data.currency === undefined) throw parameterMissing(`${param}[currency]`)
  const hasAmount = data.unit_amount !== undefined
  const hasDecimal = data.unit_amount_decimal !== undefined
  if (hasAmount && hasDecimal)
    throw invalidRequest(
      "You may only specify one of these parameters: unit_amount, unit_amount_decimal.",
      `${param}[unit_amount]`,
    )
  if (!hasAmount && !hasDecimal) throw parameterMissing(`${param}[unit_amount]`)
  const taxBehavior = data.tax_behavior
  return {
    id: scope.ids.next("price_", 24),
    active: false,
    created: seconds(scope.now),
    currency: normalizeCurrency(String(data.currency), `${param}[currency]`),
    lookup_key: null,
    metadata: {},
    nickname: null,
    product,
    recurring: null,
    tax_behavior:
      taxBehavior === "exclusive" || taxBehavior === "inclusive" ? taxBehavior : "unspecified",
    unit_amount_decimal: hasDecimal
      ? parseUnitAmountDecimal(String(data.unit_amount_decimal), `${param}[unit_amount_decimal]`)
      : String(intOf(data.unit_amount) ?? 0),
  }
}

/**
 * Store `add_invoice_items` as pending invoice items of the subscription (Stripe creates real
 * `ii_` objects): the next invoice the subscription produces bills them, claiming them. A negative
 * item is not discountable unless asked, as Stripe defaults.
 */
export const addSubscriptionInvoiceItems = (
  scope: RequestScope,
  subscription: { id: string; customer: string },
  entries: readonly AddInvoiceItem[],
): InvoiceItemRecord[] => {
  const now = customerNow(scope, subscription.customer)
  return entries.map((entry) => {
    if (entry.inline) scope.account.prices.insert(entry.price.id, entry.price)
    const unit = Math.round(Number(entry.price.unit_amount_decimal))
    const amount = Math.round(Number(entry.price.unit_amount_decimal) * entry.quantity)
    const product = scope.account.products.get(entry.price.product)
    const id = scope.ids.next("ii_", 24)
    const item: InvoiceItemRecord = {
      id,
      amount,
      created: seconds(scope.now),
      currency: entry.price.currency,
      customer: subscription.customer,
      date: now,
      description: product?.name ?? null,
      discountable: entry.discountable ?? amount >= 0,
      invoice: null,
      metadata: entry.metadata,
      period: { start: now, end: now },
      price: entry.price.id,
      proration: false,
      quantity: entry.quantity,
      unit_amount: unit,
      subscription: subscription.id,
    }
    scope.account.invoiceItems.insert(id, item)
    scope.emit("invoiceitem.created", renderInvoiceItem(item))
    return item
  })
}

/** An invoice line billing a pending invoice item. */
const invoiceItemLine = (
  scope: RequestScope,
  item: InvoiceItemRecord,
  subscription: string,
): InvoiceLineRecord => ({
  id: scope.ids.next("il_", 24),
  amount: item.amount,
  currency: item.currency,
  description: item.description,
  discount_amounts: [],
  invoice_item: item.id,
  metadata: item.metadata,
  period: item.period,
  price: item.price,
  quantity: item.quantity,
  proration: item.proration,
  subtotal: item.amount,
  type: "invoiceitem",
  subscription,
  // Proration lines keep sharing the subscription's discounts, as they always have here.
  ...(item.proration ? {} : { discountable: item.discountable }),
})

/** A subscription's pending invoice items: its prorations and its `add_invoice_items`. */
const pendingItems = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  which: "all" | "added" = "all",
) =>
  scope.account.invoiceItems
    .list({
      order: "oldest",
      where: (item) =>
        item.customer === subscription.customer &&
        item.invoice === null &&
        (item.subscription === subscription.id || (which === "all" && item.proration)),
    })
    .map((entry) => entry.value)

// --- subscriptions ------------------------------------------------------------------------------

const ACTIVE_STATES = ["active", "trialing", "past_due", "unpaid"]

export const saveSubscription = (
  scope: RequestScope,
  previous: SubscriptionRecord,
  next: SubscriptionRecord,
  previousItems?: RecordValue,
) => {
  scope.account.subscriptions.update(next.id, next)
  const before = { ...renderSubscription(previous, scope.account), ...previousItems }
  const after = renderSubscription(next, scope.account)
  const changed = changedFields(before, after)
  if (changed !== undefined) scope.emit("customer.subscription.updated", after, changed)
}

export type SubscriptionItemInput = { price: string; quantity: number; metadata?: Metadata }

export type CreateSubscriptionInput = {
  customer: string
  items: SubscriptionItemInput[]
  metadata: Metadata
  defaultPaymentMethod: string | null
  paymentBehavior: string | null
  trialEnd: number | "now" | null
  trialPeriodDays?: number | null
  /** Start the trial the price(s) declare in `recurring.trial_period_days`. */
  trialFromPlan?: boolean
  backdateStartDate?: number | undefined
  billingCycleAnchor?: number | undefined
  prorationBehavior?: string | null
  discounts?: DiscountRequest[]
  /** Validated by `parseAddInvoiceItems`: billed once, on the first invoice. */
  addInvoiceItems?: readonly AddInvoiceItem[]
  paymentSettings?: RecordValue | null
  collectionMethod?: "charge_automatically" | "send_invoice"
  daysUntilDue?: number | null
  offSession?: boolean
  schedule?: string | null
  cancelAtPeriodEnd?: boolean
  /** Charge this payment method for the first invoice (checkout completion). */
  firstPaymentMethod?: PaymentMethodRecord
  /** The customer is on a hosted page and completes 3-D Secure there. */
  autoAuthenticate?: boolean
  /** Inline (`price_data`) prices are created inactive; only Checkout may subscribe to them. */
  allowInactivePrices?: boolean
  description?: string | null
  trialSettings?: SubscriptionRecord["trial_settings"]
}

const ONE_TIME_ONLY =
  "The price specified is set to `type=one_time` but this field only accepts prices with `type=recurring`."
export const INACTIVE_PRICE =
  "The price specified is inactive. This field only accepts active prices."

/**
 * Every price on one subscription bills in the same currency on the same interval; Stripe
 * refuses the first item that differs from the first.
 */
export const assertCompatiblePrices = (prices: readonly PriceRecord[], param = "items") => {
  const [first, ...rest] = prices
  if (first?.recurring === null || first === undefined) return
  for (const price of rest) {
    if (price.currency !== first.currency)
      throw invalidRequest(
        "Currency and interval fields must match across all plans on this subscription. Found mismatch in currency field.",
        param,
      )
    if (
      price.recurring !== null &&
      (price.recurring.interval !== first.recurring.interval ||
        price.recurring.interval_count !== first.recurring.interval_count)
    )
      throw invalidRequest(
        "Currency and interval fields must match across all plans on this subscription. Found mismatch in interval field.",
        param,
      )
  }
}

/**
 * Create a subscription with its items and first invoice, then collect that invoice per
 * `payment_behavior`: `default_incomplete` leaves it for the customer (a client secret on the
 * invoice's PaymentIntent); `error_if_incomplete` fails the whole call on a decline; the default
 * (`allow_incomplete`) charges the default payment method and returns `incomplete` on a decline.
 */
export const createSubscription = (
  outer: RequestScope,
  input: CreateSubscriptionInput,
): { subscription: SubscriptionRecord; invoice: InvoiceRecord } => {
  // Collecting the first invoice can activate the subscription (`customer.subscription.updated`)
  // before it is reported created; those updates are held and sent after
  // `customer.subscription.created`, which shows the subscription as it was before them.
  const held: Array<{ object: RecordValue; previous: RecordValue | undefined }> = []
  let holding: string | null = null
  const scope: RequestScope = {
    ...outer,
    emit: (type, object, previous) => {
      if (type === "customer.subscription.updated" && holding !== null && object.id === holding) {
        held.push({ object, previous })
        return ""
      }
      return outer.emit(type, object, previous)
    },
  }
  const priced = input.items.map((item, index) => {
    const price = requirePrice(scope, item.price, `items[${index}][price]`)
    if (price.recurring === null) throw invalidRequest(ONE_TIME_ONLY, `items[${index}][price]`)
    if (!price.active && !input.allowInactivePrices)
      throw invalidRequest(INACTIVE_PRICE, `items[${index}][price]`)
    return { item, price }
  })
  assertCompatiblePrices(priced.map((entry) => entry.price))
  const first = priced[0]
  if (first === undefined)
    throw invalidRequest("Missing required param: items.", "items", "parameter_missing")
  const recurring = first.price.recurring as Recurring
  const now = customerNow(scope, input.customer)
  const start = input.backdateStartDate ?? now
  // With several items, the longest plan trial wins.
  const planTrialDays = input.trialFromPlan
    ? Math.max(0, ...priced.map((entry) => entry.price.recurring?.trial_period_days ?? 0))
    : 0
  const trialDays = input.trialPeriodDays || planTrialDays
  const trialEnd =
    input.trialEnd === "now" ? null : (input.trialEnd ?? (trialDays ? now + trialDays * DAY : null))
  const trialing = trialEnd !== null && trialEnd > now
  let periodEnd = trialing
    ? (trialEnd as number)
    : addInterval(start, recurring.interval, recurring.interval_count)
  let periodStart = trialing ? now : start
  const anchored =
    !trialing && input.billingCycleAnchor !== undefined && input.billingCycleAnchor > now
  if (anchored) {
    periodEnd = input.billingCycleAnchor as number
    periodStart = start
  } else if (!trialing && input.backdateStartDate !== undefined) {
    for (let guard = 0; periodEnd <= now && guard < 10_000; guard += 1) {
      periodStart = periodEnd
      periodEnd = addInterval(periodEnd, recurring.interval, recurring.interval_count)
    }
  }
  const id = scope.ids.next("sub_", 24)
  holding = id
  const itemIds: string[] = []
  for (const entry of priced) {
    const itemId = scope.ids.next("si_", 14)
    const record: SubscriptionItemRecord = {
      id: itemId,
      created: now,
      metadata: entry.item.metadata ?? {},
      price: entry.price.id,
      quantity: entry.item.quantity,
      subscription: id,
      discount_ids: [],
    }
    scope.account.subscriptionItems.insert(itemId, record)
    itemIds.push(itemId)
  }
  const subscription: SubscriptionRecord = {
    id,
    cancel_at: input.cancelAtPeriodEnd ? periodEnd : null,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    canceled_at: input.cancelAtPeriodEnd ? now : null,
    collection_method: input.collectionMethod ?? "charge_automatically",
    created: now,
    currency: first.price.currency,
    customer: input.customer,
    current_period_end: periodEnd,
    current_period_start: periodStart,
    days_until_due: input.daysUntilDue ?? null,
    default_payment_method: input.defaultPaymentMethod,
    discount_ids: [],
    ended_at: null,
    item_ids: itemIds,
    latest_invoice: null,
    metadata: input.metadata,
    pause_collection: null,
    schedule: input.schedule ?? null,
    start_date: start,
    status: trialing ? "trialing" : "incomplete",
    trial_end: trialing ? trialEnd : null,
    trial_start: trialing ? now : null,
    billing_cycle_anchor: anchored ? (input.billingCycleAnchor as number) : periodEnd,
    cancellation_details: {
      comment: null,
      feedback: null,
      reason: input.cancelAtPeriodEnd ? "cancellation_requested" : null,
    },
    upcoming_sent_for: null,
    payment_settings: input.paymentSettings ?? null,
    description: input.description ?? null,
    trial_settings: input.trialSettings ?? null,
  }
  scope.account.subscriptions.insert(id, subscription)
  const discountIds =
    input.discounts === undefined
      ? []
      : applyDiscountRequests(scope, input.discounts, {
          customer: input.customer,
          subscription: id,
        })
  const free = trialing || (anchored && input.prorationBehavior === "none")
  const period = { start: periodStart, end: periodEnd }
  const lines = priced.map((entry, index) =>
    lineFromPrice(scope, entry.price, entry.item.quantity, period, {
      subscription: id,
      subscriptionItem: itemIds[index] ?? null,
      ...(free
        ? {
            amount: 0,
            description: trialing
              ? `Trial period for ${scope.account.products.get(entry.price.product)?.name ?? entry.price.product}`
              : null,
          }
        : {}),
    }),
  )
  for (const item of addSubscriptionInvoiceItems(scope, subscription, input.addInvoiceItems ?? []))
    lines.push(invoiceItemLine(scope, item, id))
  const withDiscounts: SubscriptionRecord = { ...subscription, discount_ids: discountIds }
  scope.account.subscriptions.update(id, withDiscounts)
  let invoice = createDraftInvoice(scope, {
    customer: input.customer,
    subscription: id,
    lines,
    billingReason: "subscription_create",
    discountIds,
    period,
    collectionMethod: withDiscounts.collection_method,
    daysUntilDue: withDiscounts.days_until_due,
    defaultPaymentMethod: null,
    subscriptionMetadata: input.metadata,
  })
  claimInvoiceItems(scope, invoice)
  scope.account.subscriptions.update(id, { ...withDiscounts, latest_invoice: invoice.id })
  invoice = finalizeInvoice(scope, invoice)
  let status: SubscriptionRecord["status"] = trialing ? "trialing" : "incomplete"
  const behavior = input.paymentBehavior ?? "allow_incomplete"
  if (invoice.status === "paid") status = trialing ? "trialing" : "active"
  else if (invoice.collection_method === "send_invoice") status = "active"
  else if (behavior !== "default_incomplete") {
    const method =
      input.firstPaymentMethod ??
      (withDiscounts.default_payment_method === null
        ? defaultPaymentMethodOf(scope, input.customer)
        : scope.account.paymentMethods.get(withDiscounts.default_payment_method))
    if (method === undefined) {
      if (behavior === "error_if_incomplete") {
        rollbackSubscription(scope, id, invoice.id)
        throw invalidRequest(NO_PAYMENT_METHOD, undefined, "resource_missing")
      }
    } else {
      try {
        invoice = payInvoice(scope, invoice, {
          paymentMethod: method.id,
          offSession: input.offSession ?? false,
          ...(input.autoAuthenticate ? { autoAuthenticate: true } : {}),
        })
        if (invoice.status === "paid") status = trialing ? "trialing" : "active"
      } catch (error) {
        if (behavior === "error_if_incomplete") {
          rollbackSubscription(scope, id, invoice.id)
          throw error
        }
        if (!(error instanceof StripeError && error.init.type === "card_error")) throw error
        invoice = scope.account.invoices.get(invoice.id) ?? invoice
      }
    }
  }
  const created: SubscriptionRecord = {
    ...(scope.account.subscriptions.get(id) ?? withDiscounts),
    status,
    latest_invoice: invoice.id,
  }
  scope.account.subscriptions.update(id, created)
  const final = scope.account.subscriptions.get(id) ?? created
  const [firstUpdate] = held
  outer.emit(
    "customer.subscription.created",
    firstUpdate === undefined
      ? renderSubscription(final, scope.account)
      : { ...firstUpdate.object, ...firstUpdate.previous },
  )
  for (const update of held)
    outer.emit("customer.subscription.updated", update.object, update.previous)
  return { subscription: final, invoice }
}

const rollbackSubscription = (scope: RequestScope, subscriptionId: string, invoiceId: string) => {
  const subscription = scope.account.subscriptions.get(subscriptionId)
  for (const itemId of subscription?.item_ids ?? []) scope.account.subscriptionItems.delete(itemId)
  scope.account.subscriptions.delete(subscriptionId)
  const invoice = scope.account.invoices.get(invoiceId)
  if (invoice) scope.account.invoices.update(invoiceId, { ...invoice, status: "void" })
}

/**
 * `duration=once` discounts were spent on the invoice that created the subscription: at the next
 * renewal they end and leave the subscription.
 */
const spendOnceDiscounts = (scope: RequestScope, ids: readonly string[], at: number): string[] =>
  ids.filter((id) => {
    const discount = scope.account.discounts.get(id)
    const coupon = discount === undefined ? undefined : scope.account.coupons.get(discount.coupon)
    if (coupon?.duration !== "once") return true
    if (discount) scope.account.discounts.update(id, { ...discount, end: at })
    return false
  })

/** Discounts still in force at `now` (repeating ones expire). */
const liveDiscounts = (scope: RequestScope, ids: readonly string[], now: number) =>
  ids.filter((id) => {
    const discount = scope.account.discounts.get(id)
    return discount !== undefined && (discount.end === null || discount.end > now)
  })

export const subscriptionItems = (scope: RequestScope, subscription: SubscriptionRecord) =>
  subscription.item_ids
    .map((id) => scope.account.subscriptionItems.get(id))
    .filter((item): item is SubscriptionItemRecord => item !== undefined)

/** The lines of a subscription's next regular invoice. */
export const cycleLines = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  period: { start: number; end: number },
): InvoiceLineRecord[] => {
  const lines = subscriptionItems(scope, subscription).map((item) =>
    lineFromPrice(scope, requirePrice(scope, item.price), item.quantity ?? 1, period, {
      subscription: subscription.id,
      subscriptionItem: item.id,
    }),
  )
  for (const item of pendingItems(scope, subscription))
    lines.push(invoiceItemLine(scope, item, subscription.id))
  return lines
}

/** Does anything stand ready to pay this subscription's invoices off-session? */
export const hasPaymentMethod = (scope: RequestScope, subscription: SubscriptionRecord) =>
  (subscription.default_payment_method !== null &&
    scope.account.paymentMethods.get(subscription.default_payment_method) !== undefined) ||
  defaultPaymentMethodOf(scope, subscription.customer) !== undefined

/** Move the customer's pending invoice items onto an invoice that now bills them. */
const claimInvoiceItems = (scope: RequestScope, invoice: InvoiceRecord) => {
  for (const line of invoice.lines) {
    if (line.invoice_item === null) continue
    const item = scope.account.invoiceItems.get(line.invoice_item)
    if (item) scope.account.invoiceItems.update(item.id, { ...item, invoice: invoice.id })
  }
}

/**
 * Collect a finalized subscription invoice per the subscription's `pause_collection`: `void` and
 * `mark_uncollectible` settle it without a charge; otherwise it is charged off-session. Answers
 * the invoice and whether the charge failed.
 */
const collectCycleInvoice = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  finalized: InvoiceRecord,
): { invoice: InvoiceRecord; failed: boolean } => {
  const pause = subscription.pause_collection
  if (finalized.status !== "open") return { invoice: finalized, failed: false }
  if (pause?.behavior === "void") return { invoice: voidInvoice(scope, finalized), failed: false }
  if (pause?.behavior === "mark_uncollectible")
    return { invoice: markInvoiceUncollectible(scope, finalized), failed: false }
  if (finalized.collection_method !== "charge_automatically")
    return { invoice: finalized, failed: false }
  try {
    const paid = payInvoice(scope, finalized, { offSession: true })
    return { invoice: paid, failed: paid.status !== "paid" }
  } catch (error) {
    if (!(error instanceof StripeError)) throw error
    return { invoice: scope.account.invoices.get(finalized.id) ?? finalized, failed: true }
  }
}

/**
 * A trial ends with no payment method to charge and `trial_settings` says not to invoice:
 * `pause` stops the subscription (`paused`, `customer.subscription.paused`) until
 * `POST /v1/subscriptions/:id/resume`; `cancel` cancels it at the trial's end.
 */
const endTrialWithoutPaymentMethod = (
  scope: RequestScope,
  current: SubscriptionRecord,
  behavior: "cancel" | "pause",
  period: { start: number; end: number },
) => {
  if (behavior === "cancel") {
    cancelSubscription(scope, current, "cancellation_requested", period.start)
    return
  }
  const paused: SubscriptionRecord = {
    ...current,
    status: "paused",
    current_period_start: period.start,
    current_period_end: period.end,
  }
  saveSubscription(scope, current, paused)
  scope.emit("customer.subscription.paused", renderSubscription(paused, scope.account))
}

/**
 * One renewal: a new period, a `subscription_cycle` invoice charged off-session to the default
 * payment method, then `invoice.paid` (active) or `invoice.payment_failed` (past_due), and
 * `customer.subscription.updated` with the previous period bounds. While collection is paused
 * the invoice is kept as a draft, voided or marked uncollectible instead, and the status holds.
 */
export const cycleSubscription = (scope: RequestScope, current: SubscriptionRecord) => {
  const recurring = recurringOf(scope, current)
  const start = current.current_period_end
  const end = addInterval(start, recurring.interval, recurring.interval_count)
  const endingTrial = current.status === "trialing"
  const trialEndBehavior = current.trial_settings?.end_behavior.missing_payment_method
  if (
    endingTrial &&
    (trialEndBehavior === "pause" || trialEndBehavior === "cancel") &&
    current.collection_method === "charge_automatically" &&
    !hasPaymentMethod(scope, current)
  ) {
    endTrialWithoutPaymentMethod(scope, current, trialEndBehavior, { start, end })
    return
  }
  const moved: SubscriptionRecord = {
    ...current,
    current_period_start: start,
    current_period_end: end,
    status: endingTrial ? "active" : current.status,
  }
  scope.account.subscriptions.update(current.id, moved)
  const discountIds = spendOnceDiscounts(
    scope,
    liveDiscounts(scope, current.discount_ids, start),
    start,
  )
  const keepDraft = current.pause_collection?.behavior === "keep_as_draft"
  let invoice = createDraftInvoice(scope, {
    customer: current.customer,
    subscription: current.id,
    lines: cycleLines(scope, moved, { start, end }),
    billingReason: "subscription_cycle",
    discountIds,
    period: { start, end },
    collectionMethod: current.collection_method,
    daysUntilDue: current.days_until_due,
    subscriptionMetadata: current.metadata,
  })
  claimInvoiceItems(scope, invoice)
  let status: SubscriptionRecord["status"] = moved.status
  let exhausted = false
  if (!keepDraft) {
    const finalized = finalizeInvoice(scope, invoice)
    const collected = collectCycleInvoice(scope, current, finalized)
    invoice = collected.invoice
    if (
      finalized.status === "open" &&
      current.pause_collection === null &&
      finalized.collection_method === "charge_automatically"
    ) {
      status = collected.failed ? "past_due" : "active"
      // Declined at least once (no payment method at all schedules and exhausts nothing).
      exhausted =
        collected.failed && invoice.attempt_count > 0 && invoice.next_payment_attempt === null
    }
  }
  const latest = scope.account.subscriptions.get(current.id) ?? moved
  const next: SubscriptionRecord = {
    ...latest,
    status,
    discount_ids: discountIds,
    latest_invoice: invoice.id,
  }
  scope.account.subscriptions.update(next.id, next)
  const before = renderSubscription(current, scope.account)
  const after = renderSubscription(next, scope.account)
  const changed = changedFields(before, after)
  scope.emit("customer.subscription.updated", after, changed)
  if (exhausted) applyFailedPaymentOutcome(scope, next)
}

/** Once every retry of a renewal has failed: cancel the subscription, mark it unpaid, or leave it. */
const applyFailedPaymentOutcome = (scope: RequestScope, current: SubscriptionRecord) => {
  const outcome = scope.services.paymentRetries(scope.account.account).afterAllFail
  if (outcome === "cancel") cancelSubscription(scope, current, "payment_failed")
  else if (outcome === "unpaid") saveSubscription(scope, current, { ...current, status: "unpaid" })
}

/**
 * Run the scheduled collection retries of a subscription's open invoices that are due, oldest
 * first: a paid retry reactivates the subscription (`activateAfterPayment`), a declined one
 * schedules the next, and the last one applies the failed-payment outcome.
 */
const retryDueInvoices = (scope: RequestScope, subscription: SubscriptionRecord, now: number) => {
  for (let guard = 0; guard < 50; guard += 1) {
    const due = scope.account.invoices.list({
      order: "oldest",
      where: (invoice) =>
        invoice.subscription === subscription.id &&
        invoice.status === "open" &&
        invoice.collection_method === "charge_automatically" &&
        invoice.next_payment_attempt !== null &&
        invoice.next_payment_attempt <= now,
    })[0]?.value
    if (due === undefined) return
    let settled: InvoiceRecord
    try {
      settled = payInvoice(scope, due, { offSession: true })
    } catch (error) {
      if (!(error instanceof StripeError)) throw error
      settled = scope.account.invoices.get(due.id) ?? due
    }
    const current = scope.account.subscriptions.get(subscription.id)
    if (settled.status !== "open" || current === undefined) return
    if (settled.next_payment_attempt === due.next_payment_attempt) return
    if (settled.next_payment_attempt === null) applyFailedPaymentOutcome(scope, current)
    if (settled.next_payment_attempt === null || current.status !== "past_due") return
  }
}

/** The cents one period of a subscription's items bills, after its discounts live at `at`. */
const periodAmount = (scope: RequestScope, subscription: SubscriptionRecord, at: number) => {
  const lines = subscriptionItems(scope, subscription).map((item) => {
    const price = requirePrice(scope, item.price)
    return {
      amount: priceAmount(price, item.quantity ?? 1),
      price: price.id,
      currency: price.currency,
    }
  })
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0)
  const { totals } = discountLines(
    scope,
    liveDiscounts(scope, subscription.discount_ids, at),
    lines,
  )
  return subtotal - totals.reduce((sum, entry) => sum + entry.amount, 0)
}

/** A net-negative invoice is settled at $0 and its credit lands on the customer's balance. */
const creditNegativeInvoice = (scope: RequestScope, invoice: InvoiceRecord) => {
  if (invoice.subtotal >= 0 || invoice.customer === null) return
  const customer = findCustomer(scope, invoice.customer)
  if (!customer) return
  applyBalanceTransaction(scope, {
    customer,
    amount: invoice.subtotal,
    currency: invoice.currency,
    description: null,
    metadata: {},
    type: "applied_to_invoice",
    invoice: invoice.id,
  })
}

/**
 * Bill a proration: `create_prorations` leaves a pending proration item for the customer's next
 * invoice; `always_invoice` invoices and collects it now (a decline throws only when
 * `failOnDecline`); `none` bills nothing.
 */
export const billProration = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  amount: number,
  behavior: string,
  options: {
    period: { start: number; end: number }
    description: string
    failOnDecline?: boolean
  },
): InvoiceRecord | undefined => {
  // `always_invoice` also bills the subscription's pending `add_invoice_items` at once, even
  // with nothing to prorate (best guess, not oracle-verified).
  const added = behavior === "always_invoice" ? pendingItems(scope, subscription, "added") : []
  if ((amount === 0 || behavior === "none") && added.length === 0) return undefined
  const now = customerNow(scope, subscription.customer)
  if (behavior === "always_invoice") {
    const firstItem = scope.account.subscriptionItems.get(subscription.item_ids[0] ?? "")
    const price = requirePrice(scope, firstItem?.price ?? "")
    const prorations =
      amount === 0
        ? []
        : [
            {
              ...lineFromPrice(scope, price, 1, options.period, {
                subscription: subscription.id,
                subscriptionItem: firstItem?.id ?? null,
                amount,
                description: options.description,
              }),
              proration: true,
            },
          ]
    const draft = createDraftInvoice(scope, {
      customer: subscription.customer,
      subscription: subscription.id,
      lines: [...prorations, ...added.map((item) => invoiceItemLine(scope, item, subscription.id))],
      billingReason: "subscription_update",
      period: options.period,
      subscriptionMetadata: subscription.metadata,
    })
    claimInvoiceItems(scope, draft)
    const invoice = finalizeInvoice(scope, draft)
    creditNegativeInvoice(scope, invoice)
    let settled = invoice
    if (invoice.status === "open" && invoice.collection_method === "charge_automatically") {
      try {
        settled = payInvoice(scope, invoice, { offSession: true })
      } catch (error) {
        if (!(error instanceof StripeError) || options.failOnDecline) throw error
        settled = scope.account.invoices.get(invoice.id) ?? invoice
      }
    }
    const latest = scope.account.subscriptions.get(subscription.id) ?? subscription
    saveSubscription(scope, latest, { ...latest, latest_invoice: settled.id })
    return settled
  }
  const itemId = scope.ids.next("ii_", 24)
  scope.account.invoiceItems.insert(itemId, {
    id: itemId,
    amount,
    created: seconds(scope.now),
    currency: subscription.currency,
    customer: subscription.customer,
    date: now,
    description: options.description,
    discountable: false,
    invoice: null,
    metadata: {},
    period: options.period,
    price: null,
    proration: true,
    quantity: 1,
    unit_amount: amount,
  })
  return undefined
}

/** Do two recurring prices bill on the same period (`interval` and `interval_count`)? */
export const sameBillingPeriod = (a: Recurring, b: Recurring) =>
  a.interval === b.interval && a.interval_count === b.interval_count

/**
 * Invoice a billing cycle anchor reset. Switching to a price with a different billing period
 * moves the subscription's period to start now (the caller has already saved it): the customer
 * is invoiced for the whole new period at once, less a credit for the unused time on the
 * `previous` items unless `prorate` is off, and charged off-session: paid → `active`, declined →
 * `past_due`, the change stands either way.
 */
export const invoiceBillingCycleReset = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  previous: { items: SubscriptionItemRecord[]; period: { start: number; end: number } },
  prorate: boolean,
) => {
  const period = { start: subscription.current_period_start, end: subscription.current_period_end }
  const left =
    Math.max(0, previous.period.end - period.start) /
    (previous.period.end - previous.period.start || 1)
  const credits = prorate
    ? previous.items.map((item) => {
        const price = requirePrice(scope, item.price)
        return {
          ...lineFromPrice(
            scope,
            price,
            item.quantity ?? 1,
            { start: period.start, end: previous.period.end },
            {
              subscription: subscription.id,
              subscriptionItem: item.id,
              amount: -Math.round(priceAmount(price, item.quantity ?? 1) * left),
              description: "Unused time on the previous price (prorated)",
            },
          ),
          proration: true,
        }
      })
    : []
  const draft = createDraftInvoice(scope, {
    customer: subscription.customer,
    subscription: subscription.id,
    lines: [
      ...credits.filter((line) => line.amount !== 0),
      ...cycleLines(scope, subscription, period),
    ],
    billingReason: "subscription_update",
    discountIds: liveDiscounts(scope, subscription.discount_ids, period.start),
    period,
    collectionMethod: subscription.collection_method,
    daysUntilDue: subscription.days_until_due,
    subscriptionMetadata: subscription.metadata,
  })
  claimInvoiceItems(scope, draft)
  const finalized = finalizeInvoice(scope, draft)
  creditNegativeInvoice(scope, finalized)
  const collected = collectCycleInvoice(scope, subscription, finalized)
  const latest = scope.account.subscriptions.get(subscription.id) ?? subscription
  const charged =
    finalized.status === "open" &&
    !subscription.pause_collection &&
    finalized.collection_method === "charge_automatically"
  const next: SubscriptionRecord = {
    ...latest,
    status: charged ? (collected.failed ? "past_due" : "active") : latest.status,
    latest_invoice: collected.invoice.id,
  }
  saveSubscription(scope, latest, next)
  // A decline schedules the invoice's automatic retries (`retryDueInvoices`); with none left it
  // applies the account's failed-payment outcome at once, as a failed renewal does.
  if (
    charged &&
    collected.failed &&
    collected.invoice.attempt_count > 0 &&
    collected.invoice.next_payment_attempt === null
  )
    applyFailedPaymentOutcome(scope, next)
}

export type ResumeOptions = {
  billingCycleAnchor: "now" | "unchanged"
  prorationBehavior: "always_invoice" | "create_prorations" | "none"
  prorationDate?: number | undefined
}

/**
 * Resume a `paused` subscription. `billing_cycle_anchor=now` (the default) starts a new period
 * now and invoices it: paid → `active`, failed → `past_due`. `unchanged` keeps the anchor and
 * prorates what is left of the current period. Emits `customer.subscription.resumed`.
 */
export const resumeSubscription = (
  scope: RequestScope,
  current: SubscriptionRecord,
  options: ResumeOptions,
): SubscriptionRecord => {
  const now = customerNow(scope, current.customer)
  const recurring = recurringOf(scope, current)
  let next: SubscriptionRecord
  if (options.billingCycleAnchor === "now") {
    const period = {
      start: now,
      end: addInterval(now, recurring.interval, recurring.interval_count),
    }
    const moved: SubscriptionRecord = {
      ...current,
      current_period_start: period.start,
      current_period_end: period.end,
      billing_cycle_anchor: now,
    }
    scope.account.subscriptions.update(current.id, moved)
    const draft = createDraftInvoice(scope, {
      customer: current.customer,
      subscription: current.id,
      lines: cycleLines(scope, moved, period),
      billingReason: "subscription_update",
      discountIds: liveDiscounts(scope, current.discount_ids, now),
      period,
      collectionMethod: current.collection_method,
      daysUntilDue: current.days_until_due,
      subscriptionMetadata: current.metadata,
    })
    claimInvoiceItems(scope, draft)
    const collected = collectCycleInvoice(
      scope,
      { ...moved, pause_collection: null },
      finalizeInvoice(scope, draft),
    )
    const latest = scope.account.subscriptions.get(current.id) ?? moved
    next = {
      ...latest,
      status: collected.failed ? "past_due" : "active",
      latest_invoice: collected.invoice.id,
    }
  } else {
    let start = current.current_period_start
    let end = current.current_period_end
    for (let guard = 0; end <= now && guard < 10_000; guard += 1) {
      start = end
      end = addInterval(end, recurring.interval, recurring.interval_count)
    }
    const moved: SubscriptionRecord = {
      ...current,
      current_period_start: start,
      current_period_end: end,
      status: "active",
    }
    scope.account.subscriptions.update(current.id, moved)
    const at = Math.min(Math.max(options.prorationDate ?? now, start), end)
    const left = (end - at) / Math.max(1, end - start)
    billProration(
      scope,
      moved,
      Math.round(periodAmount(scope, moved, at) * left),
      options.prorationBehavior,
      { period: { start: at, end }, description: "Remaining time after resuming (prorated)" },
    )
    next = scope.account.subscriptions.get(current.id) ?? moved
  }
  scope.account.subscriptions.update(current.id, next)
  const rendered = renderSubscription(next, scope.account)
  const changed = changedFields(renderSubscription(current, scope.account), rendered)
  if (changed !== undefined) scope.emit("customer.subscription.updated", rendered, changed)
  scope.emit("customer.subscription.resumed", rendered)
  return next
}

export type CancelOptions = {
  comment?: string | null
  feedback?: string | null
  /** Credit the unused part of the current period as a proration. */
  prorate?: boolean
  /** Invoice pending items (and that credit) now instead of at the customer's next invoice. */
  invoiceNow?: boolean
}

/** Cancel now: `canceled`, `ended_at`, `customer.subscription.deleted`. */
export const cancelSubscription = (
  scope: RequestScope,
  current: SubscriptionRecord,
  reason = "cancellation_requested",
  at?: number,
  options: CancelOptions = {},
): SubscriptionRecord => {
  const now = at ?? customerNow(scope, current.customer)
  if (options.prorate && ["active", "past_due"].includes(current.status)) {
    const span = Math.max(1, current.current_period_end - current.current_period_start)
    const left = Math.max(0, current.current_period_end - now) / span
    billProration(
      scope,
      current,
      -Math.round(periodAmount(scope, current, now) * left),
      "create_prorations",
      {
        period: { start: now, end: current.current_period_end },
        description: "Unused time after cancellation (prorated)",
      },
    )
  }
  const details = current.cancellation_details
  const next: SubscriptionRecord = {
    ...current,
    cancel_at_period_end: false,
    canceled_at: current.canceled_at ?? now,
    cancellation_details: {
      comment: options.comment !== undefined ? options.comment : (details?.comment ?? null),
      feedback: options.feedback !== undefined ? options.feedback : (details?.feedback ?? null),
      reason,
    },
    ended_at: now,
    status: "canceled",
  }
  scope.account.subscriptions.update(next.id, next)
  if (options.invoiceNow) invoicePendingItems(scope, next, now)
  const final = scope.account.subscriptions.get(next.id) ?? next
  const rendered = renderSubscription(final, scope.account)
  scope.emit(
    "customer.subscription.deleted",
    rendered,
    changedFields(renderSubscription(current, scope.account), rendered),
  )
  return final
}

/**
 * The final invoice of a subscription canceled with `invoice_now`: every pending proration item
 * of the customer. A net credit lands on the customer's balance.
 */
const invoicePendingItems = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  now: number,
) => {
  const pending = pendingItems(scope, subscription)
  if (pending.length === 0) return
  const lines = pending.map((item) => invoiceItemLine(scope, item, subscription.id))
  const draft = createDraftInvoice(scope, {
    customer: subscription.customer,
    subscription: subscription.id,
    lines,
    billingReason: "subscription_update",
    period: { start: now, end: now },
    collectionMethod: subscription.collection_method,
    subscriptionMetadata: subscription.metadata,
  })
  claimInvoiceItems(scope, draft)
  const collected = collectCycleInvoice(
    scope,
    { ...subscription, pause_collection: null },
    finalizeInvoice(scope, draft),
  )
  creditNegativeInvoice(scope, draft)
  const latest = scope.account.subscriptions.get(subscription.id) ?? subscription
  scope.account.subscriptions.update(latest.id, { ...latest, latest_invoice: collected.invoice.id })
}

/** The invoice a subscription will produce at its next renewal (`GET /v1/invoices/upcoming`). */
export const upcomingInvoice = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
): RecordValue => {
  const recurring = recurringOf(scope, subscription)
  const start = subscription.current_period_end
  const end = addInterval(start, recurring.interval, recurring.interval_count)
  const customer = findCustomer(scope, subscription.customer)
  const lines = subscriptionItems(scope, subscription).map((item) => {
    const price = scope.account.prices.get(item.price)
    const amount =
      price === undefined ? 0 : Math.round(Number(price.unit_amount_decimal) * (item.quantity ?? 1))
    return {
      id: `il_tmp_${item.id.slice(3)}`,
      amount,
      currency: price?.currency ?? subscription.currency,
      description: null,
      discount_amounts: [],
      invoice_item: null,
      metadata: {},
      period: { start, end },
      price: item.price,
      quantity: item.quantity,
      proration: false,
      subtotal: amount,
      type: "subscription" as const,
      subscription: subscription.id,
      subscription_item: item.id,
    }
  })
  const preview: InvoiceRecord = recomputeInvoice(scope, {
    id: "",
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    attempt_count: 0,
    attempted: false,
    auto_advance: true,
    billing_reason: "upcoming",
    charge: null,
    collection_method: subscription.collection_method,
    created: start,
    currency: subscription.currency,
    customer: subscription.customer,
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    description: null,
    discount_ids: liveDiscounts(scope, subscription.discount_ids, start),
    due_date: null,
    ending_balance: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    lines,
    metadata: {},
    next_payment_attempt: subscription.status === "canceled" ? null : start,
    number: null,
    paid: false,
    payment_intent: null,
    period_end: start,
    period_start: subscription.current_period_start,
    status: "draft",
    status_transitions: {
      finalized_at: null,
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null,
    },
    subscription: subscription.id,
    subtotal: 0,
    total: 0,
    subscription_metadata: subscription.metadata,
    starting_balance: customer?.balance ?? 0,
  })
  const { id: _id, ...rendered } = renderInvoice(preview, scope.account)
  return rendered
}

// --- subscription schedules ---------------------------------------------------------------------

/** A stored schedule phase's `discounts`: an existing discount by id, else a coupon or code. */
export const phaseDiscountRequests = (phase: RecordValue): DiscountRequest[] =>
  (Array.isArray(phase.discounts) ? phase.discounts : []).flatMap((value): DiscountRequest[] => {
    const entry = recordOf(value)
    if (entry === undefined) return []
    if (typeof entry.discount === "string") return [{ discount: entry.discount }]
    if (typeof entry.promotion_code === "string") return [{ promotion_code: entry.promotion_code }]
    if (typeof entry.coupon === "string") return [{ coupon: entry.coupon }]
    return []
  })

/** What a discount was made from, to tell whether a phase asks for the discounts already on. */
const discountSourceKey = (scope: RequestScope, request: DiscountRequest | string): string => {
  if (typeof request === "string") {
    const record = scope.account.discounts.get(request)
    return record?.promotion_code ? `promo:${record.promotion_code}` : `coupon:${record?.coupon}`
  }
  if (request.discount !== undefined) return discountSourceKey(scope, request.discount)
  if (request.promotion_code !== undefined) return `promo:${request.promotion_code}`
  return `coupon:${request.coupon}`
}

/**
 * The subscription's discounts while `phase` is current: the phase's own (Stripe stores them per
 * phase and applies the current one's). Unchanged sources keep their discount records.
 */
const phaseDiscountIds = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  phase: RecordValue,
): string[] => {
  const requests = phaseDiscountRequests(phase)
  const wanted = requests.map((request) => discountSourceKey(scope, request)).join("|")
  const current = subscription.discount_ids.map((id) => discountSourceKey(scope, id)).join("|")
  if (wanted === current) return subscription.discount_ids
  try {
    const ids = applyDiscountRequests(
      scope,
      requests,
      { customer: subscription.customer, subscription: subscription.id },
      subscription.discount_ids,
      "phases",
      false,
    )
    discountsReplaced(scope, subscription.discount_ids, ids)
    return ids
  } catch (error) {
    // A coupon that lapsed since the phase was scheduled leaves the discounts as they are.
    if (error instanceof StripeError) return subscription.discount_ids
    throw error
  }
}

/** Apply a schedule phase's items to its subscription (no proration, as our callers ask). */
export const applyPhase = (
  scope: RequestScope,
  schedule: SubscriptionScheduleRecord,
  phase: RecordValue,
) => {
  if (schedule.subscription === null) return
  const subscription = scope.account.subscriptions.get(schedule.subscription)
  if (!subscription || !ACTIVE_STATES.includes(subscription.status)) return
  const items = Array.isArray(phase.items) ? (phase.items as RecordValue[]) : []
  const before = renderSubscription(subscription, scope.account)
  const current = subscriptionItems(scope, subscription)
  items.forEach((entry, index) => {
    const priceId = typeof entry.price === "string" ? entry.price : null
    if (priceId === null) return
    const quantity = Number(entry.quantity ?? 1) || 1
    const existing = current[index]
    if (existing)
      scope.account.subscriptionItems.update(existing.id, { ...existing, price: priceId, quantity })
  })
  const discounted = {
    ...subscription,
    discount_ids: phaseDiscountIds(scope, subscription, phase),
  }
  scope.account.subscriptions.update(subscription.id, discounted)
  const after = renderSubscription(discounted, scope.account)
  const changed = changedFields(before, after)
  if (changed !== undefined) scope.emit("customer.subscription.updated", after, changed)
}

export const phaseBounds = (phase: RecordValue) => ({
  start: typeof phase.start_date === "number" ? phase.start_date : Number(phase.start_date ?? 0),
  end:
    phase.end_date === undefined || phase.end_date === null
      ? null
      : typeof phase.end_date === "number"
        ? phase.end_date
        : Number(phase.end_date),
})

/** Move a schedule forward to `now`: enter due phases, then run its end behavior. */
export const advanceSchedule = (
  scope: RequestScope,
  schedule: SubscriptionScheduleRecord,
  now: number,
) => {
  if (schedule.status !== "active" && schedule.status !== "not_started") return
  let phases = schedule.phases
  let index = phases.findIndex((phase) => phase.current === true)
  let changed = false
  let status = schedule.status
  for (let guard = 0; guard < 1000; guard += 1) {
    const nextIndex = index + 1
    const current = index >= 0 ? phases[index] : undefined
    const currentEnd = current === undefined ? null : phaseBounds(current).end
    if (current !== undefined && currentEnd !== null && currentEnd <= now) {
      const upcoming = phases[nextIndex]
      if (upcoming === undefined) {
        // End of the schedule.
        const record = { ...schedule, phases: phases.map(({ current: _c, ...rest }) => rest) }
        if (schedule.end_behavior === "cancel" && schedule.subscription !== null) {
          const subscription = scope.account.subscriptions.get(schedule.subscription)
          if (subscription && subscription.status !== "canceled")
            cancelSubscription(scope, subscription)
          scope.account.subscriptionSchedules.update(schedule.id, {
            ...record,
            status: "completed",
            completed_at: now,
          })
        } else {
          releaseSchedule(scope, { ...record, status: "active" }, now)
        }
        return
      }
      phases = phases.map((phase, position) => ({ ...phase, current: position === nextIndex }))
      index = nextIndex
      status = "active"
      changed = true
      applyPhase(scope, { ...schedule, phases }, upcoming)
      continue
    }
    if (index === -1) {
      const firstPhase = phases[0]
      if (firstPhase !== undefined && phaseBounds(firstPhase).start <= now) {
        phases = phases.map((phase, position) => ({ ...phase, current: position === 0 }))
        index = 0
        status = "active"
        changed = true
        continue
      }
    }
    break
  }
  if (changed) {
    const next = { ...schedule, phases, status }
    scope.account.subscriptionSchedules.update(schedule.id, next)
  }
}

export const releaseSchedule = (
  scope: RequestScope,
  schedule: SubscriptionScheduleRecord,
  now: number,
): SubscriptionScheduleRecord => {
  const next: SubscriptionScheduleRecord = {
    ...schedule,
    status: "released",
    released_at: now,
    released_subscription: schedule.subscription,
    subscription: null,
  }
  scope.account.subscriptionSchedules.update(schedule.id, next)
  if (schedule.subscription !== null) {
    const subscription = scope.account.subscriptions.get(schedule.subscription)
    if (subscription && subscription.schedule === schedule.id)
      saveSubscription(scope, subscription, { ...subscription, schedule: null })
  }
  return next
}

// --- clock-driven lifecycle ---------------------------------------------------------------------

export type LifecycleSettings = {
  /** `invoice.upcoming` fires this many days before a renewal. */
  upcomingInvoiceDays: number
  /** `customer.subscription.trial_will_end` fires this many days before a trial ends. */
  trialWillEndDays: number
  /** An `incomplete` subscription expires after this many hours. */
  incompleteExpiryHours: number
  /** Retries of a failed renewal and what follows the last one (an account's `billing` overrides). */
  paymentRetries: PaymentRetryPolicy
}

export const DEFAULT_LIFECYCLE: LifecycleSettings = {
  upcomingInvoiceDays: 3,
  trialWillEndDays: 3,
  incompleteExpiryHours: 23,
  paymentRetries: DEFAULT_PAYMENT_RETRIES,
}

/**
 * Everything time moves forward in one account: schedule phases, renewals (possibly several),
 * cancellations at period end, `incomplete_expired`, `invoice.upcoming`, and Checkout Session
 * expiry. Runs on every request after the clock moved, on `POST /__admin/tick`, and when a test
 * clock advances (only that clock's customers).
 */
export const runLifecycle = (
  scope: RequestScope,
  settings: LifecycleSettings,
  onlyCustomers?: ReadonlySet<string>,
) => {
  const inScope = (customer: string | null) =>
    onlyCustomers === undefined
      ? customer === null || !findCustomer(scope, customer)?.test_clock
      : customer !== null && onlyCustomers.has(customer)
  for (const entry of scope.account.subscriptionSchedules.list({ order: "oldest" })) {
    const schedule = entry.value
    if (!inScope(schedule.customer)) continue
    advanceSchedule(scope, schedule, customerNow(scope, schedule.customer))
  }
  for (const entry of scope.account.subscriptions.list({ order: "oldest" })) {
    let subscription = entry.value
    if (!inScope(subscription.customer)) continue
    const now = customerNow(scope, subscription.customer)
    if (subscription.status === "incomplete") {
      if (subscription.created + settings.incompleteExpiryHours * 3600 <= now) {
        const invoice =
          subscription.latest_invoice === null
            ? undefined
            : scope.account.invoices.get(subscription.latest_invoice)
        if (invoice?.status === "open") voidInvoice(scope, invoice)
        saveSubscription(scope, subscription, {
          ...subscription,
          status: "incomplete_expired",
          ended_at: now,
        })
      }
      continue
    }
    if (
      subscription.status === "trialing" &&
      subscription.trial_end !== null &&
      subscription.trial_will_end_sent_for !== subscription.trial_end &&
      now >= subscription.trial_end - settings.trialWillEndDays * DAY
    ) {
      subscription = { ...subscription, trial_will_end_sent_for: subscription.trial_end }
      scope.account.subscriptions.update(subscription.id, subscription)
      scope.emit(
        "customer.subscription.trial_will_end",
        renderSubscription(subscription, scope.account),
      )
    }
    for (let guard = 0; guard < 120; guard += 1) {
      if (subscription.status === "past_due") {
        retryDueInvoices(scope, subscription, now)
        subscription = scope.account.subscriptions.get(subscription.id) ?? subscription
      }
      if (!["active", "trialing", "past_due"].includes(subscription.status)) break
      const cancelAt = subscription.cancel_at
      if (cancelAt !== null && cancelAt <= now) {
        subscription = cancelSubscription(scope, subscription, "cancellation_requested", cancelAt)
        break
      }
      // Collection resumes on its own at `resumes_at`, before any renewal it precedes.
      const resumesAt = subscription.pause_collection?.resumes_at ?? null
      if (resumesAt !== null && resumesAt <= now && resumesAt <= subscription.current_period_end) {
        const resumed: SubscriptionRecord = { ...subscription, pause_collection: null }
        saveSubscription(scope, subscription, resumed)
        subscription = resumed
      }
      if (subscription.current_period_end > now) break
      cycleSubscription(scope, subscription)
      subscription = scope.account.subscriptions.get(subscription.id) ?? subscription
    }
    if (
      ["active", "trialing"].includes(subscription.status) &&
      !subscription.cancel_at_period_end &&
      subscription.upcoming_sent_for !== subscription.current_period_end &&
      now >= subscription.current_period_end - settings.upcomingInvoiceDays * DAY
    ) {
      scope.account.subscriptions.update(subscription.id, {
        ...subscription,
        upcoming_sent_for: subscription.current_period_end,
      })
      scope.emit("invoice.upcoming", upcomingInvoice(scope, subscription))
    }
  }
  if (onlyCustomers !== undefined) return
  const now = seconds(scope.now)
  for (const entry of scope.account.checkoutSessions.list({ order: "oldest" })) {
    const session = entry.value
    if (session.status !== "open" || session.expires_at > now) continue
    const expired = { ...session, status: "expired" as const }
    scope.account.checkoutSessions.update(session.id, expired)
    scope.emit("checkout.session.expired", renderCheckoutSession(expired))
  }
}

export type { DiscountRecord }
