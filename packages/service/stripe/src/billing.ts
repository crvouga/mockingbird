import { invalidRequest, resourceMissing, StripeError, stateError } from "./errors.js"
import {
  applyBalanceTransaction,
  changedFields,
  clientSecretFor,
  customerNow,
  findCustomer,
  type RequestScope,
  requireCoupon,
  requirePrice,
} from "./internal.js"
import { confirmIntent, defaultPaymentMethodOf, resolvePaymentMethod } from "./payments.js"
import {
  renderCheckoutSession,
  renderInvoice,
  renderPaymentIntent,
  renderSubscription,
} from "./render.js"
import {
  type CouponRecord,
  type DiscountRecord,
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

const recurringOf = (scope: RequestScope, subscription: SubscriptionRecord): Recurring => {
  const first = subscription.item_ids
    .map((id) => scope.account.subscriptionItems.get(id))
    .find((item) => item !== undefined)
  const price = first === undefined ? undefined : scope.account.prices.get(first.price)
  return price?.recurring ?? { interval: "month", interval_count: 1, usage_type: "licensed" }
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
    ids.push(id)
  })
  return ids
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
  lines: ReadonlyArray<{ amount: number; price: string | null; currency: string }>,
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
      if (!couponApplies(scope, coupon, line.price)) return
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
    discount_ids: input.discountIds ?? [],
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
  },
): PaymentIntentRecord => {
  const id = scope.ids.next("pi_", 24)
  const intent: PaymentIntentRecord = {
    id,
    amount: input.amount,
    amount_capturable: 0,
    amount_received: 0,
    capture_method: "automatic_async",
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

/** Record a failed collection attempt on an open invoice. */
const markPaymentFailed = (scope: RequestScope, invoice: InvoiceRecord): InvoiceRecord => {
  const now = customerNow(scope, invoice.customer)
  const failed: InvoiceRecord = {
    ...invoice,
    attempt_count: invoice.attempt_count + 1,
    attempted: true,
    next_payment_attempt: now + 3 * DAY,
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
  options: { paymentMethod?: string | null; offSession: boolean; outOfBand?: boolean },
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
    const settled = confirmIntent(scope, intent, method, { offSession: options.offSession })
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
  backdateStartDate?: number | undefined
  billingCycleAnchor?: number | undefined
  prorationBehavior?: string | null
  discounts?: DiscountRequest[]
  addInvoiceItems?: Array<{ price: string; quantity: number }>
  paymentSettings?: RecordValue | null
  collectionMethod?: "charge_automatically" | "send_invoice"
  daysUntilDue?: number | null
  offSession?: boolean
  schedule?: string | null
  cancelAtPeriodEnd?: boolean
  /** Charge this payment method for the first invoice (checkout completion). */
  firstPaymentMethod?: PaymentMethodRecord
}

const ONE_TIME_ONLY =
  "The price specified is set to `type=one_time` but this field only accepts prices with `type=recurring`."

/**
 * Create a subscription with its items and first invoice, then collect that invoice per
 * `payment_behavior`: `default_incomplete` leaves it for the customer (a client secret on the
 * invoice's PaymentIntent); `error_if_incomplete` fails the whole call on a decline; the default
 * (`allow_incomplete`) charges the default payment method and returns `incomplete` on a decline.
 */
export const createSubscription = (
  scope: RequestScope,
  input: CreateSubscriptionInput,
): { subscription: SubscriptionRecord; invoice: InvoiceRecord } => {
  const priced = input.items.map((item, index) => {
    const price = requirePrice(scope, item.price, `items[${index}][price]`)
    if (price.recurring === null) throw invalidRequest(ONE_TIME_ONLY, `items[${index}][price]`)
    return { item, price }
  })
  const first = priced[0]
  if (first === undefined)
    throw invalidRequest("Missing required param: items.", "items", "parameter_missing")
  const recurring = first.price.recurring as Recurring
  const now = customerNow(scope, input.customer)
  const start = input.backdateStartDate ?? now
  const trialEnd =
    input.trialEnd === "now"
      ? null
      : (input.trialEnd ?? (input.trialPeriodDays ? now + input.trialPeriodDays * DAY : null))
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
  for (const extra of input.addInvoiceItems ?? []) {
    const price = requirePrice(scope, extra.price, "add_invoice_items[0][price]")
    lines.push({
      ...lineFromPrice(scope, price, extra.quantity, { start: now, end: now }),
      type: "invoiceitem",
    })
  }
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
        })
        if (invoice.status === "paid") status = "active"
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
  scope.emit("customer.subscription.created", renderSubscription(final, scope.account))
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
  const pending = scope.account.invoiceItems.list({
    order: "oldest",
    where: (item) =>
      item.customer === subscription.customer && item.invoice === null && item.proration,
  })
  for (const entry of pending) {
    const item = entry.value
    lines.push({
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
      proration: true,
      subtotal: item.amount,
      type: "invoiceitem",
      subscription: subscription.id,
    })
  }
  return lines
}

/**
 * One renewal: a new period, a `subscription_cycle` invoice charged off-session to the default
 * payment method, then `invoice.paid` (active) or `invoice.payment_failed` (past_due), and
 * `customer.subscription.updated` with the previous period bounds.
 */
export const cycleSubscription = (scope: RequestScope, current: SubscriptionRecord) => {
  const recurring = recurringOf(scope, current)
  const start = current.current_period_end
  const end = addInterval(start, recurring.interval, recurring.interval_count)
  const endingTrial = current.status === "trialing"
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
  for (const line of invoice.lines) {
    if (line.invoice_item === null) continue
    const item = scope.account.invoiceItems.get(line.invoice_item)
    if (item) scope.account.invoiceItems.update(item.id, { ...item, invoice: invoice.id })
  }
  invoice = finalizeInvoice(scope, invoice)
  let status: SubscriptionRecord["status"] = moved.status
  if (invoice.status !== "paid" && invoice.collection_method === "charge_automatically") {
    try {
      invoice = payInvoice(scope, invoice, { offSession: true })
      status = "active"
    } catch (error) {
      if (!(error instanceof StripeError)) throw error
      status = "past_due"
      invoice = scope.account.invoices.get(invoice.id) ?? invoice
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
}

/** Cancel now: `canceled`, `ended_at`, `customer.subscription.deleted`. */
export const cancelSubscription = (
  scope: RequestScope,
  current: SubscriptionRecord,
  reason = "cancellation_requested",
  at?: number,
): SubscriptionRecord => {
  const now = at ?? customerNow(scope, current.customer)
  const next: SubscriptionRecord = {
    ...current,
    cancel_at_period_end: false,
    canceled_at: current.canceled_at ?? now,
    cancellation_details: { comment: null, feedback: null, reason },
    ended_at: now,
    status: "canceled",
  }
  scope.account.subscriptions.update(next.id, next)
  const rendered = renderSubscription(next, scope.account)
  scope.emit(
    "customer.subscription.deleted",
    rendered,
    changedFields(renderSubscription(current, scope.account), rendered),
  )
  return next
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
  const after = renderSubscription(subscription, scope.account)
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
  /** An `incomplete` subscription expires after this many hours. */
  incompleteExpiryHours: number
}

export const DEFAULT_LIFECYCLE: LifecycleSettings = {
  upcomingInvoiceDays: 3,
  incompleteExpiryHours: 23,
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
    for (let guard = 0; guard < 120; guard += 1) {
      if (!["active", "trialing", "past_due"].includes(subscription.status)) break
      const cancelAt = subscription.cancel_at
      if (cancelAt !== null && cancelAt <= now) {
        subscription = cancelSubscription(scope, subscription, "cancellation_requested", cancelAt)
        break
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
