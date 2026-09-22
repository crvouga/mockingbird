import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireCharge,
  requireIntent,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { recordBalanceTransaction } from "./payments.js"
import { renderCharge, renderPaymentIntent, renderRefund } from "./render.js"
import { type RefundRecord, type RefundStatus, seconds } from "./state.js"

const REFUND_STATUSES: readonly RefundStatus[] = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]

/**
 * Move a refund to another status (`PUT /__admin/refunds/:id`). A refund that fails or is
 * canceled gives the money back to the charge; `refund.failed` or `refund.updated` is emitted.
 */
export const moveRefund = (
  scope: RequestScope,
  current: RefundRecord,
  status: string,
  failureReason: string | null,
): RefundRecord => {
  if (!REFUND_STATUSES.includes(status as RefundStatus))
    throw invalidRequest(`Invalid status: must be one of ${REFUND_STATUSES.join(", ")}`, "status")
  const next: RefundRecord = {
    ...current,
    status: status as RefundStatus,
    failure_reason: status === "failed" ? (failureReason ?? "unknown") : null,
  }
  scope.account.refunds.update(current.id, next)
  const released = ["failed", "canceled"]
  if (released.includes(status) && !released.includes(current.status) && current.charge !== null) {
    const charge = scope.account.charges.get(current.charge)
    if (charge) {
      const amountRefunded = Math.max(0, charge.amount_refunded - current.amount)
      scope.account.charges.update(charge.id, {
        ...charge,
        amount_refunded: amountRefunded,
        refunded: amountRefunded >= charge.amount && amountRefunded > 0,
      })
    }
  }
  scope.emit(status === "failed" ? "refund.failed" : "refund.updated", renderRefund(next), {
    status: current.status,
    ...(status === "failed" ? { failure_reason: current.failure_reason ?? null } : {}),
  })
  return next
}

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const requireRefund = (scope: RequestScope, id: string): RefundRecord => {
  const refund = scope.account.refunds.get(id)
  if (!refund) throw resourceMissing("refund", id, "refund")
  return refund
}

const expanders = (scope: RequestScope): ExpandResolvers => {
  const charge = (id: string) => {
    const record = scope.account.charges.get(id)
    return record ? renderCharge(record) : undefined
  }
  const paymentIntent = (id: string) => {
    const record = scope.account.paymentIntents.get(id)
    return record ? renderPaymentIntent(record) : undefined
  }
  return {
    charge,
    payment_intent: paymentIntent,
    "data.charge": charge,
    "data.payment_intent": paymentIntent,
  }
}

const render = (scope: RequestScope, refund: RefundRecord, expand: unknown) =>
  applyExpand(renderRefund(refund), expand, expanders(scope))

/** Resolve the charge a refund against a payment intent would reverse. */
const refundableCharge = (
  scope: RequestScope,
  chargeId: string | null,
  intentId: string | null,
) => {
  if (chargeId !== null) {
    const charge = requireCharge(scope, chargeId, "charge")
    return { charge, paymentIntent: charge.payment_intent }
  }
  const intent = requireIntent(scope, intentId ?? "", "payment_intent")
  if (intent.status !== "succeeded" || intent.latest_charge === null)
    throw invalidRequest(
      "This payment_intent cannot be refunded because it does not have a successful charge.",
      "payment_intent",
    )
  const charge = requireCharge(scope, intent.latest_charge, "charge")
  return { charge, paymentIntent: intent.id }
}

export const refundHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetRefunds: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const charge = stringOf(params, "charge")
    const paymentIntent = stringOf(params, "payment_intent")
    const page = await paginate<RefundRecord>(scope.account.refunds, params, {
      url: "/v1/refunds",
      kind: "refund",
      where: (record) =>
        matchesCreated(record.created, params.created) &&
        (charge === null || record.charge === charge) &&
        (paymentIntent === null || record.payment_intent === paymentIntent),
      render: renderRefund,
    })
    return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
  },
  PostRefunds: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const chargeId = stringOf(params, "charge")
    const intentId = stringOf(params, "payment_intent")
    if (chargeId === null && intentId === null)
      throw invalidRequest("Must provide either a charge or a payment_intent.", "charge")
    if (chargeId !== null && intentId !== null)
      throw invalidRequest(
        "You cannot provide both a charge and a payment_intent.",
        "payment_intent",
      )
    const { charge, paymentIntent } = refundableCharge(scope, chargeId, intentId)
    if (charge.status !== "succeeded")
      throw invalidRequest(
        `This charge cannot be refunded because it has a status of ${charge.status}.`,
        "charge",
      )
    const remaining = charge.amount - charge.amount_refunded
    if (remaining <= 0)
      throw invalidRequest(
        `Charge ${charge.id} has already been refunded.`,
        "charge",
        "charge_already_refunded",
      )
    const amount = typeof params.amount === "number" ? params.amount : remaining
    if (amount > remaining)
      throw invalidRequest(
        `Refund amount (${amount}) is greater than the remaining amount that can be refunded (${remaining}).`,
        "amount",
      )
    const id = scope.ids.next("re_", 24)
    const refund: RefundRecord = {
      id,
      amount,
      charge: charge.id,
      created: seconds(scope.now),
      currency: charge.currency,
      metadata: mergeRecordMetadata({}, params.metadata),
      payment_intent: paymentIntent,
      reason: stringOf(params, "reason"),
      receipt_number: null,
      status: "succeeded",
      failure_reason: null,
      balance_transaction: recordBalanceTransaction(scope, {
        amount: -amount,
        currency: charge.currency,
        source: id,
        type: "refund",
        description: "REFUND FOR CHARGE",
      }),
    }
    const amountRefunded = charge.amount_refunded + amount
    const refundedCharge = {
      ...charge,
      amount_refunded: amountRefunded,
      refund_ids: [...charge.refund_ids, id],
      refunded: amountRefunded >= charge.amount,
    }
    scope.account.charges.update(charge.id, refundedCharge)
    scope.account.refunds.insert(id, refund)
    scope.emit("refund.created", renderRefund(refund))
    scope.emit("charge.refunded", renderCharge(refundedCharge))
    return jsonResponse(200, render(scope, refund, params.expand))
  },
  GetRefundsRefund: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const refund = requireRefund(scope, context.params.refund ?? "")
    return jsonResponse(200, render(scope, refund, params.expand))
  },
  PostRefundsRefund: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireRefund(scope, context.params.refund ?? "")
    const refund: RefundRecord = {
      ...current,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
    }
    scope.account.refunds.update(refund.id, refund)
    scope.emit("refund.updated", renderRefund(refund))
    return jsonResponse(200, render(scope, refund, params.expand))
  },
})
