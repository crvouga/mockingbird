import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { parameterMissing, stateError } from "./errors.js"
import {
  mergeRecordMetadata,
  recordOf,
  requestScope,
  requireParam,
  type Services,
  stringOf,
} from "./internal.js"
import { paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import {
  attachPaymentMethod,
  DETACH_UNATTACHED,
  newPaymentMethod,
  paymentMethodFromCard,
  paymentMethodFromToken,
  resolvePaymentMethod,
} from "./payments.js"
import { renderPaymentMethod } from "./render.js"
import type { PaymentMethodRecord } from "./state.js"

export const paymentMethodHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetPaymentMethods: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const customer = stringOf(params, "customer")
    const type = stringOf(params, "type")
    const page = await paginate<PaymentMethodRecord>(scope.account.paymentMethods, params, {
      url: "/v1/payment_methods",
      kind: "PaymentMethod",
      where: (record) =>
        (customer === null || record.customer === customer) &&
        (type === null || record.type === type),
      render: renderPaymentMethod,
    })
    return jsonResponse(200, page)
  },
  PostPaymentMethods: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    if (params.type !== "card") throw parameterMissing("type")
    const card = recordOf(params.card)
    const token =
      card !== undefined && typeof card.token === "string" && card.token !== "" ? card.token : null
    const number = card !== undefined && typeof card.number === "string" ? card.number : null
    const created =
      token !== null
        ? paymentMethodFromToken(scope, token)
        : number !== null
          ? paymentMethodFromCard(scope, number)
          : null
    if (created === null) throw parameterMissing("card[token]")
    const method: PaymentMethodRecord = {
      ...created,
      billing_details: { ...created.billing_details, ...recordOf(params.billing_details) },
      metadata: mergeRecordMetadata({}, params.metadata),
    }
    scope.account.paymentMethods.update(method.id, method)
    return jsonResponse(200, renderPaymentMethod(method))
  },
  GetPaymentMethodsPaymentMethod: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const method = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    return jsonResponse(200, renderPaymentMethod(method))
  },
  PostPaymentMethodsPaymentMethod: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    const method: PaymentMethodRecord = {
      ...current,
      billing_details: { ...current.billing_details, ...recordOf(params.billing_details) },
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
    }
    scope.account.paymentMethods.update(method.id, method)
    scope.emit("payment_method.updated", renderPaymentMethod(method))
    return jsonResponse(200, renderPaymentMethod(method))
  },
  PostPaymentMethodsPaymentMethodAttach: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    const customer = requireParam(params, "customer")
    return jsonResponse(200, renderPaymentMethod(attachPaymentMethod(scope, current, customer)))
  },
  PostPaymentMethodsPaymentMethodDetach: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    if (current.customer === null) throw stateError(DETACH_UNATTACHED)
    const customerId = current.customer
    const method: PaymentMethodRecord = { ...current, customer: null, consumed: true }
    scope.account.paymentMethods.update(method.id, method)
    const entry = scope.account.customers.get(customerId)
    if (
      entry?.kind === "live" &&
      entry.customer.invoice_settings.default_payment_method === method.id
    )
      scope.account.customers.update(customerId, {
        kind: "live",
        customer: {
          ...entry.customer,
          invoice_settings: { ...entry.customer.invoice_settings, default_payment_method: null },
        },
      })
    scope.emit("payment_method.detached", renderPaymentMethod(method), { customer: customerId })
    return jsonResponse(200, renderPaymentMethod(method))
  },
})

export { newPaymentMethod }
