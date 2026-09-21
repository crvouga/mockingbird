import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { requestInfo } from "./context.js"
import { cardError, invalidRequest, parameterMissing } from "./errors.js"
import {
  booleanOf,
  clientSecretFor,
  mergeRecordMetadata,
  type RequestScope,
  recordOf,
  requestScope,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { paymentMethodFromParams } from "./payment-intents.js"
import { attachPaymentMethod } from "./payments.js"
import { renderPaymentMethod, renderSetupIntent } from "./render.js"
import { type PaymentMethodRecord, type SetupIntentRecord, seconds } from "./state.js"
import { chargeOutcomeFor } from "./test-tokens.js"

const requireSetupIntent = (scope: RequestScope, id: string) => {
  const intent = scope.account.setupIntents.get(id)
  if (!intent) throw invalidRequest(`No such setup_intent: '${id}'`, "intent", "resource_missing")
  return intent
}

/**
 * Confirm a SetupIntent with a card: a card that declines fails the setup (402, `setup_failed`);
 * a 3-D Secure card waits in `requires_action` unless the challenge is passed on the spot;
 * anything else succeeds and attaches the card to the intent's customer.
 */
export const confirmSetup = (
  scope: RequestScope,
  intent: SetupIntentRecord,
  method: PaymentMethodRecord,
  autoAuthenticate = false,
): SetupIntentRecord => {
  const outcome = chargeOutcomeFor(method.token)
  // A card that declines every charge still attaches (`tok_chargeCustomerFail`); insufficient
  // funds only shows up when money moves. Generic declines and expired cards fail the setup.
  const setupFails =
    outcome.kind === "card_error" &&
    method.token !== "tok_chargeCustomerFail" &&
    (outcome.decline_code === "generic_decline" || outcome.decline_code === "expired_card")
  if (setupFails) {
    const decline = outcome
    const rendered = renderPaymentMethod(method)
    const failed: SetupIntentRecord = {
      ...intent,
      payment_method: null,
      status: "requires_payment_method",
      last_setup_error: {
        code: decline.code,
        decline_code: decline.decline_code,
        doc_url: `https://stripe.com/docs/error-codes/${decline.code.replace(/_/g, "-")}`,
        message: decline.message,
        payment_method: rendered,
        payment_method_type: "card",
        type: "card_error",
      },
    }
    scope.account.setupIntents.update(intent.id, failed)
    const renderedIntent = renderSetupIntent(failed)
    scope.emit("setup_intent.setup_failed", renderedIntent)
    throw cardError(decline.message, decline.code, decline.decline_code, {
      payment_method: rendered,
      setup_intent: renderedIntent,
    })
  }
  if (outcome.kind === "authenticate" && !autoAuthenticate) {
    const waiting: SetupIntentRecord = {
      ...intent,
      payment_method: method.id,
      status: "requires_action",
      next_action: {
        type: "use_stripe_sdk",
        use_stripe_sdk: {
          type: "three_d_secure_redirect",
          stripe_js: `${scope.base}/c/3ds/${intent.id}/authenticate`,
          source: method.id,
        },
      },
    }
    scope.account.setupIntents.update(intent.id, waiting)
    scope.emit("setup_intent.requires_action", renderSetupIntent(waiting))
    return waiting
  }
  const attached =
    intent.customer !== null && method.customer === null
      ? attachPaymentMethod(scope, method, intent.customer)
      : method
  const succeeded: SetupIntentRecord = {
    ...intent,
    last_setup_error: null,
    next_action: null,
    payment_method: attached.id,
    status: "succeeded",
  }
  scope.account.setupIntents.update(intent.id, succeeded)
  scope.emit("setup_intent.succeeded", renderSetupIntent(succeeded))
  return succeeded
}

const assertClientSecret = (
  context: Parameters<OperationHandler>[0],
  params: Params,
  intent: SetupIntentRecord,
) => {
  if (!requestInfo(context.request).publishable) return
  const secret = params.client_secret
  if (typeof secret !== "string" || secret === "") throw parameterMissing("client_secret")
  if (secret !== intent.client_secret)
    throw invalidRequest(
      "The client_secret provided does not match any associated SetupIntent on this account.",
      "client_secret",
    )
}

export const setupIntentHandlers = (services: Services): Record<string, OperationHandler> => ({
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
        render: renderSetupIntent,
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
    const method = paymentMethodFromParams(scope, params)
    const automatic = recordOf(params.automatic_payment_methods)
    const id = scope.ids.next("seti_", 24)
    const record: SetupIntentRecord = {
      id,
      client_secret: clientSecretFor(id),
      created: seconds(scope.now),
      customer,
      description: stringOf(params, "description"),
      metadata: (params.metadata as Record<string, string> | undefined) ?? {},
      payment_method: method?.id ?? null,
      payment_method_types: ["card"],
      status: method === null ? "requires_payment_method" : "requires_confirmation",
      usage: stringOf(params, "usage") ?? "off_session",
      last_setup_error: null,
      cancellation_reason: null,
      canceled_at: null,
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
    scope.account.setupIntents.insert(id, record)
    scope.emit("setup_intent.created", renderSetupIntent(record))
    if (booleanOf(params.confirm) === true && method !== null)
      return jsonResponse(200, renderSetupIntent(confirmSetup(scope, record, method)))
    return jsonResponse(200, renderSetupIntent(record))
  },
  GetSetupIntentsIntent: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const intent = requireSetupIntent(scope, context.params.intent ?? "")
    assertClientSecret(context, params, intent)
    return jsonResponse(200, renderSetupIntent(intent))
  },
  PostSetupIntentsIntent: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireSetupIntent(scope, context.params.intent ?? "")
    const method = paymentMethodFromParams(scope, params)
    const next: SetupIntentRecord = {
      ...current,
      customer: stringOf(params, "customer") ?? current.customer,
      description: stringOf(params, "description") ?? current.description,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      payment_method: method?.id ?? current.payment_method,
    }
    scope.account.setupIntents.update(next.id, next)
    return jsonResponse(200, renderSetupIntent(next))
  },
  PostSetupIntentsIntentConfirm: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireSetupIntent(scope, context.params.intent ?? "")
    assertClientSecret(context, params, current)
    if (current.status === "canceled" || current.status === "succeeded")
      throw invalidRequest(
        `You cannot confirm this SetupIntent because it has a status of ${current.status}.`,
        undefined,
        "setup_intent_unexpected_state",
      )
    const method =
      paymentMethodFromParams(scope, params) ??
      (current.payment_method === null
        ? null
        : (scope.account.paymentMethods.get(current.payment_method) ?? null))
    if (method === null)
      throw invalidRequest(
        "You cannot confirm this SetupIntent because it's missing a payment method. You can either update the SetupIntent with a payment method and then confirm it again, or confirm it again directly with a payment method.",
        undefined,
        "setup_intent_unexpected_state",
      )
    return jsonResponse(200, renderSetupIntent(confirmSetup(scope, current, method)))
  },
  PostSetupIntentsIntentCancel: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireSetupIntent(scope, context.params.intent ?? "")
    if (current.status === "succeeded" || current.status === "canceled")
      throw invalidRequest(
        `You cannot cancel this SetupIntent because it has a status of ${current.status}.`,
        undefined,
        "setup_intent_unexpected_state",
      )
    const next: SetupIntentRecord = {
      ...current,
      canceled_at: seconds(scope.now),
      cancellation_reason: stringOf(params, "cancellation_reason"),
      next_action: null,
      status: "canceled",
    }
    scope.account.setupIntents.update(next.id, next)
    scope.emit("setup_intent.canceled", renderSetupIntent(next))
    return jsonResponse(200, renderSetupIntent(next))
  },
})
