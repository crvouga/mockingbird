import { type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { accountOf } from "./account.js"
import { cardError, invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { mergeMetadata } from "./fields.js"
import { renderCheckoutSession, renderInvoice, renderPaymentIntent } from "./render.js"
import {
  type AccountState,
  type ChargeRecord,
  type CustomerEntry,
  type CustomerRecord,
  type DiscountRecord,
  type InvoiceLineRecord,
  type InvoiceRecord,
  type Metadata,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  type PriceRecord,
  type StripeState,
  seconds,
} from "./state.js"
import {
  type CardDetails,
  chargeOutcomeFor,
  TEST_CARD_TOKENS,
  TEST_PAYMENT_METHODS,
} from "./test-tokens.js"
import { STRIPE_API_VERSION } from "./version.js"

type RecordValue = Record<string, unknown>

/** What the server publishes when the mock records an event. */
export type StripeWebhookEvent = { type: string; account: string; body: string }

export type WebhookPublisher = (event: StripeWebhookEvent) => void

/** Everything a handler needs, resolved once per request from the bearer key. */
export type RequestScope = {
  account: AccountState
  ids: StripeState["ids"]
  now: () => number
  emit: (type: string, object: RecordValue, previous?: RecordValue) => string
}

export type Services = {
  state: StripeState
  publish: WebhookPublisher | undefined
}

export const requestScope = (services: Services, context: OperationContext): RequestScope => {
  const { state } = services
  const account = state.for(accountOf(context.request))
  const now = context.now
  return {
    account,
    ids: state.ids,
    now,
    emit: (type, object, previous) => {
      const id = state.ids.next("evt_")
      const created = seconds(now)
      const payload: RecordValue = {
        id,
        object: "event",
        api_version: STRIPE_API_VERSION,
        created,
        data: previous === undefined ? { object } : { object, previous_attributes: previous },
        livemode: false,
        pending_webhooks: 1,
        request: { id: state.ids.next("req_"), idempotency_key: null },
        type,
      }
      const body = JSON.stringify(payload)
      const sequence = account.events.nextSequence()
      account.events.insert(String(sequence), {
        id,
        type,
        created,
        account: account.account,
        body,
        data: payload.data as { object: RecordValue; previous_attributes?: RecordValue },
      })
      account.webhookDeliveryAttempts.insert(`${id}:1`, {
        message_id: id,
        account: account.account,
        attempt: 1,
        scheduled_at: new Date(now()).toISOString(),
        timeout_ms: 15_000,
        acknowledged: true,
      })
      // Delivery is best-effort: a failing publisher must never turn the API call into a 500. The
      // event is already in the ledger, so `GET /v1/events` (and the caller's replay sweep) can
      // still see it.
      try {
        services.publish?.({ type, account: account.account, body })
      } catch (error) {
        console.error(
          `stripe webhook publisher failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return id
    },
  }
}

/** Every field that changed, in the shape Stripe sends as `data.previous_attributes`. */
export const changedFields = (
  previous: RecordValue,
  next: RecordValue,
): RecordValue | undefined => {
  const changed: RecordValue = {}
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] === value) continue
    changed[key] = previous[key] ?? null
  }
  return Object.keys(changed).length === 0 ? undefined : changed
}

export const requireLiveCustomer = (scope: RequestScope, id: string, param = "customer") => {
  const entry = scope.account.customers.get(id)
  if (!entry || entry.kind === "deleted") throw resourceMissing("customer", id, param)
  return entry.customer
}

export const findCustomer = (scope: RequestScope, id: string): CustomerRecord | undefined => {
  const entry: CustomerEntry | undefined = scope.account.customers.get(id)
  return entry?.kind === "live" ? entry.customer : undefined
}

export const customerEmail = (scope: RequestScope, id: string | null) =>
  id === null ? null : (findCustomer(scope, id)?.email ?? null)

export const customerName = (scope: RequestScope, id: string | null) =>
  id === null ? null : (findCustomer(scope, id)?.name ?? null)

export const requirePrice = (scope: RequestScope, id: string, param = "price"): PriceRecord => {
  const price = scope.account.prices.get(id)
  if (!price) throw resourceMissing("price", id, param)
  return price
}

/** The amount a price charges for `quantity` units, in cents. */
export const priceAmount = (price: PriceRecord, quantity: number) =>
  Math.round(Number(price.unit_amount_decimal) * quantity)

/**
 * Resolve a payment method id, materialising Stripe's documented test payment methods
 * (`pm_card_visa` and friends) the first time they are used.
 */
export const resolvePaymentMethod = (scope: RequestScope, id: string): PaymentMethodRecord => {
  const existing = scope.account.paymentMethods.get(id)
  if (existing) return existing
  const details = TEST_PAYMENT_METHODS[id]
  if (!details) throw resourceMissing("payment_method", id, "payment_method")
  const record: PaymentMethodRecord = {
    id,
    type: "card",
    created: seconds(scope.now),
    customer: null,
    billing_details: {},
    card: cardPayload(details),
    metadata: {},
    token: id,
  }
  scope.account.paymentMethods.insert(id, record)
  return record
}

export const cardPayload = (details: CardDetails): RecordValue => ({
  brand: details.brand,
  checks: details.checks,
  country: details.country,
  display_brand: details.brand,
  exp_month: details.exp_month,
  exp_year: details.exp_year,
  fingerprint: opaqueToken(`card:${details.brand}:${details.last4}`, 16),
  funding: details.funding,
  last4: details.last4,
})

export const paymentMethodFromToken = (
  scope: RequestScope,
  token: string,
): { record: PaymentMethodRecord; details: CardDetails } => {
  const details = TEST_CARD_TOKENS[token]
  if (!details) throw invalidRequest(`No such token: '${token}'`, "card[token]", "resource_missing")
  const id = scope.ids.next("pm_")
  const record: PaymentMethodRecord = {
    id,
    type: "card",
    created: seconds(scope.now),
    customer: null,
    billing_details: {},
    card: cardPayload(details),
    metadata: {},
    token,
  }
  scope.account.paymentMethods.insert(id, record)
  return { record, details }
}

/**
 * Charge a payment intent. Success marks the intent succeeded and records a charge; a declining
 * test token raises the matching `card_error` instead, exactly as Stripe does at confirmation time.
 */
export const confirmPaymentIntent = (
  scope: RequestScope,
  intent: PaymentIntentRecord,
  paymentMethodId: string | null,
): PaymentIntentRecord => {
  if (intent.status === "canceled")
    throw invalidRequest(
      `The PaymentIntent has a status of canceled, so it cannot be confirmed.`,
      undefined,
      "payment_intent_unexpected_state",
    )
  if (paymentMethodId === null) return intent
  if (intent.capture_method === "manual") {
    const charge = createCharge(scope, {
      amount: intent.amount,
      captured: false,
      currency: intent.currency,
      customer: intent.customer,
      payment_intent: intent.id,
      payment_method: paymentMethodId,
      invoice: intent.invoice,
      metadata: intent.metadata,
    })
    const authorized: PaymentIntentRecord = {
      ...intent,
      amount_capturable: intent.amount,
      latest_charge: charge.id,
      payment_method: paymentMethodId,
      status: "requires_capture",
      charge_ids: [...intent.charge_ids, charge.id],
    }
    scope.account.paymentIntents.update(intent.id, authorized)
    return authorized
  }
  const outcome = chargeOutcomeFor(paymentMethodId)
  if (outcome.kind === "card_error") {
    const failed: PaymentIntentRecord = {
      ...intent,
      payment_method: paymentMethodId,
      status: "requires_payment_method",
      last_payment_error: {
        code: outcome.code,
        decline_code: outcome.decline_code ?? null,
        message: outcome.message,
        type: "card_error",
      },
    }
    scope.account.paymentIntents.update(intent.id, failed)
    throw cardError(outcome.message, outcome.code, outcome.decline_code ?? outcome.code)
  }
  const charge = createCharge(scope, {
    amount: intent.amount,
    currency: intent.currency,
    customer: intent.customer,
    payment_intent: intent.id,
    payment_method: paymentMethodId,
    invoice: intent.invoice,
    metadata: intent.metadata,
  })
  const succeeded: PaymentIntentRecord = {
    ...intent,
    amount_received: intent.amount,
    amount_capturable: 0,
    latest_charge: charge.id,
    payment_method: paymentMethodId,
    status: "succeeded",
    charge_ids: [...intent.charge_ids, charge.id],
  }
  scope.account.paymentIntents.update(intent.id, succeeded)
  return succeeded
}

export const createCharge = (
  scope: RequestScope,
  input: {
    amount: number
    currency: string
    customer: string | null
    payment_intent: string | null
    payment_method: string | null
    captured?: boolean
    invoice?: string | null
    metadata?: Metadata
  },
): ChargeRecord => {
  const id = scope.ids.next("ch_")
  const captured = input.captured ?? true
  const record: ChargeRecord = {
    id,
    amount: input.amount,
    amount_captured: captured ? input.amount : 0,
    amount_refunded: 0,
    captured,
    created: seconds(scope.now),
    currency: input.currency,
    customer: input.customer,
    description: null,
    disputed: false,
    invoice: input.invoice ?? null,
    metadata: input.metadata ?? {},
    paid: true,
    payment_intent: input.payment_intent,
    payment_method: input.payment_method,
    refunded: false,
    status: "succeeded",
    refund_ids: [],
  }
  scope.account.charges.insert(id, record)
  return record
}

/** `<pi>_secret_<opaque>`: callers recover the intent id by splitting on `_secret_`. */
export const clientSecretFor = (id: string) => `${id}_secret_${opaqueToken(`${id}:secret`, 24)}`

/**
 * A checkout session completes when its payment intent (or setup intent) succeeds: the session
 * flips to `complete` with the matching payment status and Stripe emits
 * `checkout.session.completed`.
 */
export const completeSessionsForIntent = (
  scope: RequestScope,
  intent: { paymentIntent?: string; setupIntent?: string },
) => {
  for (const entry of scope.account.checkoutSessions.list({ order: "oldest" })) {
    const session = entry.value
    if (session.status !== "open") continue
    const matches =
      (intent.paymentIntent !== undefined && session.payment_intent === intent.paymentIntent) ||
      (intent.setupIntent !== undefined && session.setup_intent === intent.setupIntent)
    if (!matches) continue
    const completed = {
      ...session,
      payment_status:
        session.mode === "setup" ? ("no_payment_required" as const) : ("paid" as const),
      status: "complete" as const,
    }
    scope.account.checkoutSessions.update(session.id, completed)
    scope.emit("checkout.session.completed", renderCheckoutSession(completed))
  }
}

/**
 * Open an invoice for the given lines: Stripe's `subscription_create` / `manual` invoices start
 * open with `amount_due` equal to the summed lines, and emit `invoice.created`.
 */
export const openInvoice = (
  scope: RequestScope,
  input: {
    customer: string | null
    subscription: string | null
    lines: InvoiceLineRecord[]
    billingReason: string
    metadata?: Metadata
    period?: { start: number; end: number }
  },
): InvoiceRecord => {
  const id = scope.ids.next("in_")
  const created = seconds(scope.now)
  const subtotal = input.lines.reduce((total, line) => total + line.amount, 0)
  const customer = input.customer === null ? undefined : findCustomer(scope, input.customer)
  const previous = scope.account.invoices
    .list({ order: "oldest" })
    .filter((entry) => entry.value.customer === input.customer).length
  const prefix = customer?.invoice_prefix ?? "MOCKING"
  const period = input.period ?? { start: created, end: created }
  const record: InvoiceRecord = {
    id,
    amount_due: subtotal,
    amount_paid: 0,
    amount_remaining: subtotal,
    attempt_count: 0,
    attempted: false,
    auto_advance: true,
    billing_reason: input.billingReason,
    charge: null,
    collection_method: "charge_automatically",
    created,
    currency: input.lines[0]?.currency ?? "usd",
    customer: input.customer,
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    description: null,
    discount_ids: [],
    due_date: null,
    ending_balance: 0,
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
    invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
    metadata: input.metadata ?? {},
    next_payment_attempt: null,
    number: `${prefix}-${String(previous + 1).padStart(4, "0")}`,
    paid: false,
    payment_intent: null,
    period_end: period.end,
    period_start: period.start,
    status: "open",
    status_transitions: {
      finalized_at: created,
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null,
    },
    subscription: input.subscription,
    subtotal,
    total: subtotal,
    lines: input.lines,
  }
  scope.account.invoices.insert(id, record)
  scope.emit("invoice.created", renderInvoice(record, scope.account))
  return record
}
export const requireIntent = (scope: RequestScope, id: string, param = "intent") => {
  const intent = scope.account.paymentIntents.get(id)
  if (!intent) throw resourceMissing("payment_intent", id, param)
  return intent
}

export const requireCharge = (scope: RequestScope, id: string, param = "charge") => {
  const charge = scope.account.charges.get(id)
  if (!charge) throw resourceMissing("charge", id, param)
  return charge
}

export const requireInvoice = (scope: RequestScope, id: string, param = "invoice") => {
  const invoice = scope.account.invoices.get(id)
  if (!invoice) throw resourceMissing("invoice", id, param)
  return invoice
}

export const requireSubscription = (
  scope: RequestScope,
  id: string,
  param = "subscription_exposed_id",
) => {
  const subscription = scope.account.subscriptions.get(id)
  if (!subscription) throw resourceMissing("subscription", id, param)
  return subscription
}

export const requireSession = (scope: RequestScope, id: string, param = "session") => {
  const session = scope.account.checkoutSessions.get(id)
  if (!session) throw resourceMissing("checkout.session", id, param)
  return session
}

export const requireCoupon = (scope: RequestScope, id: string, param = "coupon") => {
  const coupon = scope.account.coupons.get(id)
  if (!coupon) throw resourceMissing("coupon", id, param)
  return coupon
}

/** Apply a customer's balance delta and record the matching balance transaction. */
export const applyBalanceTransaction = (
  scope: RequestScope,
  input: {
    customer: CustomerRecord
    amount: number
    currency: string
    description: string | null
    metadata: Metadata
    type: string
    invoice?: string | null
  },
): { id: string; ending_balance: number } => {
  const id = scope.ids.next("cbtxn_")
  const ending = input.customer.balance + input.amount
  scope.account.customers.update(input.customer.id, {
    kind: "live",
    customer: { ...input.customer, balance: ending },
  })
  scope.account.balanceTransactions.insert(id, {
    id,
    amount: input.amount,
    created: seconds(scope.now),
    credit_note: null,
    currency: input.currency,
    customer: input.customer.id,
    description: input.description,
    ending_balance: ending,
    invoice: input.invoice ?? null,
    metadata: input.metadata,
    type: input.type,
  })
  return { id, ending_balance: ending }
}

/** Metadata merge with Stripe's `""`-clears semantics. */
export const mergeRecordMetadata = (current: Metadata, incoming: unknown): Metadata =>
  incoming === undefined ? current : mergeMetadata(current, incoming)

export const adjustmentsByReason = (reason: string | null): RecordValue[] =>
  reason === null ? [] : [{ amount: 0, discount: null, reason }]

/** A draft invoice's money fields are derived from its lines. */
export const recomputeInvoice = (invoice: InvoiceRecord): InvoiceRecord => {
  const subtotal = invoice.lines.reduce((total, line) => total + line.amount, 0)
  const paid = invoice.amount_paid
  return {
    ...invoice,
    subtotal,
    total: subtotal,
    amount_due: Math.max(0, subtotal - paid),
    amount_remaining: Math.max(0, subtotal - paid),
  }
}

export const invoiceLineFromItem = (
  scope: RequestScope,
  item: {
    id: string
    amount: number
    currency: string
    description: string | null
    quantity: number
    metadata: Metadata
    price: string | null
  },
): InvoiceLineRecord => ({
  id: scope.ids.next("il_"),
  amount: item.amount,
  currency: item.currency,
  description: item.description,
  discount_amounts: [],
  invoice_item: item.id,
  metadata: item.metadata,
  period: { start: seconds(scope.now), end: seconds(scope.now) },
  price: item.price,
  quantity: item.quantity,
  proration: false,
  subtotal: item.amount,
  type: "invoiceitem",
})

export const invoiceLineFromPrice = (
  scope: RequestScope,
  price: PriceRecord,
  quantity: number,
): InvoiceLineRecord => ({
  id: scope.ids.next("il_"),
  amount: priceAmount(price, quantity),
  currency: price.currency,
  description: null,
  discount_amounts: [],
  invoice_item: null,
  metadata: {},
  period: { start: seconds(scope.now), end: seconds(scope.now) },
  price: price.id,
  quantity,
  proration: false,
  subtotal: priceAmount(price, quantity),
  type: "subscription",
})

export const createDiscount = (
  scope: RequestScope,
  input: {
    coupon: string
    promotion_code?: string | null
    customer?: string | null
    subscription?: string | null
    end?: number | null
  },
): DiscountRecord => {
  const id = scope.ids.next("di_")
  const record: DiscountRecord = {
    id,
    coupon: input.coupon,
    promotion_code: input.promotion_code ?? null,
    customer: input.customer ?? null,
    subscription: input.subscription ?? null,
    start: seconds(scope.now),
    end: input.end ?? null,
  }
  scope.account.discounts.insert(id, record)
  return record
}

export const subscriptionPeriod = (
  now: () => number,
  interval: "day" | "week" | "month" | "year",
  count: number,
) => {
  const start = seconds(now)
  const secondsPerDay = 86_400
  const days =
    interval === "day"
      ? count
      : interval === "week"
        ? count * 7
        : interval === "month"
          ? count * 30
          : count * 365
  return { start, end: start + days * secondsPerDay }
}

export const requireParam = (params: RecordValue, key: string): string => {
  const value = params[key]
  if (typeof value !== "string" || value === "") throw parameterMissing(key)
  return value
}

export const renderIntentForEvent = (intent: PaymentIntentRecord) => renderPaymentIntent(intent)
