import { afterIntentSucceeded, createSubscription, newIntentRecord, redeem } from "./billing.js"
import { StripeError, stateError } from "./errors.js"
import { clientSecretFor, findCustomer, type RequestScope } from "./internal.js"
import { attachPaymentMethod, confirmIntent, paymentMethodFromCard } from "./payments.js"
import { renderCheckoutSession, renderCustomer, renderSetupIntent } from "./render.js"
import {
  type CheckoutSessionRecord,
  type CustomerRecord,
  type PaymentMethodRecord,
  type SetupIntentRecord,
  seconds,
} from "./state.js"
import { chargeOutcomeFor } from "./test-tokens.js"

/** `{CHECKOUT_SESSION_ID}` substituted in a success URL, raw and percent-encoded. */
export const successUrlFor = (session: CheckoutSessionRecord): string | null =>
  session.success_url === null
    ? null
    : session.success_url
        .split("{CHECKOUT_SESSION_ID}")
        .join(session.id)
        .replace(/%7BCHECKOUT_SESSION_ID%7D/gi, session.id)

export const newCustomer = (
  scope: RequestScope,
  fields: Partial<Pick<CustomerRecord, "email" | "name" | "metadata">> = {},
): CustomerRecord => {
  const id = scope.ids.next("cus_", 14)
  const customer: CustomerRecord = {
    id,
    address: null,
    balance: 0,
    created: seconds(scope.now),
    currency: null,
    description: null,
    email: fields.email ?? null,
    invoice_prefix: id.slice(4, 12).toUpperCase(),
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    metadata: fields.metadata ?? {},
    name: fields.name ?? null,
    phone: null,
    preferred_locales: [],
    shipping: null,
    tax_exempt: "none",
    test_clock: null,
  }
  scope.account.customers.insert(id, { kind: "live", customer })
  scope.emit("customer.created", renderCustomer(customer))
  return customer
}

export type CompletionResult =
  | { ok: true; session: CheckoutSessionRecord }
  | { ok: false; message: string; code: string }

/** What the shopper entered on the hosted page (or an admin completion supplied). */
export type CompletionInput = {
  /** A test card number; `null` completes without a card where none is required. */
  card: string | null
  expMonth?: number
  expYear?: number
  email?: string | null
  name?: string | null
  country?: string | null
  postalCode?: string | null
}

/** The amount the session's first charge collects: recurring lines are free during a trial. */
export const amountDueNow = (scope: RequestScope, session: CheckoutSessionRecord): number => {
  if (session.mode === "setup") return 0
  const trialing =
    session.mode === "subscription" &&
    session.subscription_data?.trial_end !== null &&
    session.subscription_data?.trial_end !== undefined
  if (!trialing) return session.amount_total
  return session.line_items
    .filter((line) => {
      const price = line.price === null ? undefined : scope.account.prices.get(line.price)
      return price?.recurring === null || price === undefined
    })
    .reduce((sum, line) => sum + line.amount_total, 0)
}

/**
 * Does this session need a card? Setup always does; payment mode only when something is due;
 * subscription mode does unless `payment_method_collection=if_required` and nothing is due now.
 */
export const requiresCard = (scope: RequestScope, session: CheckoutSessionRecord): boolean => {
  if (session.mode === "setup") return true
  if (session.mode === "payment") return session.amount_total > 0
  return session.payment_method_collection !== "if_required" || amountDueNow(scope, session) > 0
}

const billingDetailsOf = (input: CompletionInput, email: string | null) => ({
  address: {
    city: null,
    country: input.country ?? null,
    line1: null,
    line2: null,
    postal_code: input.postalCode ?? null,
    state: null,
  },
  email,
  name: input.name ?? null,
  phone: null,
  tax_id: null,
})

/** The card as a payment method carrying the expiry and billing details the shopper typed. */
const cardMethod = (scope: RequestScope, input: CompletionInput, email: string | null) => {
  const method = paymentMethodFromCard(scope, input.card ?? "", "card")
  const card = method.card ?? {}
  const withDetails = {
    ...method,
    billing_details: billingDetailsOf(input, email),
    card: {
      ...card,
      ...(input.expMonth === undefined ? {} : { exp_month: input.expMonth }),
      ...(input.expYear === undefined ? {} : { exp_year: input.expYear }),
    },
  }
  scope.account.paymentMethods.update(method.id, withDetails)
  return withDetails
}

/**
 * Complete an open Checkout Session, as the hosted page's Pay button (or
 * `POST /__admin/checkout/sessions/:id/complete`) does: create the customer when the session
 * asks for one, then the PaymentIntent (with `payment_intent_data.metadata`), the Subscription
 * (with `subscription_data`, one-time lines on its first invoice) or the SetupIntent; on success
 * flip the session to `complete` and emit `checkout.session.completed` last, after the objects it
 * references. A decline leaves the session open and creates no customer.
 */
export const completeSession = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  given: string | CompletionInput,
): CompletionResult => {
  if (session.status !== "open")
    throw stateError(
      `This Checkout Session is no longer active (status: ${session.status}).`,
      "checkout_session_not_open",
    )
  const input: CompletionInput = typeof given === "string" ? { card: given } : given
  const existing = session.customer === null ? undefined : findCustomer(scope, session.customer)
  const email = input.email || existing?.email || session.customer_email || null
  const needsCard = requiresCard(scope, session)
  const card = input.card ?? (needsCard ? "4242424242424242" : null)
  const method = card === null ? undefined : cardMethod(scope, { ...input, card }, email)
  // Nothing is created for a card that is going to be declined outright.
  if (method !== undefined && session.mode !== "payment") {
    const outcome = chargeOutcomeFor(method.token)
    if (outcome.kind === "card_error")
      return { ok: false, message: outcome.message, code: outcome.code }
  }
  const needsCustomer =
    session.customer === null &&
    (session.customer_creation === "always" ||
      session.mode !== "payment" ||
      (session.payment_intent_data?.setup_future_usage !== null &&
        session.payment_intent_data?.setup_future_usage !== undefined))
  const customerId = needsCustomer
    ? newCustomer(scope, {
        email,
        ...(input.name ? { name: input.name } : {}),
      }).id
    : session.customer
  const details: CheckoutSessionRecord["customer_details"] = {
    email,
    name: input.name ?? existing?.name ?? null,
    address:
      input.country || input.postalCode
        ? { country: input.country ?? null, postal_code: input.postalCode ?? null }
        : null,
  }
  let next: CheckoutSessionRecord = { ...session, customer: customerId, customer_details: details }
  try {
    if (session.mode === "payment") {
      if (session.amount_total === 0 || method === undefined) {
        next = { ...next, payment_status: "no_payment_required" }
      } else {
        const data = session.payment_intent_data
        const intent = newIntentRecord(scope, {
          amount: session.amount_total,
          currency: session.currency,
          customer: customerId,
          invoice: null,
          metadata: data?.metadata ?? {},
          description: data?.description ?? null,
          setupFutureUsage: data?.setup_future_usage ?? null,
          paymentMethodTypes: session.payment_method_types ?? ["card"],
          ...(data?.capture_method === undefined ? {} : { captureMethod: data.capture_method }),
        })
        next = { ...next, payment_intent: intent.id }
        scope.account.checkoutSessions.update(session.id, next)
        const settled = confirmIntent(scope, intent, method, {
          offSession: false,
          autoAuthenticate: true,
        })
        afterIntentSucceeded(scope, settled)
        // An authorization only (`capture_method=manual`) completes the session unpaid until the
        // PaymentIntent is captured (best guess, not oracle-verified).
        next = {
          ...next,
          payment_status: settled.status === "requires_capture" ? "unpaid" : "paid",
        }
      }
    } else if (session.mode === "subscription") {
      const attached =
        method === undefined ? undefined : attachPaymentMethod(scope, method, customerId as string)
      const priced = session.line_items
        .filter((line) => line.price !== null)
        .map((line) => ({ line, price: scope.account.prices.get(line.price as string) }))
      const { subscription, invoice } = createSubscription(scope, {
        customer: customerId as string,
        items: priced
          .filter((entry) => entry.price?.recurring != null)
          .map(({ line }) => ({ price: line.price as string, quantity: line.quantity ?? 1 })),
        addInvoiceItems: priced.flatMap(({ line, price }) =>
          price === undefined || price.recurring !== null
            ? []
            : [
                {
                  price,
                  inline: false,
                  quantity: line.quantity ?? 1,
                  metadata: {},
                  discountable: undefined,
                },
              ],
        ),
        metadata: session.subscription_data?.metadata ?? {},
        description: session.subscription_data?.description ?? null,
        trialSettings: session.subscription_data?.trial_settings ?? null,
        defaultPaymentMethod: attached?.id ?? null,
        paymentBehavior: attached === undefined ? "default_incomplete" : "error_if_incomplete",
        trialEnd: session.subscription_data?.trial_end ?? null,
        discounts: (session.discount_refs ?? []).map((ref) =>
          ref.promotion_code !== null
            ? { promotion_code: ref.promotion_code }
            : { coupon: ref.coupon ?? "" },
        ),
        allowInactivePrices: true,
        autoAuthenticate: true,
        ...(attached === undefined ? {} : { firstPaymentMethod: attached }),
      })
      next = {
        ...next,
        subscription: subscription.id,
        invoice: invoice.id,
        payment_status:
          invoice.status !== "paid"
            ? "unpaid"
            : invoice.amount_due === 0
              ? "no_payment_required"
              : "paid",
      }
    } else {
      const attached = attachPaymentMethod(
        scope,
        method as PaymentMethodRecord,
        customerId as string,
      )
      const id = scope.ids.next("seti_", 24)
      const setup: SetupIntentRecord = {
        id,
        cancellation_reason: null,
        canceled_at: null,
        client_secret: clientSecretFor(id),
        created: seconds(scope.now),
        customer: customerId,
        description: null,
        last_setup_error: null,
        metadata: session.metadata,
        payment_method: attached.id,
        payment_method_types: ["card"],
        status: "succeeded",
        usage: "off_session",
      }
      scope.account.setupIntents.insert(id, setup)
      scope.emit("setup_intent.created", renderSetupIntent(setup))
      scope.emit("setup_intent.succeeded", renderSetupIntent(setup))
      next = { ...next, setup_intent: id, payment_status: "no_payment_required" }
    }
  } catch (error) {
    if (error instanceof StripeError && error.init.type === "card_error") {
      scope.account.checkoutSessions.update(session.id, {
        ...next,
        status: "open",
        customer_details: session.customer_details ?? null,
      })
      return { ok: false, message: error.init.message, code: error.init.code ?? "card_declined" }
    }
    throw error
  }
  if (session.mode !== "subscription")
    for (const ref of session.discount_refs ?? [])
      if (ref.coupon !== null) redeem(scope, ref.coupon, ref.promotion_code)
  const completed: CheckoutSessionRecord = { ...next, status: "complete" }
  scope.account.checkoutSessions.update(session.id, completed)
  if (customerId !== null && findCustomer(scope, customerId) === undefined)
    throw stateError("customer vanished during checkout")
  scope.emit("checkout.session.completed", renderCheckoutSession(completed))
  return { ok: true, session: completed }
}
