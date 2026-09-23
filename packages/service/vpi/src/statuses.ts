/**
 * VPI prescription statuses and which of the three clinic lists shows a prescription in
 * each. `saveNewPrescription` creates a draft awaiting provider signature (the incomplete
 * list); the pharmacy then receives, processes, completes or cancels it.
 */
export type PrescriptionList = "incomplete" | "submitted" | "archived"

export const DRAFT_STATUS = "Provider Signature Needed"

const CANONICAL: Record<string, { status: string; list: PrescriptionList }> = {
  "provider signature needed": { status: "Provider Signature Needed", list: "incomplete" },
  "signature needed": { status: "Signature Needed", list: "incomplete" },
  "new formula pending": { status: "New Formula Pending", list: "incomplete" },
  received: { status: "Received", list: "submitted" },
  "order received": { status: "Order Received", list: "submitted" },
  "in process": { status: "In Process", list: "submitted" },
  "order in process": { status: "Order In Process", list: "submitted" },
  "prescriptions in process": { status: "Prescriptions In Process", list: "submitted" },
  "on hold": { status: "On Hold", list: "submitted" },
  "order on hold": { status: "Order On Hold", list: "submitted" },
  completed: { status: "Completed", list: "submitted" },
  "order complete": { status: "Order Complete", list: "submitted" },
  "order completed": { status: "Order Completed", list: "submitted" },
  cancelled: { status: "Cancelled", list: "archived" },
  "order cancelled": { status: "Order Cancelled", list: "archived" },
  archived: { status: "Archived", list: "archived" },
}

/** The canonical status and list for a transition target; unknown targets go verbatim to `submitted`. */
export const resolveStatus = (to: string): { status: string; list: PrescriptionList } =>
  CANONICAL[to.trim().toLowerCase()] ?? { status: to.trim(), list: "submitted" }

/** Completed statuses carry a tracking number. */
export const isCompleted = (status: string): boolean => /complete/i.test(status)

/** Still "active" for the duplicate check: not cancelled or archived. */
export const isActive = (list: PrescriptionList): boolean => list !== "archived"
