import type { CallbackFulfillmentStatus, CallbackStatus } from "./state.js"

/** The callback body the agent posts to `POST /prescriptions/webhooks/portal-agent`. */
export type PortalAgentCallback = {
  status: CallbackStatus
  paymentId: string
  prescriptionOrderItemId?: string | null
  pharmacyId?: string
  portalOrderId?: string | null
  portalDraftOrderId?: string | null
  confirmationNumber?: string | null
  agentJobId?: string | null
  message?: string | null
  screenshotArtifactId?: string | null
  submittedAt?: string | null
  needsReviewReason?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  fulfillmentStatus?: CallbackFulfillmentStatus
  trackingNumber?: string | null
  trackingCarrier?: string | null
}

export const CALLBACK_STATUSES: readonly CallbackStatus[] = [
  "submitted",
  "draft_ready",
  "needs_review",
  "error",
]

export const CALLBACK_FULFILLMENT_STATUSES: readonly CallbackFulfillmentStatus[] = [
  "submitted",
  "processing",
  "shipped",
  "delivered",
  "error",
  "cancelled",
]

/** The pharmacy ids our receiver admits on a callback (`PORTAL_AGENT_PHARMACY_IDS`). */
export const CALLBACK_PHARMACY_IDS: readonly string[] = ["lifefile", "vpi"]

/** Optional fields our receiver requires to be a string or null when present. */
export const OPTIONAL_STRING_CALLBACK_FIELDS = [
  "prescriptionOrderItemId",
  "portalOrderId",
  "portalDraftOrderId",
  "confirmationNumber",
  "agentJobId",
  "message",
  "screenshotArtifactId",
  "submittedAt",
  "needsReviewReason",
  "errorCode",
  "errorDetail",
  "trackingNumber",
  "trackingCarrier",
] as const

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

/**
 * Why our receiver (`isPortalAgentFulfillmentCallback` in the pharmacy webhook controller)
 * would answer 400 to this callback, or an empty list when it would accept it. The admin
 * `complete` route refuses to fire a callback the receiver would reject unless forced.
 */
export const callbackIssues = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not an object"]
  const callback = value as Record<string, unknown>
  const issues: string[] = []
  if (!nonEmpty(callback.paymentId)) issues.push("paymentId must be a non-empty string")
  if (!CALLBACK_STATUSES.includes(callback.status as CallbackStatus)) {
    issues.push(`status must be one of ${CALLBACK_STATUSES.join(", ")}`)
  }
  if (
    callback.pharmacyId !== undefined &&
    (typeof callback.pharmacyId !== "string" ||
      !CALLBACK_PHARMACY_IDS.includes(callback.pharmacyId))
  ) {
    issues.push(`pharmacyId must be one of ${CALLBACK_PHARMACY_IDS.join(", ")} when present`)
  }
  for (const field of OPTIONAL_STRING_CALLBACK_FIELDS) {
    const v = callback[field]
    if (v !== undefined && v !== null && typeof v !== "string") {
      issues.push(`${field} must be a string or null`)
    }
  }
  if (
    callback.fulfillmentStatus !== undefined &&
    !CALLBACK_FULFILLMENT_STATUSES.includes(callback.fulfillmentStatus as CallbackFulfillmentStatus)
  ) {
    issues.push(`fulfillmentStatus must be one of ${CALLBACK_FULFILLMENT_STATUSES.join(", ")}`)
  }
  if (callback.status === "draft_ready" && !nonEmpty(callback.portalDraftOrderId)) {
    issues.push("draft_ready needs a non-empty portalDraftOrderId")
  }
  return issues
}
