/**
 * A port of our backend's Stripe client logic (stripe-node 16.12 at `2024-06-20`, and the
 * partner-platform's stripe-node 17.7 at `2025-02-24.acacia`): the same calls, parameters,
 * idempotency keys, error classification, field fallbacks and webhook verification as
 * `apps/backend/src/modules/{billing,prescriptions,global-services,dev-tools}`,
 * `apps/geviti-emr-backend` and `apps/partner-platform`. The acceptance tests drive the mock
 * through it, so "the mock works" means "our consumer's own logic reaches the right outcome".
 */
import Stripe from "stripe"
// stripe 17.x ships ambient `declare module "stripe"` typings, which cannot load under an npm
// alias; the runtime is 17.7 and the surface we call is typed with 16.12's (same shapes here).
// @ts-expect-error see above
import StripeV17Runtime from "stripe-v17"

const StripeV17 = StripeV17Runtime as unknown as typeof Stripe
type StripeV17 = Stripe

export const LEGACY_API_VERSION = "2024-06-20" as const
export const PARTNER_API_VERSION = "2025-02-24.acacia" as const
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000

/**
 * G-S1: the one options factory every `new Stripe(...)` goes through, reading
 * `STRIPE_API_HOST/PORT/PROTOCOL` so a stack can point it at the mock.
 */
export const stripeClientOptions = (base: URL) => ({
  host: base.hostname,
  port: Number(base.port || (base.protocol === "https:" ? 443 : 80)),
  protocol: base.protocol.replace(":", "") as "http" | "https",
})

/** `B/billing/adapters/stripe.adapter.ts`: the MSO and PC clients (and the legacy one). */
export const backendClient = (key: string, base: URL) =>
  new Stripe(key, {
    apiVersion: LEGACY_API_VERSION,
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
    ...stripeClientOptions(base),
  })

/** `apps/partner-platform/src/payments/adapters/stripe/server-client.ts` (stripe 17.x). */
export const partnerClient = (key: string, base: URL) =>
  new StripeV17(key, {
    apiVersion: PARTNER_API_VERSION as unknown as typeof LEGACY_API_VERSION,
    ...stripeClientOptions(base),
  })

// --- errors -------------------------------------------------------------------------------------

type StripeLikeError = {
  type?: string
  rawType?: string
  code?: string
  param?: string
  message?: string
  statusCode?: number
  payment_intent?: { id?: string } | null
}

/** `stripe-customer.service.ts`: `resource_missing` on `customer`, or the message. */
export const isStripeMissingCustomerError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false
  const stripeErr = error as StripeLikeError
  if (stripeErr.code === "resource_missing" && stripeErr.param === "customer") return true
  return (stripeErr.message ?? "").includes("No such customer")
}

/** `prescription-stripe-payment-intent.ts:158-166`. */
export const isStripePaymentIntentMissing = (error: unknown): boolean => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as StripeLikeError).code === "resource_missing"
  )
    return true
  return error instanceof Error && error.message.toLowerCase().includes("no such payment_intent")
}

/** `stripe.service.ts:37-47`: cards Stripe refuses to reuse. */
export const NON_REUSABLE_STRIPE_PAYMENT_METHOD_MESSAGE =
  "This card is no longer valid for billing. Remove it from your account and add your payment method again."
export const isStripeNonReusablePaymentMethodError = (error: { message: string }) => {
  const message = error.message.toLowerCase()
  return (
    message.includes("may not be used again") ||
    message.includes("previously used without being attached") ||
    message.includes("was detached from a customer")
  )
}

/** `partner-companies.business.ts:407-444` (EMR). */
export const isStripeInvalidRequestError = (error: StripeLikeError) =>
  error.type === "StripeInvalidRequestError" ||
  error.rawType === "invalid_request_error" ||
  error.statusCode === 400
export const isStripeDuplicateCodeError = (error: StripeLikeError) => {
  if (!isStripeInvalidRequestError(error)) return false
  if (error.code === "resource_already_exists") return true
  return error.param === "code" && (error.message ?? "").toLowerCase().includes("already exists")
}

/** `supplement-billing.service.ts ~3355-3410`: what a retry answers for each Stripe failure. */
export const classifySupplementRetryError = (error: StripeLikeError) => {
  if (error.type === "StripeIdempotencyError" || error.code === "idempotency_key_in_use")
    return { status: 409, error: "retry_parameters_changed" } as const
  const isCardError =
    error.type === "StripeCardError" ||
    error.code === "card_declined" ||
    error.code === "expired_card" ||
    error.code === "insufficient_funds"
  if (
    !isCardError &&
    (error.type === "StripeConnectionError" ||
      error.type === "StripeAPIError" ||
      error.type === "StripeRateLimitError")
  )
    return { status: 503, error: "payment_service_unavailable" } as const
  return { status: 402, error: isCardError ? "card_declined" : "failed" } as const
}

/** `prescription-payment.service.ts:190-200`. */
export const isStripeIdempotencyConflict = (error: StripeLikeError) =>
  error.type === "idempotency_error" ||
  error.code === "idempotency_error" ||
  error.code === "idempotency_key_in_use"

// --- billing adapter (B/billing/adapters/stripe.adapter.ts) --------------------------------------

const CHARGEABLE_PM_TYPES = new Set(["card", "link"])

export class StripeAdapter {
  constructor(
    readonly mso: Stripe,
    readonly pc: Stripe,
  ) {}

  client(account: "mso" | "pc") {
    return account === "mso" ? this.mso : this.pc
  }

  async charge(params: {
    account: "mso" | "pc"
    amountCents: number
    customerId: string
    paymentMethodId?: string
    metadata?: Record<string, string>
    idempotencyKey: string
  }) {
    const createParams: Record<string, unknown> = {
      amount: params.amountCents,
      currency: "usd",
      customer: params.customerId,
      payment_method_types: ["card", "link"],
      confirm: true,
      off_session: true,
      metadata: params.metadata ?? {},
    }
    const stripe = this.client(params.account)
    if (params.paymentMethodId && params.paymentMethodId !== "default") {
      createParams.payment_method = params.paymentMethodId
    } else {
      const customer = await stripe.customers.retrieve(params.customerId, {
        expand: ["invoice_settings.default_payment_method"],
      })
      if (!(customer as Stripe.DeletedCustomer).deleted) {
        const defaultPm = (customer as Stripe.Customer).invoice_settings?.default_payment_method
        const defaultPmObj = defaultPm && typeof defaultPm !== "string" ? defaultPm : null
        if (defaultPmObj && CHARGEABLE_PM_TYPES.has(defaultPmObj.type)) {
          createParams.payment_method = defaultPmObj.id
        } else {
          const attached = await stripe.paymentMethods.list({
            customer: params.customerId,
            limit: 10,
          })
          const chargeable = attached.data.filter((pm) => CHARGEABLE_PM_TYPES.has(pm.type))
          if (chargeable.length === 1 && chargeable[0]) {
            createParams.payment_method = chargeable[0].id
            if (!defaultPm)
              await stripe.customers.update(params.customerId, {
                invoice_settings: { default_payment_method: chargeable[0].id },
              })
          }
        }
      }
    }
    const intent = await stripe.paymentIntents.create(
      createParams as unknown as Stripe.PaymentIntentCreateParams,
      { idempotencyKey: params.idempotencyKey },
    )
    return { id: intent.id, status: intent.status, amountCents: intent.amount }
  }

  async refund(
    paymentIntentId: string,
    amountCents: number | undefined,
    account: "mso" | "pc",
    idempotencyKey?: string,
  ) {
    const refund = await this.client(account).refunds.create(
      {
        payment_intent: paymentIntentId,
        ...(amountCents !== undefined ? { amount: amountCents } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    )
    return { id: refund.id, amountCents: refund.amount, status: refund.status }
  }

  async adjustCustomerBalance(
    customerId: string,
    amountCents: number,
    metadata: Record<string, string>,
    idempotencyKey: string,
  ) {
    await this.mso.customers.createBalanceTransaction(
      customerId,
      { amount: amountCents, currency: "usd", metadata },
      { idempotencyKey },
    )
  }

  /** Auto-paginates the customer's balance ledger. */
  async hasCustomerBalanceAdjustment(
    customerId: string,
    paymentIntentId: string,
    account: "mso" | "pc",
    source: string,
  ) {
    for await (const transaction of this.client(account).customers.listBalanceTransactions(
      customerId,
      { limit: 100 },
    )) {
      if (
        transaction.metadata?.paymentIntentId === paymentIntentId &&
        transaction.metadata?.source === source
      )
        return true
    }
    return false
  }

  /** `getCustomer`: null for deleted customers and on any failure. */
  async getCustomer(customerId: string) {
    try {
      const customer = await this.mso.customers.retrieve(customerId)
      if ((customer as Stripe.DeletedCustomer).deleted) return null
      const live = customer as Stripe.Customer
      const raw = live.invoice_settings?.default_payment_method ?? null
      return {
        balance: live.balance,
        defaultPaymentMethod: typeof raw === "string" ? raw : (raw?.id ?? null),
      }
    } catch {
      return null
    }
  }

  createOneShotDiscountCoupon(
    account: "mso" | "pc",
    amountOffCents: number,
    idempotencyKey: string,
  ) {
    return this.client(account).coupons.create(
      {
        amount_off: amountOffCents,
        currency: "usd",
        duration: "once",
        max_redemptions: 1,
        name: `credit:${idempotencyKey}`,
        metadata: { idempotencyKey },
      },
      { idempotencyKey: `coupon:${idempotencyKey}` },
    )
  }
}

/**
 * `stripe-customer.service.ts` `ensureCustomerForUser`: re-bind a live customer, recreate a
 * deleted, missing or foreign one.
 */
export const ensureCustomerForUser = async (
  stripe: Stripe,
  user: { id: string; email: string; name: string; stripeCustomerId: string | null },
) => {
  const existing = user.stripeCustomerId?.trim()
  if (existing) {
    try {
      const live = await stripe.customers.retrieve(existing)
      if ((live as Stripe.DeletedCustomer).deleted !== true) {
        const liveEmail = (live as Stripe.Customer).email?.trim().toLowerCase()
        if (!liveEmail || liveEmail === user.email.trim().toLowerCase())
          return { customerId: existing, created: false }
      }
    } catch (error) {
      if (!isStripeMissingCustomerError(error)) throw error
    }
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id },
  })
  return { customerId: customer.id, created: true }
}

// --- PC checkout (B/billing/services/pc-checkout.service.ts) -------------------------------------

export class PcCardRequiresUpdateError extends Error {
  constructor(
    readonly userId: string,
    readonly orderId: string,
  ) {
    super(`PC card requires update for user ${userId}, order ${orderId}`)
  }
}

export const createPcCheckoutSession = (
  pc: Stripe,
  input: {
    orderId: string
    userId: string
    amountCents: number
    quoteVersion: number
    description: string
  },
) => {
  const metadata = {
    intent: "pc_order",
    userId: input.userId,
    orderId: input.orderId,
    expectedAmountCents: String(input.amountCents),
    expectedCurrency: "usd",
    paymentType: "one_time",
    quoteVersion: String(input.quoteVersion),
  }
  return pc.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card", "link"],
      payment_intent_data: {
        setup_future_usage: "off_session",
        description: input.description,
        metadata,
      },
      customer_creation: "always",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: input.amountCents,
            product_data: { name: input.description },
          },
          quantity: 1,
        },
      ],
      success_url: "http://localhost:3000/rx/checkout/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost:3000/rx/checkout/cancel",
      metadata,
    },
    { idempotencyKey: `pc-checkout-${input.orderId}-${input.amountCents}-${input.quoteVersion}` },
  )
}

export const chargePcOrderOffSession = async (
  pc: Stripe,
  input: {
    pcCustomerId: string
    userId: string
    orderId: string
    amountCents: number
    description: string
  },
) => {
  const customer = await pc.customers.retrieve(input.pcCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  })
  const defaultPm = (customer as Stripe.Customer).invoice_settings?.default_payment_method
  if (!defaultPm || typeof defaultPm === "string" || !["card", "link"].includes(defaultPm.type))
    throw new PcCardRequiresUpdateError(input.userId, input.orderId)
  try {
    return await pc.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: "usd",
        customer: input.pcCustomerId,
        payment_method: defaultPm.id,
        payment_method_types: ["card", "link"],
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: { userId: input.userId, orderId: input.orderId, intent: "rx_payment" },
      },
      { idempotencyKey: `pc-order-${input.orderId}` },
    )
  } catch (error) {
    const stripeError = error as StripeLikeError
    if (stripeError.code === "authentication_required" || stripeError.code === "card_declined")
      throw new PcCardRequiresUpdateError(input.userId, input.orderId)
    throw error
  }
}

// --- Rx payment intent probe (prescription-stripe-payment-intent.ts) -----------------------------

export const retrievePrescriptionStripePaymentIntent = async (
  pc: Stripe,
  mso: Stripe,
  id: string,
) => {
  try {
    return {
      account: "pc" as const,
      intent: await pc.paymentIntents.retrieve(id, { expand: ["latest_charge"] }),
    }
  } catch (error) {
    if (!isStripePaymentIntentMissing(error)) throw error
  }
  try {
    return {
      account: "mso" as const,
      intent: await mso.paymentIntents.retrieve(id, { expand: ["latest_charge"] }),
    }
  } catch (error) {
    if (isStripePaymentIntentMissing(error)) return null
    throw error
  }
}

export const findSucceededPrescriptionIntents = async (
  stripe: Stripe,
  paymentId: string,
  keys: readonly string[],
) => {
  let truncated = false
  const matches: Stripe.PaymentIntent[] = []
  for (const metadataKey of keys) {
    const result = await stripe.paymentIntents.search({
      query: `metadata['${metadataKey}']:'${paymentId}'`,
      limit: 100,
      expand: ["data.latest_charge"],
    })
    truncated ||= result.has_more
    for (const intent of result.data)
      if (intent.status === "succeeded" && intent.metadata[metadataKey] === paymentId)
        matches.push(intent)
  }
  return { matches, truncated }
}

// --- kids checkout (family-kids-checkout.service.ts) --------------------------------------------

export const chargeKidsAnnual = async (
  mso: Stripe,
  input: {
    customerId: string
    paymentMethodId: string
    amountCents: number
    familyCheckoutId: string
  },
) => {
  try {
    const intent = await mso.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: "usd",
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          intent: "family_kids_annual",
          familyCheckoutId: input.familyCheckoutId,
          checkoutMode: "stripe",
        },
      },
      { idempotencyKey: `kids-${input.familyCheckoutId}` },
    )
    return { ok: true as const, intentId: intent.id }
  } catch (error) {
    const stripeError = error as StripeLikeError
    const failedIntent =
      typeof stripeError === "object" && stripeError !== null
        ? (stripeError.payment_intent ?? null)
        : null
    return {
      ok: false as const,
      attachedIntentId: failedIntent?.id ?? null,
      code:
        stripeError?.code === "authentication_required"
          ? "KIDS_PAYMENT_REQUIRES_ACTION"
          : "KIDS_PAYMENT_FAILED",
      message: stripeError?.message ?? "Kids checkout payment failed",
    }
  }
}

// --- payment history (payment-history.service.ts) ------------------------------------------------

export const PAYMENT_INTENT_HISTORY_EXPAND = [
  "payment_method",
  "invoice",
  "invoice.discount.coupon",
  "invoice.discount.promotion_code",
  "invoice.discounts.coupon",
  "invoice.discounts.promotion_code",
  "invoice.subscription",
  "latest_charge",
]

/** `paidInvoicesForSubscription`: rich expands, falling back to none on any error. */
export const paidInvoicesForSubscription = async (stripe: Stripe, subscription: string) => {
  try {
    return await stripe.invoices.list({
      subscription,
      status: "paid",
      limit: 5,
      expand: [
        "data.charge",
        "data.discount.coupon",
        "data.discount.promotion_code",
        "data.discounts.coupon",
        "data.discounts.promotion_code",
      ],
    })
  } catch {
    return stripe.invoices.list({ subscription, status: "paid", limit: 5 })
  }
}

// --- webhook receiver (billing.service verifyStripeData + stripe-webhook.controller) -------------

export type WebhookOutcome = {
  status: number
  body: Record<string, unknown>
  event?: Stripe.Event
}

const PC_QUARANTINE_SAFE_INTENTS = new Set([
  "pc_order",
  "kb_membership",
  "shop_purchase",
  "stripe_membership",
])

/**
 * `POST /billing/webhooks/stripe/{mso,pc}`: verify with `constructEvent` (a bad signature is a
 * 500, as `verifyStripeData` turns a null event into `InternalServerErrorException`), dedupe on
 * `event.id` (a duplicate still in flight is a 500), quarantine an unattributable paid PC
 * checkout, and answer `{received: true}`.
 */
export class StripeWebhookReceiver {
  readonly handled: Stripe.Event[] = []
  readonly quarantined: string[] = []
  private readonly seen = new Map<string, "in_flight" | "done">()

  constructor(
    private readonly secrets: { mso: string; pc: string },
    private readonly handler: (
      event: Stripe.Event,
      account: "mso" | "pc",
    ) => Promise<void> = async () => {},
  ) {}

  async receive(
    account: "mso" | "pc",
    rawBody: string,
    signature: string | null,
  ): Promise<WebhookOutcome> {
    if (!signature) return { status: 400, body: { message: "Signature not found" } }
    let event: Stripe.Event
    try {
      event = await Stripe.webhooks.constructEventAsync(rawBody, signature, this.secrets[account])
    } catch {
      return { status: 500, body: { message: "Failed to create event" } }
    }
    const state = this.seen.get(event.id)
    if (state === "in_flight")
      return { status: 500, body: { message: "duplicate in flight" }, event }
    if (state === "done") return { status: 200, body: { received: true, duplicate: true }, event }
    this.seen.set(event.id, "in_flight")
    try {
      if (account === "pc" && event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session
        const intent = session.metadata?.intent ?? ""
        const supplement =
          session.metadata?.source === "supplement" && Boolean(session.metadata?.billingInvoiceId)
        if (
          session.payment_status === "paid" &&
          !PC_QUARANTINE_SAFE_INTENTS.has(intent) &&
          !supplement
        ) {
          this.quarantined.push(event.id)
          this.seen.set(event.id, "done")
          return { status: 200, body: { received: true, quarantined: true }, event }
        }
      }
      await this.handler(event, account)
      this.handled.push(event)
      this.seen.set(event.id, "done")
      return { status: 200, body: { received: true }, event }
    } catch (error) {
      this.seen.delete(event.id)
      return {
        status: 500,
        body: { message: error instanceof Error ? error.message : String(error) },
        event,
      }
    }
  }
}

/** `stripe-event-replay.worker.ts`: the first page of both accounts' recent events. */
export const REPLAY_EVENT_TYPES = [
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.upcoming",
] as const

export const replayRecentEvents = async (mso: Stripe, pc: Stripe, since: number) => {
  const [msoEvents, pcEvents] = await Promise.all([
    mso.events.list({ types: [...REPLAY_EVENT_TYPES], created: { gte: since }, limit: 100 }),
    pc.events.list({ types: [...REPLAY_EVENT_TYPES], created: { gte: since }, limit: 100 }),
  ])
  return { mso: msoEvents.data, pc: pcEvents.data }
}

// --- dev tools (B/dev-tools/lib/stripe-client.ts) -----------------------------------------------

export const createCustomerOnTestClock = async (
  stripe: Stripe,
  email: string,
  frozenTime: number,
) => {
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: frozenTime,
    name: `qa:${email}`,
  })
  const customer = await stripe.customers.create({
    email,
    metadata: { source: "dev-tools" },
    test_clock: clock.id,
  })
  return { clockId: clock.id, customerId: customer.id }
}

/** Advance, then poll every `pollMs` (2 s in the app) up to 90 s until `ready`. */
export const advanceTestClock = async (
  stripe: Stripe,
  clockId: string,
  target: number,
  pollMs = 2000,
) => {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: target })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === "ready" || clock.status === "internal_failure") return clock
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error("Test clock advance timed out after 90000ms (still in advancing state)")
}

/** `attachTestCard` (E2E helper): attach a magic id, make the new pm_ the default. */
export const attachTestCard = async (stripe: Stripe, customerId: string, card = "pm_card_visa") => {
  const pm = await stripe.paymentMethods.attach(card, { customer: customerId })
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } })
  return pm
}

// --- partner platform (stripe-payment-gateway.adapter.ts, stripe-payment-catalog.adapter.ts) -----

export const createPartnerCheckout = async (
  stripe: StripeV17,
  input: {
    priceId: string
    successUrl: string
    cancelUrl: string
    metadata: Record<string, string>
  },
) => {
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    payment_intent_data: {
      metadata: Object.fromEntries(
        Object.entries(input.metadata).filter(([, value]) => value !== ""),
      ),
    },
  })
  if (!checkoutSession.url) return null
  return checkoutSession
}

/** After completion: find the PaymentIntent and stamp it with the session id (best effort). */
export const stampCheckoutSessionOnIntent = async (stripe: StripeV17, sessionId: string) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    })
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id
    if (!paymentIntentId) return null
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
    return await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { ...intent.metadata, checkoutSessionId: sessionId },
    })
  } catch {
    return null
  }
}

const escapeSearch = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

export const partnerPaymentsForUser = async (stripe: StripeV17, app: string, userId: string) =>
  (
    await stripe.paymentIntents.search({
      query: `metadata['app']:'${escapeSearch(app)}' AND metadata['authProviderUserId']:'${escapeSearch(userId)}'`,
      limit: 100,
    })
  ).data

export const partnerCatalog = async (stripe: StripeV17) => {
  const products: Stripe.Product[] = []
  let page: string | undefined
  do {
    const result = await stripe.products.search({
      query: "metadata['app']:'partner-platform' AND metadata['catalogScope']:'shared'",
      limit: 100,
      ...(page ? { page } : {}),
    })
    products.push(...result.data)
    page = result.has_more ? (result.next_page ?? undefined) : undefined
  } while (page)
  return products
}
