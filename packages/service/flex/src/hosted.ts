import type { NextActionType, SessionRecord } from "./state.js"

/** Test cards the hosted page recognises (spaces are ignored). */
export const CARDS = {
  /** An HSA/FSA card: succeeds, never asks for a letter of medical necessity. */
  hsa: "4000051230000072",
  /** A regular card: succeeds; on a letter_of_medical_necessity product it asks for the letter. */
  regular: "4242424242424242",
  /** Declines: the payment intent falls back to requires_payment_method. */
  decline: "4000000000000002",
} as const

export type CardOutcome =
  | { kind: "invalid"; message: string }
  | { kind: "decline" }
  | { kind: "approve"; hsa: boolean }

const luhn = (digits: string): boolean => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

/** Classify the submitted card form, the way the hosted page's card element would. */
export const classifyCard = (form: Record<string, string>): CardOutcome => {
  const number = (form.cardNumber ?? "").replace(/[\s-]/g, "")
  if (!/^\d{12,19}$/.test(number))
    return { kind: "invalid", message: "Your card number is incomplete." }
  if (!luhn(number)) return { kind: "invalid", message: "Your card number is invalid." }
  const expiry = (form.expiry ?? "").replace(/[\s/]/g, "")
  if (!/^(0[1-9]|1[0-2])(\d{2}|\d{4})$/.test(expiry)) {
    return { kind: "invalid", message: "Your card's expiration date is incomplete." }
  }
  if (!/^\d{3,4}$/.test((form.cvc ?? "").trim())) {
    return { kind: "invalid", message: "Your card's security code is incomplete." }
  }
  if (number === CARDS.decline) return { kind: "decline" }
  return { kind: "approve", hsa: number === CARDS.hsa }
}

/** Put the session id into a return URL, raw and percent-encoded, as Flex does. */
export const substituteSessionId = (url: string, sessionId: string): string =>
  url
    .replaceAll("{CHECKOUT_SESSION_ID}", sessionId)
    .replace(/%7BCHECKOUT_SESSION_ID%7D/gi, sessionId)

/** The browser pages (React, prebuilt in `#ui/server`), loaded only when a page is served. */
const pages = () => import("#ui/server")

export type PageInput = {
  session: SessionRecord
  productNames: string[]
  error?: string
}

/** "month", "3 months": how often the session's first recurring line item bills. */
const cadence = (session: SessionRecord) => {
  const recurring = session.line_items.find((item) => item.price_data.recurring)?.price_data
    .recurring
  if (!recurring) return undefined
  const count = recurring.interval_count ?? 1
  return count === 1 ? recurring.interval : `${count} ${recurring.interval}s`
}

const view = (input: PageInput) => ({
  sessionId: input.session.checkout_session_id,
  mode: input.session.mode,
  amountTotal: input.session.amount_total,
  interval: cadence(input.session),
  productNames: input.productNames,
  // Relative to `/pay/:id`, so an `/__admin/ns/<name>` prefix survives.
  cancelHref: input.session.cancel_url
    ? `./${encodeURIComponent(input.session.checkout_session_id)}/cancel`
    : undefined,
  error: input.error,
})

/** The card form: contact fields, then the card, then Pay. */
export const cardPage = async (input: PageInput) => (await pages()).cardPage(view(input))

/** The next-action step: a letter of medical necessity, or another card. */
export const nextActionPage = async (input: PageInput, type: NextActionType) => {
  if (type !== "collect_letter_of_medical_necessity") {
    return cardPage({
      ...input,
      error:
        input.error ??
        (type === "payment_failed"
          ? "Your payment failed. Try another card."
          : type === "provide_second_payment_method"
            ? "Add a second card to cover the rest of this purchase."
            : "Use another payment method to complete this purchase."),
    })
  }
  return (await pages()).letterPage(view(input))
}

/** A session that can no longer be paid (complete, expired, canceled). */
export const closedPage = async (session: SessionRecord) =>
  (await pages()).closedPage(session.status)

export const notFoundPage = async () => (await pages()).notFoundPage()

export const html = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
