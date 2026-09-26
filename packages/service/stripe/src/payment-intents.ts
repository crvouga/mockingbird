import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { afterIntentSucceeded } from "./billing.js"
import { requestInfo } from "./context.js"
import { invalidRequest, parameterMissing } from "./errors.js"
import {
  booleanOf,
  clientSecretFor,
  customerEmail,
  intOf,
  mergeRecordMetadata,
  type RequestScope,
  recordOf,
  requestScope,
  requireIntent,
  requireLiveCustomer,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  confirmIntent,
  paymentMethodFromCard,
  paymentMethodFromToken,
  resolvePaymentMethod,
} from "./payments.js"
import { renderCharge, renderPaymentIntent } from "./render.js"
import { searchRecords } from "./search.js"
import { type PaymentIntentRecord, type PaymentMethodRecord, seconds } from "./state.js"

const DEFAULT_PAYMENT_METHOD_TYPES = ["card", "link"]

const CANCELABLE = [
  "requires_payment_method",
  "requires_capture",
  "requires_confirmation",
  "requires_action",
  "processing",
]

const stringListOf = (params: Params, key: string): string[] | undefined => {
  const value = params[key]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  if (typeof value === "string" && value !== "") return value.split(",")
  return undefined
}

/**
 * A publishable-key caller (the Stripe.js stand-in) must present the intent's client secret, and
 * may send raw card details as `payment_method_data` instead of a payment method id.
 */
const assertClientSecret = (
  context: Parameters<OperationHandler>[0],
  params: Params,
  intent: { id: string; client_secret: string },
) => {
  if (!requestInfo(context.request).publishable) return
  const secret = params.client_secret
  if (typeof secret !== "string" || secret === "") throw parameterMissing("client_secret")
  if (secret !== intent.client_secret)
    throw invalidRequest(
      `The client_secret provided does not match any associated PaymentIntent on this account. Ensure the publishable key used belongs to the same account that created the PaymentIntent.`,
      "client_secret",
    )
}

/** `payment_method` id, or `payment_method_data[type]=card` with a card number or token. */
export const paymentMethodFromParams = (
  scope: RequestScope,
  params: Params,
): PaymentMethodRecord | null => {
  const id = stringOf(params, "payment_method")
  if (id !== null) return resolvePaymentMethod(scope, id)
  const data = recordOf(params.payment_method_data)
  if (data === undefined) return null
  const card = recordOf(data.card)
  if (typeof card?.number === "string")
    return paymentMethodFromCard(scope, card.number, "payment_method_data[card][number]")
  if (typeof card?.token === "string") return paymentMethodFromToken(scope, card.token)
  return null
}

export const paymentIntentHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (record: PaymentIntentRecord) => renderPaymentIntent(record)

  /** Confirm, then settle the invoice the intent pays, if any. */
  const confirm = (
    scope: RequestScope,
    intent: PaymentIntentRecord,
    method: PaymentMethodRecord,
    offSession: boolean,
  ) => {
    const settled = confirmIntent(scope, intent, method, { offSession })
    afterIntentSucceeded(scope, settled)
    return scope.account.paymentIntents.get(settled.id) ?? settled
  }

  return {
    GetPaymentIntents: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const page = await paginate<PaymentIntentRecord>(scope.account.paymentIntents, params, {
        url: "/v1/payment_intents",
        kind: "payment_intent",
        where: (record) =>
          matchesCreated(record.created, params.created) &&
          (customer === null || record.customer === customer),
        render,
      })
      return jsonResponse(200, page)
    },
    PostPaymentIntents: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const amount = intOf(params.amount)
      if (amount === undefined) throw parameterMissing("amount")
      const currency = stringOf(params, "currency")
      if (currency === null) throw parameterMissing("currency")
      const customer = stringOf(params, "customer")
      if (customer !== null) requireLiveCustomer(scope, customer)
      const method = paymentMethodFromParams(scope, params)
      const automatic = recordOf(params.automatic_payment_methods)
      const id = scope.ids.next("pi_", 24)
      const record: PaymentIntentRecord = {
        id,
        amount,
        amount_capturable: 0,
        amount_received: 0,
        capture_method:
          stringOf(params, "capture_method") === "manual"
            ? "manual"
            : stringOf(params, "capture_method") === "automatic"
              ? "automatic"
              : "automatic_async",
        client_secret: clientSecretFor(id),
        confirmation_method:
          stringOf(params, "confirmation_method") === "manual" ? "manual" : "automatic",
        created: seconds(scope.now),
        currency,
        customer,
        description: stringOf(params, "description"),
        invoice: null,
        last_payment_error: null,
        latest_charge: null,
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        payment_method: method?.id ?? null,
        payment_method_types:
          stringListOf(params, "payment_method_types") ?? DEFAULT_PAYMENT_METHOD_TYPES,
        receipt_email: stringOf(params, "receipt_email") ?? customerEmail(scope, customer),
        setup_future_usage: stringOf(params, "setup_future_usage"),
        status: method === null ? "requires_payment_method" : "requires_confirmation",
        canceled_at: null,
        cancellation_reason: null,
        charge_ids: [],
        automatic_payment_methods:
          automatic === undefined
            ? null
            : {
                enabled: booleanOf(automatic.enabled) ?? false,
                allow_redirects:
                  typeof automatic.allow_redirects === "string"
                    ? automatic.allow_redirects
                    : "always",
              },
        next_action: null,
      }
      scope.account.paymentIntents.insert(id, record)
      scope.emit("payment_intent.created", renderPaymentIntent(record))
      if (booleanOf(params.confirm) === true) {
        if (method === null)
          throw invalidRequest(
            "You cannot confirm this PaymentIntent because it's missing a payment method. You can either update the PaymentIntent with a payment method and then confirm it again, or confirm it again directly with a payment method or ConfirmationToken.",
            undefined,
            "payment_intent_unexpected_state",
          )
        return jsonResponse(
          200,
          render(confirm(scope, record, method, booleanOf(params.off_session) === true)),
        )
      }
      return jsonResponse(200, render(record))
    },
    GetPaymentIntentsSearch: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const records = scope.account.paymentIntents.list({ order: "newest" }).map((e) => e.value)
      return jsonResponse(
        200,
        searchRecords(records, params, {
          url: "/v1/payment_intents/search",
          render,
          lag: scope.effect("search_lag"),
          now: scope.now,
        }),
      )
    },
    GetPaymentIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const intent = requireIntent(scope, context.params.intent ?? "")
      assertClientSecret(context, params, intent)
      return jsonResponse(200, render(intent))
    },
    PostPaymentIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      const amount = intOf(params.amount)
      const customer = stringOf(params, "customer")
      if (customer !== null) requireLiveCustomer(scope, customer)
      if (current.status === "succeeded" || current.status === "canceled") {
        const touchesMoney =
          amount !== undefined || customer !== null || params.payment_method !== undefined
        if (touchesMoney)
          throw invalidRequest(
            `You cannot update this PaymentIntent because it has a status of ${current.status}.`,
            undefined,
            "payment_intent_unexpected_state",
          )
      }
      const method = paymentMethodFromParams(scope, params)
      const next: PaymentIntentRecord = {
        ...current,
        amount: amount ?? current.amount,
        customer: customer ?? current.customer,
        description: stringOf(params, "description") ?? current.description,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        payment_method: method?.id ?? current.payment_method,
        receipt_email: stringOf(params, "receipt_email") ?? current.receipt_email,
        setup_future_usage: stringOf(params, "setup_future_usage") ?? current.setup_future_usage,
      }
      scope.account.paymentIntents.update(next.id, next)
      return jsonResponse(200, render(next))
    },
    PostPaymentIntentsIntentConfirm: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      assertClientSecret(context, params, current)
      if (current.status === "succeeded")
        throw invalidRequest(
          "You cannot confirm this PaymentIntent because it has already succeeded after being previously confirmed.",
          undefined,
          "payment_intent_unexpected_state",
        )
      if (current.status === "canceled")
        throw invalidRequest(
          "You cannot confirm this PaymentIntent because it has a status of canceled. Only a PaymentIntent with one of the following statuses may be confirmed: requires_confirmation, requires_payment_method, requires_action.",
          undefined,
          "payment_intent_unexpected_state",
        )
      const method =
        paymentMethodFromParams(scope, params) ??
        (current.payment_method === null
          ? null
          : resolvePaymentMethod(scope, current.payment_method))
      if (method === null)
        throw invalidRequest(
          "You cannot confirm this PaymentIntent because it's missing a payment method. You can either update the PaymentIntent with a payment method and then confirm it again, or confirm it again directly with a payment method or ConfirmationToken.",
          undefined,
          "payment_intent_unexpected_state",
        )
      const withFutureUsage =
        stringOf(params, "setup_future_usage") === null
          ? current
          : { ...current, setup_future_usage: stringOf(params, "setup_future_usage") }
      return jsonResponse(
        200,
        render(confirm(scope, withFutureUsage, method, booleanOf(params.off_session) === true)),
      )
    },
    PostPaymentIntentsIntentCancel: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      if (!CANCELABLE.includes(current.status))
        throw invalidRequest(
          `You cannot cancel this PaymentIntent because it has a status of ${current.status}. Only a PaymentIntent with one of the following statuses may be canceled: ${CANCELABLE.join(", ")}.`,
          undefined,
          "payment_intent_unexpected_state",
        )
      if (current.latest_charge !== null && current.status === "requires_capture") {
        const charge = scope.account.charges.get(current.latest_charge)
        if (charge)
          scope.account.charges.update(charge.id, {
            ...charge,
            amount_refunded: charge.amount,
            refunded: true,
          })
      }
      const next: PaymentIntentRecord = {
        ...current,
        amount_capturable: 0,
        canceled_at: seconds(scope.now),
        cancellation_reason: stringOf(params, "cancellation_reason"),
        next_action: null,
        status: "canceled",
      }
      scope.account.paymentIntents.update(next.id, next)
      scope.emit("payment_intent.canceled", renderPaymentIntent(next))
      return jsonResponse(200, render(next))
    },
    PostPaymentIntentsIntentCapture: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      if (current.status !== "requires_capture")
        throw invalidRequest(
          `This PaymentIntent could not be captured because it has a status of ${current.status}. Only a PaymentIntent with a status of requires_capture may be captured.`,
          undefined,
          "payment_intent_unexpected_state",
        )
      const capturedAmount = intOf(params.amount_to_capture) ?? current.amount
      if (current.latest_charge !== null) {
        const charge = scope.account.charges.get(current.latest_charge)
        if (charge) {
          const captured = { ...charge, amount_captured: capturedAmount, captured: true }
          scope.account.charges.update(charge.id, captured)
          scope.emit("charge.captured", renderCharge(captured))
        }
      }
      const next: PaymentIntentRecord = {
        ...current,
        amount_capturable: 0,
        amount_received: capturedAmount,
        status: "succeeded",
      }
      scope.account.paymentIntents.update(next.id, next)
      scope.emit("payment_intent.succeeded", renderPaymentIntent(next))
      return jsonResponse(200, render(next))
    },
  }
}
