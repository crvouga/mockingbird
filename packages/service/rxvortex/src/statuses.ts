/**
 * Vendor status strings. RxVortex reports three free-text fields per order (`rxstatus`,
 * `orderstatus`, `shipping_status`); a transition sets all three coherently, the way the
 * real pharmacy moves an order along, so our status mapper sees realistic combinations.
 */
export type StatusTriple = { rxstatus: string; orderstatus: string; shipping_status: string }

const TRIPLES: Record<string, StatusTriple> = {
  created: { rxstatus: "Created", orderstatus: "Created", shipping_status: "Pending" },
  fill: { rxstatus: "Fill", orderstatus: "Processing", shipping_status: "Pending" },
  "pv1 complete": {
    rxstatus: "PV1 Complete",
    orderstatus: "Processing",
    shipping_status: "Pending",
  },
  compound: { rxstatus: "Compound", orderstatus: "Processing", shipping_status: "Pending" },
  "out of stock": { rxstatus: "Out of Stock", orderstatus: "On Hold", shipping_status: "Pending" },
  "on hold": { rxstatus: "On Hold", orderstatus: "On Hold", shipping_status: "Pending" },
  shipping: {
    rxstatus: "Fulfillment Complete",
    orderstatus: "Shipping",
    shipping_status: "In Transit",
  },
  shipped: {
    rxstatus: "Fulfillment Complete",
    orderstatus: "Shipping",
    shipping_status: "In Transit",
  },
  delivered: {
    rxstatus: "Fulfillment Complete",
    orderstatus: "Completed Orders",
    shipping_status: "Delivered",
  },
  cancelled: { rxstatus: "Cancelled", orderstatus: "Cancelled", shipping_status: "Cancelled" },
  canceled: { rxstatus: "Cancelled", orderstatus: "Cancelled", shipping_status: "Cancelled" },
  error: { rxstatus: "Error", orderstatus: "Error", shipping_status: "Pending" },
  rejected: { rxstatus: "Rejected", orderstatus: "Rejected", shipping_status: "Pending" },
}

/** The status triple for a transition target; an unknown target is used verbatim. */
export const triple = (to: string): StatusTriple =>
  TRIPLES[to.trim().toLowerCase()] ?? { rxstatus: to, orderstatus: to, shipping_status: "Pending" }

/** Shipped or later: carries tracking and can no longer be cancelled. */
export const isShippedOrLater = (to: string): boolean =>
  ["shipping", "shipped", "delivered"].includes(to.trim().toLowerCase())

export const isTerminal = (status: StatusTriple): boolean =>
  /cancel|deliver|reject|error/i.test(`${status.rxstatus} ${status.shipping_status}`)
