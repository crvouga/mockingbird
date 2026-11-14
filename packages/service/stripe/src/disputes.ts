import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import {
  booleanOf,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { recordDisputeTransaction, renderDisputeIn } from "./payments.js"
import { DISPUTE_EVIDENCE_FIELDS } from "./render.js"
import { type DisputeRecord, seconds } from "./state.js"

type RecordValue = Record<string, unknown>

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

export const DISPUTE_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
] as const

/** Statuses that still await the merchant's response (evidence or acceptance). */
const AWAITING_RESPONSE = new Set(["needs_response", "warning_needs_response"])
/** Statuses Stripe announces with `charge.dispute.closed` rather than `charge.dispute.updated`. */
const CLOSED = new Set(["won", "lost", "warning_closed"])

const isPlainObject = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * `data.previous_attributes`: each changed field's prior value. A changed hash lists only its
 * changed keys (an added key's prior value is `null`); an array is listed whole.
 */
export const previousAttributes = (before: RecordValue, after: RecordValue): RecordValue => {
  const changed: RecordValue = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key]
    const next = after[key]
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    changed[key] =
      isPlainObject(old) && isPlainObject(next) ? previousAttributes(old, next) : (old ?? null)
  }
  return changed
}

/** Persist a dispute change and emit `type` with what changed, if anything did. */
const commit = (
  scope: RequestScope,
  current: DisputeRecord,
  next: DisputeRecord,
  type: "charge.dispute.updated" | "charge.dispute.closed",
): DisputeRecord => {
  const before = renderDisputeIn(scope, current)
  scope.account.disputes.update(current.id, next)
  const after = renderDisputeIn(scope, next)
  const previous = previousAttributes(before, after)
  if (Object.keys(previous).length > 0) scope.emit(type, after, previous)
  return next
}

const requireDispute = (scope: RequestScope, id: string): DisputeRecord => {
  const dispute = scope.account.disputes.get(id)
  if (!dispute) throw resourceMissing("dispute", id, "dispute")
  return dispute
}

const evidenceUpdate = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) return {}
  if (raw.enhanced_evidence !== undefined)
    throw invalidRequest(
      "Enhanced dispute evidence (Visa Compelling Evidence 3.0, compliance) is not modelled by this mock.",
      "evidence[enhanced_evidence]",
    )
  const update: Record<string, string> = {}
  for (const field of DISPUTE_EVIDENCE_FIELDS) {
    const value = raw[field]
    if (typeof value === "string") update[field] = value
  }
  return update
}

/**
 * `POST /v1/disputes/:id`: stage evidence (`submit=false`) or submit it (the default whenever
 * evidence is sent, or `submit=true` alone for staged evidence), moving the dispute to
 * `under_review` / `warning_under_review`. Metadata merges at any status.
 */
const updateDispute = (scope: RequestScope, current: DisputeRecord, params: Params) => {
  const evidence = evidenceUpdate(params.evidence)
  const submitFlag = booleanOf(params.submit)
  const submitting = submitFlag === true || (evidence !== undefined && submitFlag !== false)
  if ((evidence !== undefined || submitting) && !AWAITING_RESPONSE.has(current.status))
    throw invalidRequest(
      `This dispute has a status of ${current.status}; evidence can only be staged or submitted while it is needs_response or warning_needs_response.`,
      evidence !== undefined ? "evidence" : "submit",
    )
  const merged: Record<string, string> = { ...current.evidence }
  for (const [field, value] of Object.entries(evidence ?? {})) {
    if (value === "") delete merged[field]
    else merged[field] = value
  }
  const details = current.evidence_details ?? {
    due_by: null,
    has_evidence: false,
    past_due: false,
    submission_count: 0,
  }
  const now = seconds(scope.now)
  const next: DisputeRecord = {
    ...current,
    metadata: mergeRecordMetadata(current.metadata, params.metadata),
    evidence: merged,
    evidence_details: {
      ...details,
      has_evidence: Object.keys(merged).length > 0,
      ...(submitting
        ? {
            submission_count: details.submission_count + 1,
            past_due: details.due_by !== null && now > details.due_by,
          }
        : {}),
    },
    status: submitting
      ? current.status === "warning_needs_response"
        ? "warning_under_review"
        : "under_review"
      : current.status,
  }
  return commit(scope, current, next, "charge.dispute.updated")
}

/**
 * Move a dispute to another status (`PUT /__admin/disputes/:id`), the way the card network's
 * decision arrives: `won`, `lost` and `warning_closed` emit `charge.dispute.closed`, anything
 * else `charge.dispute.updated`. Winning a chargeback reinstates the withdrawn amount
 * (`charge.dispute.funds_reinstated`).
 */
export const moveDispute = (
  scope: RequestScope,
  current: DisputeRecord,
  status: string,
): DisputeRecord => {
  if (!(DISPUTE_STATUSES as readonly string[]).includes(status))
    throw invalidRequest(`Invalid status: must be one of ${DISPUTE_STATUSES.join(", ")}`, "status")
  const next: DisputeRecord = { ...current, status }
  const lines = current.balance_transactions ?? []
  const reinstates = status === "won" && lines.length === 1
  if (reinstates)
    next.balance_transactions = [
      ...lines,
      recordDisputeTransaction(scope, current, "reinstatement"),
    ]
  const moved = commit(
    scope,
    current,
    next,
    CLOSED.has(status) ? "charge.dispute.closed" : "charge.dispute.updated",
  )
  if (reinstates) scope.emit("charge.dispute.funds_reinstated", renderDisputeIn(scope, moved))
  return moved
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
      cursorParam: "dispute",
      where: (record) =>
        matchesCreated(record.created, params.created) &&
        (charge === null || record.charge === charge) &&
        (paymentIntent === null || record.payment_intent === paymentIntent),
      render: (record) => renderDisputeIn(scope, record),
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
    const dispute = requireDispute(scope, context.params.dispute ?? "")
    return jsonResponse(200, renderDisputeIn(scope, dispute))
  },
  PostDisputesDispute: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const dispute = requireDispute(scope, context.params.dispute ?? "")
    return jsonResponse(200, renderDisputeIn(scope, updateDispute(scope, dispute, params)))
  },
  /** Accept the dispute: `needs_response` → `lost`, an inquiry → `warning_closed`. */
  PostDisputesDisputeClose: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const dispute = requireDispute(scope, context.params.dispute ?? "")
    if (!AWAITING_RESPONSE.has(dispute.status))
      throw invalidRequest(
        `This dispute cannot be closed because it has a status of ${dispute.status}.`,
        "dispute",
      )
    const status = dispute.status === "warning_needs_response" ? "warning_closed" : "lost"
    const closed = commit(scope, dispute, { ...dispute, status }, "charge.dispute.closed")
    return jsonResponse(200, renderDisputeIn(scope, closed))
  },
})
