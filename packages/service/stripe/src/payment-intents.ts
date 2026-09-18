import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  clientSecretFor,
  completeSessionsForIntent,
  confirmPaymentIntent,
  customerEmail,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireIntent,
  requireLiveCustomer,
  resolvePaymentMethod,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderCharge,
  renderCustomer,
  renderInvoice,
  renderPaymentIntent,
  renderPaymentMethod,
} from "./render.js"
import { searchRecords } from "./search.js"
import { type PaymentIntentRecord, seconds } from "./state.js"

const DEFAULT_PAYMENT_METHOD_TYPES = ["card", "link"]

const expanders = (scope: RequestScope): ExpandResolvers => ({
  latest_charge: (id) => {
    const charge = scope.account.charges.get(id)
    return charge ? renderCharge(charge) : undefined
  },
  payment_method: (id) => {
    const method = scope.account.paymentMethods.get(id)
    return method ? renderPaymentMethod(method) : undefined
  },
  invoice: (id) => {
    const invoice = scope.account.invoices.get(id)
    return invoice ? renderInvoice(invoice, scope.account) : undefined
  },
  customer: (id) => {
    const entry = scope.account.customers.get(id)
    return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
  },
})

const amountOf = (params: Params, key: string): number | undefined => {
  const value = params[key]
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const booleanOf = (params: Params, key: string): boolean =>
  params[key] === true || params[key] === "true"

const stringListOf = (params: Params, key: string): string[] => {
  const value = params[key]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  if (typeof value === "string" && value !== "") return value.split(",")
  return DEFAULT_PAYMENT_METHOD_TYPES
}

export const paymentIntentHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, record: PaymentIntentRecord, params: Params) =>
    applyExpand(renderPaymentIntent(record), params.expand, expanders(scope))

  /**
   * Confirm and, when the intent succeeds, emit `payment_intent.succeeded` (and complete any
   * checkout session waiting on it). A declined card records `payment_intent.payment_failed`
   * before the 402 travels back to the caller.
   */
  const confirmOrDecline = (
    scope: RequestScope,
    record: PaymentIntentRecord,
    paymentMethod: string | null,
  ): PaymentIntentRecord => {
    try {
      const confirmed = confirmPaymentIntent(scope, record, paymentMethod)
      if (confirmed.status === "succeeded") {
        scope.emit("payment_intent.succeeded", renderPaymentIntent(confirmed))
        completeSessionsForIntent(scope, { paymentIntent: confirmed.id })
      }
      return confirmed
    } catch (error) {
      const failed = scope.account.paymentIntents.get(record.id) ?? record
      scope.emit("payment_intent.payment_failed", renderPaymentIntent(failed))
      throw error
    }
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
        render: (record) => render(scope, record, params),
      })
      return jsonResponse(200, page)
    },
    PostPaymentIntents: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const amount = amountOf(params, "amount")
      if (amount === undefined) throw parameterMissing("amount")
      const currency = stringOf(params, "currency")
      if (currency === null) throw parameterMissing("currency")
      const customer = stringOf(params, "customer")
      if (customer !== null) requireLiveCustomer(scope, customer)
      const requestedMethod = stringOf(params, "payment_method")
      const paymentMethod =
        requestedMethod === null ? null : resolvePaymentMethod(scope, requestedMethod).id
      const id = scope.ids.next("pi_")
      const record: PaymentIntentRecord = {
        id,
        amount,
        amount_capturable: 0,
        amount_received: 0,
        capture_method: stringOf(params, "capture_method") === "manual" ? "manual" : "automatic",
        client_secret: clientSecretFor(id),
        confirmation_method: "automatic",
        created: seconds(scope.now),
        currency,
        customer,
        description: stringOf(params, "description"),
        invoice: null,
        last_payment_error: null,
        latest_charge: null,
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        payment_method: paymentMethod,
        payment_method_types: stringListOf(params, "payment_method_types"),
        receipt_email: stringOf(params, "receipt_email") ?? customerEmail(scope, customer),
        setup_future_usage: stringOf(params, "setup_future_usage"),
        status: "requires_payment_method",
        canceled_at: null,
        cancellation_reason: null,
        charge_ids: [],
      }
      scope.account.paymentIntents.insert(id, record)
      if (booleanOf(params, "confirm")) {
        return jsonResponse(
          200,
          render(scope, confirmOrDecline(scope, record, paymentMethod), params),
        )
      }
      return jsonResponse(200, render(scope, record, params))
    },
    GetPaymentIntentsSearch: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const records = scope.account.paymentIntents.list({ order: "newest" }).map((e) => e.value)
      return jsonResponse(
        200,
        searchRecords(records, params, {
          url: "/v1/payment_intents/search",
          render: (record) => render(scope, record, params),
        }),
      )
    },
    GetPaymentIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(scope, requireIntent(scope, context.params.intent ?? ""), params),
      )
    },
    PostPaymentIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      const amount = amountOf(params, "amount")
      const customer = stringOf(params, "customer")
      if (customer !== null) requireLiveCustomer(scope, customer)
      const requestedMethod = stringOf(params, "payment_method")
      const next: PaymentIntentRecord = {
        ...current,
        amount: amount ?? current.amount,
        customer: customer ?? current.customer,
        description: stringOf(params, "description") ?? current.description,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        payment_method:
          requestedMethod === null
            ? current.payment_method
            : resolvePaymentMethod(scope, requestedMethod).id,
        receipt_email: stringOf(params, "receipt_email") ?? current.receipt_email,
        setup_future_usage: stringOf(params, "setup_future_usage") ?? current.setup_future_usage,
      }
      scope.account.paymentIntents.update(next.id, next)
      return jsonResponse(200, render(scope, next, params))
    },
    PostPaymentIntentsIntentConfirm: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      if (current.status === "canceled")
        throw invalidRequest(
          "The PaymentIntent has a status of canceled, so it cannot be confirmed.",
          undefined,
          "payment_intent_unexpected_state",
        )
      if (current.status === "succeeded")
        throw invalidRequest(
          "This PaymentIntent is already succeeded and cannot be confirmed again.",
          undefined,
          "payment_intent_unexpected_state",
        )
      const requestedMethod = stringOf(params, "payment_method")
      const method =
        requestedMethod === null
          ? current.payment_method
          : resolvePaymentMethod(scope, requestedMethod).id
      if (method === null)
        throw invalidRequest(
          "You cannot confirm this PaymentIntent because it has no payment method attached to it.",
          "payment_method",
        )
      return jsonResponse(200, render(scope, confirmOrDecline(scope, current, method), params))
    },
    PostPaymentIntentsIntentCancel: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireIntent(scope, context.params.intent ?? "")
      if (current.status === "succeeded")
        throw invalidRequest(
          "The PaymentIntent has a status of succeeded, so it cannot be canceled.",
          undefined,
          "payment_intent_unexpected_state",
        )
      const next: PaymentIntentRecord = {
        ...current,
        amount_capturable: 0,
        canceled_at: seconds(scope.now),
        cancellation_reason: stringOf(params, "cancellation_reason"),
        status: "canceled",
      }
      scope.account.paymentIntents.update(next.id, next)
      scope.emit("payment_intent.canceled", renderPaymentIntent(next))
      return jsonResponse(200, render(scope, next, params))
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
      const capturedAmount = amountOf(params, "amount_to_capture") ?? current.amount
      if (current.latest_charge !== null) {
        const charge = scope.account.charges.get(current.latest_charge)
        if (charge) {
          scope.account.charges.update(charge.id, {
            ...charge,
            amount_captured: capturedAmount,
            captured: true,
          })
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
      completeSessionsForIntent(scope, { paymentIntent: next.id })
      return jsonResponse(200, render(scope, next, params))
    },
  }
}
