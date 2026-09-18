import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  clientSecretFor,
  completeSessionsForIntent,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  resolvePaymentMethod,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderCustomer, renderPaymentMethod, renderSetupIntent } from "./render.js"
import { type SetupIntentRecord, seconds } from "./state.js"

const expanders = (scope: RequestScope): ExpandResolvers => ({
  payment_method: (id) => {
    const method = scope.account.paymentMethods.get(id)
    return method ? renderPaymentMethod(method) : undefined
  },
  customer: (id) => {
    const entry = scope.account.customers.get(id)
    return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
  },
})

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

export const setupIntentHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, record: SetupIntentRecord, params: Params) =>
    applyExpand(renderSetupIntent(record), params.expand, expanders(scope))

  const requireSetupIntent = (scope: RequestScope, id: string) => {
    const intent = scope.account.setupIntents.get(id)
    if (!intent) throw invalidRequest(`No such setup_intent: '${id}'`, "intent", "resource_missing")
    return intent
  }

  return {
    GetSetupIntents: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      return jsonResponse(
        200,
        await paginate<SetupIntentRecord>(scope.account.setupIntents, params, {
          url: "/v1/setup_intents",
          kind: "setup_intent",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (customer === null || record.customer === customer),
          render: (record) => render(scope, record, params),
        }),
      )
    },
    PostSetupIntents: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const customer = stringOf(params, "customer")
      if (customer !== null) {
        const entry = scope.account.customers.get(customer)
        if (!entry || entry.kind === "deleted")
          throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
      }
      const requestedMethod = stringOf(params, "payment_method")
      const id = scope.ids.next("seti_")
      const record: SetupIntentRecord = {
        id,
        client_secret: clientSecretFor(id),
        created: seconds(scope.now),
        customer,
        description: stringOf(params, "description"),
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        payment_method:
          requestedMethod === null ? null : resolvePaymentMethod(scope, requestedMethod).id,
        payment_method_types: ["card"],
        status: "requires_payment_method",
        usage: stringOf(params, "usage") ?? "off_session",
        last_setup_error: null,
        cancellation_reason: null,
        canceled_at: null,
      }
      scope.account.setupIntents.insert(id, record)
      return jsonResponse(200, render(scope, record, params))
    },
    GetSetupIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(scope, requireSetupIntent(scope, context.params.intent ?? ""), params),
      )
    },
    PostSetupIntentsIntent: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSetupIntent(scope, context.params.intent ?? "")
      const requestedMethod = stringOf(params, "payment_method")
      const next: SetupIntentRecord = {
        ...current,
        customer: stringOf(params, "customer") ?? current.customer,
        description: stringOf(params, "description") ?? current.description,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        payment_method:
          requestedMethod === null
            ? current.payment_method
            : resolvePaymentMethod(scope, requestedMethod).id,
      }
      scope.account.setupIntents.update(next.id, next)
      return jsonResponse(200, render(scope, next, params))
    },
    PostSetupIntentsIntentConfirm: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSetupIntent(scope, context.params.intent ?? "")
      if (current.status === "canceled")
        throw invalidRequest(
          "The SetupIntent has a status of canceled, so it cannot be confirmed.",
          undefined,
          "setup_intent_unexpected_state",
        )
      const requestedMethod = stringOf(params, "payment_method")
      const next: SetupIntentRecord = {
        ...current,
        payment_method:
          requestedMethod === null
            ? current.payment_method
            : resolvePaymentMethod(scope, requestedMethod).id,
        status: "succeeded",
      }
      scope.account.setupIntents.update(next.id, next)
      scope.emit("setup_intent.succeeded", renderSetupIntent(next))
      completeSessionsForIntent(scope, { setupIntent: next.id })
      return jsonResponse(200, render(scope, next, params))
    },
    PostSetupIntentsIntentCancel: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSetupIntent(scope, context.params.intent ?? "")
      const next: SetupIntentRecord = {
        ...current,
        canceled_at: seconds(scope.now),
        cancellation_reason: stringOf(params, "cancellation_reason"),
        status: "canceled",
      }
      scope.account.setupIntents.update(next.id, next)
      return jsonResponse(200, render(scope, next, params))
    },
  }
}
