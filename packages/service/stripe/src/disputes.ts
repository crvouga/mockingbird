import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { resourceMissing } from "./errors.js"
import { requestScope, type Services } from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { type Params, queryParams } from "./params.js"
import { renderDispute } from "./render.js"
import type { DisputeRecord } from "./state.js"

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

export const disputeHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetDisputes: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const charge = stringOf(params, "charge")
    const paymentIntent = stringOf(params, "payment_intent")
    if (paymentIntent !== null && !scope.account.paymentIntents.has(paymentIntent))
      throw resourceMissing("paymentintent", paymentIntent, "payment_intent", 400)
    const page = await paginate<DisputeRecord>(scope.account.disputes, params, {
      url: "/v1/disputes",
      kind: "dispute",
      where: (record) =>
        matchesCreated(record.created, params.created) &&
        (charge === null || record.charge === charge) &&
        (paymentIntent === null || record.payment_intent === paymentIntent),
      render: renderDispute,
    })
    // Stripe still returns the legacy `count` (the matching disputes) on this list.
    const count = scope.account.disputes.list({
      where: (record) =>
        matchesCreated(record.created, params.created) &&
        (charge === null || record.charge === charge) &&
        (paymentIntent === null || record.payment_intent === paymentIntent),
    }).length
    return jsonResponse(200, { ...page, count })
  },
  GetDisputesDispute: async (context) => {
    const scope = requestScope(services, context)
    const id = context.params.dispute ?? ""
    const dispute = scope.account.disputes.get(id)
    if (!dispute) throw resourceMissing("dispute", id, "dispute")
    return jsonResponse(200, renderDispute(dispute))
  },
})
