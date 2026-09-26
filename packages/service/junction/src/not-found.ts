/**
 * Junction's 404 bodies for an unknown resource, and the diagnostic headers the mock adds.
 *
 * The wording differs per endpoint — trailing period included — and that is Junction's,
 * not a typo: every string below was recorded from the sandbox with a random order UUID
 * (2026-09-20), and `verify` re-checks each one.
 */
import { HttpError } from "@crvouga/mockingbird-service"
import type { JunctionState } from "./state.js"

/** The `detail` of each order-scoped operation's 404 for an order that does not exist. */
export const ORDER_NOT_FOUND: Readonly<Record<string, string>> = {
  get_order_v3_order__order_id__get: "This order doesn't exist",
  cancel_order_v3_order__order_id__cancel_post: "Order doesn't exist",
  simulate_order_v3_order__order_id__test_post: "Order doesn't exist",
  get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get: "This order doesn't exist",
  get_result_raw_v3_order__order_id__result_get: "Order not found",
  get_result_metadata_v3_order__order_id__result_metadata_get: "Order not found",
  get_result_pdf_v3_order__order_id__result_pdf_get: "Order not found",
  get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get:
    "This order doesn't exist.",
  book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post:
    "This order doesn't exist.",
  reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch:
    "This order doesn't exist.",
  cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch:
    "This order doesn't exist.",
  get_psc_appointment_v3_order__order_id__psc_appointment_get: "This order doesn't exist.",
  book_psc_appointment_v3_order__order_id__psc_appointment_book_post: "This order doesn't exist.",
  reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch:
    "This order doesn't exist.",
  cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch:
    "This order doesn't exist.",
}

/**
 * Names the missing resource: `order <id>`, `user <id>`, or `user client:<client_user_id>`
 * (the id percent-encoded). Never part of Junction's answer.
 */
export const MISS_HEADER = "x-mockingbird-miss"
/** What the namespace does hold: `users=<n> orders=<n>`. */
export const KNOWN_HEADER = "x-mockingbird-known"

/**
 * Throw Junction's 404 for a missing user or order. The body is Junction's, byte for
 * byte; the headers say what was looked up and what the namespace holds, so a mock 404
 * can be told apart from a sandbox one (and a split-brain setup spotted in one request).
 */
export function missing(
  state: JunctionState,
  kind: "user" | "order",
  id: string,
  detail: string,
): never {
  throw new HttpError(
    404,
    { detail },
    {
      // Percent-encoded: an id is caller input, and a header value must be ASCII.
      [MISS_HEADER]: `${kind} ${encodeURIComponent(id).replace(/%3A/gi, ":")}`,
      [KNOWN_HEADER]: `users=${state.users.count()} orders=${state.orders.count()}`,
    },
  )
}

/** The 404 an order-scoped operation answers for an unknown order. */
export function orderMissing(state: JunctionState, operationId: string, id: string): never {
  return missing(state, "order", id, ORDER_NOT_FOUND[operationId] ?? "This order doesn't exist")
}
