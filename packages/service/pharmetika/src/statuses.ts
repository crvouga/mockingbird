/**
 * Pharmetika workflow statuses. An order carries one free-text `workflow_status`; a
 * transition sets it verbatim (the pharmacy's own spellings, e.g. `data_entry`,
 * `compounding-in-progress`, `shipped`, `shipped-received`) so our status mapper sees the
 * real strings.
 */

/** What a submitted, non-controlled order starts as. */
export const SUBMITTED_STATUS = "prescription_entered"

/** Where an EPCS (controlled-substance) order parks until the prescriber signs in the portal. */
export const PENDING_APPROVAL_STATUS = "pending_prescriber_approval"

/** Every status the mock documents, in rough lifecycle order. Any other string also works. */
export const KNOWN_STATUSES = [
  SUBMITTED_STATUS,
  PENDING_APPROVAL_STATUS,
  "signed",
  "data_entry_queue",
  "data_entry",
  "data_entry_clarification",
  "data_entry_rework",
  "data_entry_verification",
  "lab_formulation",
  "contacting_patient",
  "compounding",
  "compounding-in-progress",
  "filled",
  "dispensed",
  "dispense_checked",
  "dispense_verified",
  "verified",
  "checked",
  "order_reconciliation",
  "ready",
  "ready-ship",
  "shipping",
  "shipped",
  "Completed Orders",
  "shipped-received",
  "completed",
  "delivered",
  "cancelled",
] as const

const norm = (status: string) => status.trim().toLowerCase()

/** Handed to the carrier or later: carries a tracking id. */
export const isShippedOrLater = (status: string): boolean =>
  ["shipped", "completed orders", "shipped-received", "completed", "delivered"].includes(
    norm(status),
  )

/** No further movement and no cancel. */
export const isFinal = (status: string): boolean =>
  ["cancelled", "shipped-received", "completed", "delivered"].includes(norm(status))

/** The v7 cancel refuses these, as the pharmacy does once an order has left the building. */
export const isCancellable = (status: string): boolean =>
  !isShippedOrLater(status) && !isFinal(status)
