import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { previousAttributes } from "./disputes.js"
import { invalidRequest } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireCharge,
  requireLiveCustomer,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
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

/** `POST /v1/charges/:id` parameters the mock refuses rather than silently ignore. */
const UNMODELLED_UPDATES: Readonly<Record<string, string>> = {
  fraud_details: "Radar fraud reports (`fraud_details`) are not modelled by this mock.",
  shipping: "Charge `shipping` is not modelled by this mock.",
  transfer_group: "Connect transfer groups (`transfer_group`) are not modelled by this mock.",
}

/**
 * Update a charge: `description`, `metadata` (merged), `receipt_email`, and `customer` (only on
 * a charge without one). Emits `charge.updated` with what changed.
 */
const updateCharge = (scope: RequestScope, current: ChargeRecord, params: Params) => {
  for (const [param, message] of Object.entries(UNMODELLED_UPDATES))
    if (params[param] !== undefined) throw invalidRequest(message, param)
  const next: ChargeRecord = {
    ...current,
    metadata: mergeRecordMetadata(current.metadata, params.metadata),
  }
  if (typeof params.description === "string")
    next.description = params.description === "" ? null : params.description
  if (typeof params.receipt_email === "string")
    next.receipt_email = params.receipt_email === "" ? null : params.receipt_email
  const customer = stringOf(params, "customer")
  if (customer !== null) {
    requireLiveCustomer(scope, customer, "customer")
    if (current.customer !== null && current.customer !== customer)
      throw invalidRequest(
        "This charge already has a customer; `customer` can only be set on a charge without one.",
        "customer",
      )
    next.customer = customer
  }
  scope.account.charges.update(current.id, next)
  const previous = previousAttributes(renderCharge(current), renderCharge(next))
  if (Object.keys(previous).length > 0) scope.emit("charge.updated", renderCharge(next), previous)
  return next
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
  PostChargesCharge: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const charge = requireCharge(scope, context.params.charge ?? "", "id")
    return jsonResponse(200, render(scope, updateCharge(scope, charge, params), params.expand))
  },
})
