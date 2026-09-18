import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  mergeRecordMetadata,
  paymentMethodFromToken,
  type RequestScope,
  requestScope,
  requireLiveCustomer,
  requireParam,
  resolvePaymentMethod,
  type Services,
} from "./internal.js"
import { paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderCustomer, renderPaymentMethod } from "./render.js"
import type { PaymentMethodRecord } from "./state.js"

type RecordValue = Record<string, unknown>

const recordOf = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const expanders = (scope: RequestScope): ExpandResolvers => {
  const customer = (id: string) => {
    const entry = scope.account.customers.get(id)
    return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
  }
  return { customer, "data.customer": customer }
}

const render = (scope: RequestScope, method: PaymentMethodRecord, expand: unknown) =>
  applyExpand(renderPaymentMethod(method), expand, expanders(scope))

export const paymentMethodHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetPaymentMethods: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const customer = stringOf(params, "customer")
    const type = stringOf(params, "type")
    const page = await paginate<PaymentMethodRecord>(scope.account.paymentMethods, params, {
      url: "/v1/payment_methods",
      kind: "payment_method",
      where: (record) =>
        (customer === null || record.customer === customer) &&
        (type === null || record.type === type),
      render: renderPaymentMethod,
    })
    return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
  },
  PostPaymentMethods: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    if (params.type !== "card") throw parameterMissing("type")
    const card = recordOf(params.card)
    const token =
      card === undefined || typeof card.token !== "string" || card.token === "" ? null : card.token
    if (token === null) throw parameterMissing("card[token]")
    const { record } = paymentMethodFromToken(scope, token)
    const method: PaymentMethodRecord = {
      ...record,
      billing_details: recordOf(params.billing_details) ?? {},
      metadata: mergeRecordMetadata({}, params.metadata),
    }
    scope.account.paymentMethods.update(method.id, method)
    return jsonResponse(200, render(scope, method, params.expand))
  },
  GetPaymentMethodsPaymentMethod: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const method = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    return jsonResponse(200, render(scope, method, params.expand))
  },
  PostPaymentMethodsPaymentMethod: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    const method: PaymentMethodRecord = {
      ...current,
      billing_details: recordOf(params.billing_details) ?? current.billing_details,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
    }
    scope.account.paymentMethods.update(method.id, method)
    return jsonResponse(200, render(scope, method, params.expand))
  },
  PostPaymentMethodsPaymentMethodAttach: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    const customer = requireParam(params, "customer")
    requireLiveCustomer(scope, customer)
    if (current.customer !== null && current.customer !== customer)
      throw invalidRequest(
        `The payment method ${current.id} is already attached to a customer.`,
        "payment_method",
      )
    const method: PaymentMethodRecord = {
      ...current,
      customer,
      billing_details: recordOf(params.billing_details) ?? current.billing_details,
    }
    scope.account.paymentMethods.update(method.id, method)
    return jsonResponse(200, render(scope, method, params.expand))
  },
  PostPaymentMethodsPaymentMethodDetach: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = resolvePaymentMethod(scope, context.params.payment_method ?? "")
    const method: PaymentMethodRecord = { ...current, customer: null }
    scope.account.paymentMethods.update(method.id, method)
    return jsonResponse(200, render(scope, method, params.expand))
  },
})
