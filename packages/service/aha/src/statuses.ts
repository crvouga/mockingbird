/**
 * The status strings AHA sends in webhooks. Our handler lowercases them and replaces
 * whitespace with `_`, so spelling and spacing matter; an admin transition may name them in
 * any case and is normalised to the vendor spelling here.
 */
export const ORDER_STATUSES = [
  "Scheduled",
  "Rescheduled",
  "Cancelled",
  "Check In",
  "Check Out",
  "Lab Testing In Progress",
  "Non Scheduled Update",
] as const

/** `drawStatus` values sent with `Check Out` (the first two mean the sample was drawn). */
export const DRAW_STATUSES = [
  "Sample Collected",
  "Completed",
  "Patient Refused",
  "UTO",
  "Patient Not Home",
  "Patient Rescheduled",
  "Order Cancelled",
  "Others",
  "Patient Asked to Reschedule",
] as const

/** The status an order has before AHA reports anything (never sent as a webhook). */
export const ORDER_PLACED = "Order Placed"

const key = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, " ")

const canonical = (known: readonly string[], value: string): string =>
  known.find((candidate) => key(candidate) === key(value)) ?? value.trim()

/** The vendor spelling of an order status; an unknown value is used verbatim. */
export const orderStatus = (value: string): string => canonical(ORDER_STATUSES, value)

/** The vendor spelling of a draw status; an unknown value is used verbatim. */
export const drawStatus = (value: string): string => canonical(DRAW_STATUSES, value)

/** Statuses whose webhook carries the appointment time (`scheduleServiceTime`). */
export const isScheduling = (status: string): boolean =>
  status === "Scheduled" || status === "Rescheduled"

/** Draw statuses our handler treats as a successful draw. */
export const isDrawn = (draw: string | null): boolean =>
  draw === "Sample Collected" || draw === "Completed"
