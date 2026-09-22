import { afterIntentSucceeded, createSubscription, newIntentRecord, redeem } from "./billing.js"
import { StripeError, stateError } from "./errors.js"
import { clientSecretFor, findCustomer, type RequestScope } from "./internal.js"
import { attachPaymentMethod, confirmIntent, paymentMethodFromCard } from "./payments.js"
import { renderCheckoutSession, renderCustomer, renderSetupIntent } from "./render.js"
import {
  type CheckoutSessionRecord,
  type CustomerRecord,
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

/**
 * Complete an open Checkout Session with a card, as the hosted page's Pay button (or
 * `POST /__admin/checkout/sessions/:id/complete`) does: create the customer when the session
 * asks for one, then the PaymentIntent (with `payment_intent_data.metadata`), the Subscription
 * (with `subscription_data.metadata`) or the SetupIntent; on success flip the session to
 * `complete` and emit `checkout.session.completed` last, after the objects it references.
 */
export const completeSession = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  cardNumber: string,
): CompletionResult => {
  if (session.status !== "open")
    throw stateError(
      `This Checkout Session is no longer active (status: ${session.status}).`,
      "checkout_session_not_open",
    )
  const method = paymentMethodFromCard(scope, cardNumber)
  const needsCustomer =
    session.customer === null &&
    (session.customer_creation === "always" ||
      session.mode !== "payment" ||
      (session.payment_intent_data?.setup_future_usage !== null &&
        session.payment_intent_data?.setup_future_usage !== undefined))
  const customerId = needsCustomer ? newCustomer(scope).id : session.customer
  let next: CheckoutSessionRecord = { ...session, customer: customerId }
  try {
    if (session.mode === "payment") {
      if (session.amount_total === 0) {
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
        })
        next = { ...next, payment_intent: intent.id }
        scope.account.checkoutSessions.update(session.id, next)
        const settled = confirmIntent(scope, intent, method, {
          offSession: false,
          autoAuthenticate: true,
        })
        afterIntentSucceeded(scope, settled)
        next = { ...next, payment_status: "paid" }
      }
    } else if (session.mode === "subscription") {
      const lines = session.line_items.filter((line) => line.price !== null)
      const attached = attachPaymentMethod(scope, method, customerId as string)
      const outcome = chargeOutcomeFor(attached.token)
      if (outcome.kind === "card_error")
        return { ok: false, message: outcome.message, code: outcome.code }
      const { subscription, invoice } = createSubscription(scope, {
        customer: customerId as string,
        items: lines.map((line) => ({ price: line.price as string, quantity: line.quantity ?? 1 })),
        metadata: session.subscription_data?.metadata ?? {},
        defaultPaymentMethod: attached.id,
        paymentBehavior: "error_if_incomplete",
        trialEnd: session.subscription_data?.trial_end ?? null,
        discounts: (session.discount_refs ?? []).map((ref) =>
          ref.promotion_code !== null
            ? { promotion_code: ref.promotion_code }
            : { coupon: ref.coupon ?? "" },
        ),
        firstPaymentMethod: attached,
      })
      next = {
        ...next,
        subscription: subscription.id,
        invoice: invoice.id,
        payment_status: invoice.amount_due === 0 ? "no_payment_required" : "paid",
      }
    } else {
      const attached = attachPaymentMethod(scope, method, customerId as string)
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
      scope.account.checkoutSessions.update(session.id, { ...next, status: "open" })
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
