import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import { type RequestScope, requestScope, requireCharge, type Services } from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { type Params, queryParams } from "./params.js"
import {
  renderCharge,
  renderCoupon,
  renderCustomer,
  renderInvoice,
  renderPaymentIntent,
  renderPaymentMethod,
} from "./render.js"
import type { ChargeRecord } from "./state.js"

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const expanders = (scope: RequestScope): ExpandResolvers => {
  const invoice = (id: string) => {
    const record = scope.account.invoices.get(id)
    return record ? renderInvoice(record, scope.account) : undefined
  }
  const coupon = (id: string) => {
    const record = scope.account.coupons.get(id)
    return record ? renderCoupon(record) : undefined
  }
  const paymentIntent = (id: string) => {
    const record = scope.account.paymentIntents.get(id)
    return record ? renderPaymentIntent(record) : undefined
  }
  const customer = (id: string) => {
    const entry = scope.account.customers.get(id)
    return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
  }
  const paymentMethod = (id: string) => {
    const record = scope.account.paymentMethods.get(id)
    return record ? renderPaymentMethod(record) : undefined
  }
  return {
    invoice,
    "invoice.discounts.coupon": coupon,
    payment_intent: paymentIntent,
    "payment_intent.invoice": invoice,
    customer,
    payment_method: paymentMethod,
    "data.invoice": invoice,
    "data.invoice.discounts.coupon": coupon,
    "data.payment_intent": paymentIntent,
    "data.payment_intent.invoice": invoice,
    "data.customer": customer,
  }
}

/**
 * Stripe expands a path's ancestors along with it, and `invoice.discounts.coupon` only walks into
 * an invoice once the shallower `invoice` pass has replaced the id with the rendered object, so
 * every prefix is added and the list is applied shallowest first.
 */
const orderedPaths = (expand: unknown): string[] => {
  const requested = Array.isArray(expand)
    ? expand.filter((entry): entry is string => typeof entry === "string")
    : typeof expand === "string" && expand !== ""
      ? [expand]
      : []
  const paths = new Set<string>()
  for (const path of requested) {
    const parts = path.split(".")
    for (let depth = 1; depth <= parts.length; depth += 1)
      paths.add(parts.slice(0, depth).join("."))
  }
  return [...paths].sort((a, b) => a.split(".").length - b.split(".").length)
}

const render = (scope: RequestScope, charge: ChargeRecord, expand: unknown) =>
  applyExpand(renderCharge(charge), orderedPaths(expand), expanders(scope))

export const chargeHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetCharges: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const customer = stringOf(params, "customer")
    const paymentIntent = stringOf(params, "payment_intent")
    const page = await paginate<ChargeRecord>(scope.account.charges, params, {
      url: "/v1/charges",
      kind: "charge",
      where: (record) =>
        matchesCreated(record.created, params.created) &&
        (customer === null || record.customer === customer) &&
        (paymentIntent === null || record.payment_intent === paymentIntent),
      render: renderCharge,
    })
    return jsonResponse(200, applyExpand(page, orderedPaths(params.expand), expanders(scope)))
  },
  GetChargesCharge: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const charge = requireCharge(scope, context.params.charge ?? "", "id")
    return jsonResponse(200, render(scope, charge, params.expand))
  },
})
