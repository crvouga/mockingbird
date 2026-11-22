/** Pure formatting for the client's screens: no React, no DOM, so tests import it directly. */

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Please try again."

export const price = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

export const date = (value: string): string =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

export const statusLabel = (value: string): string =>
  ({
    pending_payment: "Awaiting payment",
    fulfilled: "Kit requested",
    shipped: "Kit shipped",
    payment_failed: "Payment declined",
    processing: "Processing",
    results_ready: "Results ready",
    reviewed: "Reviewed",
    cancelled: "Cancelled",
  })[value] ?? value.replaceAll("_", " ")

/** The emailed link carries `?sign-in=<token>`; pasting it into the code field works too. */
export const signInLinkToken = (value: string): string | null =>
  /[?&]sign-in=([\w.-]+)/.exec(value)?.[1] ?? null

/** +14155550142 → (415) 555-0142; anything else is shown as stored. */
export const formatPhone = (phone: string): string => {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone
}
