import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { createConfirmationTokenForElements, renderPaymentIntent } from "./payments.js"
import type { StripeState } from "./state.js"
import { seconds } from "./state.js"

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const intentIdFromSecret = (secret: string) => {
  const match = /^(pi_|seti_)[A-Za-z0-9]+(?=_secret_)/.exec(secret)
  return match ? secret.slice(0, secret.indexOf("_secret_")) : undefined
}

/**
 * The session document Stripe.js fetches before mounting the Payment Element, Address Element,
 * or Express Checkout Element. Field names follow the payload current Stripe.js reads.
 */
const sessionFor = async (state: StripeState, query: Record<string, unknown>, now: number) => {
  const secret = typeof query.client_secret === "string" ? query.client_secret : undefined
  const deferred = asRecord(query.deferred_intent)
  const type =
    typeof query.type === "string"
      ? query.type
      : secret?.startsWith("seti_")
        ? "setup_intent"
        : "payment_intent"
  let paymentIntent: Record<string, unknown> | null = null
  let setupIntent: Record<string, unknown> | null = null
  let currency = typeof deferred?.currency === "string" ? deferred.currency : "usd"
  let amount = typeof deferred?.amount === "number" ? deferred.amount : null
  let mode = type === "setup_intent" || deferred?.mode === "setup" ? "setup" : "payment"
  if (secret) {
    const id = intentIdFromSecret(secret)
    if (!id) throw invalidRequest("Invalid client_secret.", "client_secret")
    if (id.startsWith("seti_")) {
      const intent = await state.setupIntents.get(id)
      if (!intent || intent.client_secret !== secret)
        throw resourceMissing("setup_intent", id, "client_secret", 400)
      setupIntent = {
        id: intent.id,
        object: "setup_intent",
        client_secret: intent.client_secret,
        status: intent.status,
        payment_method_types: intent.payment_method_types,
      }
      mode = "setup"
    } else {
      const intent = await state.paymentIntents.get(id)
      if (!intent || intent.client_secret !== secret)
        throw resourceMissing("payment_intent", id, "client_secret", 400)
      paymentIntent = await renderPaymentIntent(state, intent)
      currency = intent.currency
      amount = intent.amount
      mode = "payment"
    }
  }
  const id = `elements_session_${opaqueToken(`es:${secret ?? "deferred"}:${now}`, 16)}`
  return {
    id,
    object: "elements_session",
    account_id: "acct_mockingbird",
    business_name: "Mockingbird",
    card_brand_choice: { eligible: false },
    client_secret: secret ?? null,
    currency,
    customer: null,
    experiments_data: { event_id: id, experiment_assignments: {} },
    google_pay_preference: "enabled",
    apple_pay_preference: "enabled",
    link_settings: { link_mode: "LINK_CARD_BRAND", link_consumer_incentive: null },
    livemode: false,
    locale: typeof query.locale === "string" ? query.locale : "en-US",
    merchant_country: "US",
    merchant_currency: currency,
    mode,
    ordered_payment_method_types: ["card"],
    payment_method_preference: { ordered_payment_method_types: ["card"], type },
    payment_method_specs: [{ type: "card", async: false }],
    payment_method_types: ["card"],
    payment_intent: paymentIntent,
    setup_intent: setupIntent,
    session_id: id,
    flags: {},
    deferred_intent: deferred
      ? { mode, amount, currency, setup_future_usage: null, capture_method: "automatic" }
      : null,
  }
}

export const elementHandlers = (state: StripeState) => ({
  GetElementsSessions: async (context: OperationContext) => {
    return jsonResponse(200, await sessionFor(state, context.query, seconds(context.now)))
  },

  PostElementsSessions: async (context: OperationContext) => {
    const body = context.body.kind === "form" ? context.body.value : {}
    const query = { ...context.query, ...(asRecord(body) ?? {}) }
    return jsonResponse(200, await sessionFor(state, query, seconds(context.now)))
  },

  PostConfirmationTokens: async (context: OperationContext) => {
    const params =
      context.body.kind === "form" && asRecord(context.body.value)
        ? (context.body.value as Record<string, unknown>)
        : {}
    const token = await createConfirmationTokenForElements(state, seconds(context.now), params)
    const method = token.payment_method
      ? await state.paymentMethods.get(token.payment_method)
      : undefined
    return jsonResponse(200, {
      id: token.id,
      object: "confirmation_token",
      created: token.created,
      expires_at: token.expires_at,
      livemode: false,
      payment_method_preview: method
        ? {
            type: method.type,
            card: method.card
              ? { brand: method.card.brand, last4: method.card.last4, funding: method.card.funding }
              : null,
            billing_details: method.billing_details,
          }
        : null,
      return_url: token.return_url,
      setup_future_usage: token.setup_future_usage,
      shipping: token.shipping,
      use_stripe_sdk: true,
    })
  },
})
