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

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
label{display:block;margin:.75rem 0 .25rem;font-size:.9rem}
input{width:100%;box-sizing:border-box;padding:.5rem;font-size:1rem}
button{margin-top:1rem;width:100%;padding:.75rem;font-size:1rem}
[role=alert]{color:#b00020;margin:1rem 0}
.row{display:flex;gap:.5rem}.row>div{flex:1}
</style>
</head>
<body>
${body}
</body>
</html>
`

export type PageInput = {
  session: SessionRecord
  productNames: string[]
  error?: string
}

const alert = (error: string | undefined) =>
  error ? `<div role="alert" data-testid="flex-mock-error">${escapeHtml(error)}</div>` : ""

const cancelLink = (session: SessionRecord) =>
  session.cancel_url
    ? `<p><a data-testid="flex-mock-cancel" href="./${encodeURIComponent(session.checkout_session_id)}/cancel">Cancel and return</a></p>`
    : ""

const summary = (input: PageInput) => {
  const { session } = input
  const items = input.productNames
    .map((name) => `<li data-testid="flex-mock-line-item">${escapeHtml(name)}</li>`)
    .join("")
  return `<h1>Pay with HSA/FSA</h1>
<p data-testid="flex-mock-session" data-session-id="${escapeHtml(session.checkout_session_id)}">
${session.mode === "setup" ? "Save a card for future payments" : `Total <strong data-testid="flex-mock-amount">${dollars(session.amount_total)}</strong>`}
</p>
${items ? `<ul>${items}</ul>` : ""}`
}

/** The card form: contact fields, then the card, then Pay. */
export const cardPage = (input: PageInput) =>
  layout(
    "Flex checkout (Mockingbird)",
    `${summary(input)}
${alert(input.error)}
<form method="post" action="" data-testid="flex-mock-form">
<input type="hidden" name="step" value="card">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" placeholder="Email" data-testid="flex-mock-email">
<div class="row">
<div><label for="firstName">First name</label>
<input id="firstName" name="firstName" autocomplete="given-name" placeholder="First Name" data-testid="flex-mock-first-name"></div>
<div><label for="lastName">Last name</label>
<input id="lastName" name="lastName" autocomplete="family-name" placeholder="Last Name" data-testid="flex-mock-last-name"></div>
</div>
<label for="phone">Phone</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="Phone" data-testid="flex-mock-phone">
<label for="cardNumber">Card number</label>
<input id="cardNumber" name="cardNumber" inputmode="numeric" autocomplete="cc-number" placeholder="Card number" data-testid="flex-mock-card">
<div class="row">
<div><label for="expiry">Expiration (MM/YY)</label>
<input id="expiry" name="expiry" autocomplete="cc-exp" placeholder="MM / YY" data-testid="flex-mock-exp"></div>
<div><label for="cvc">CVC</label>
<input id="cvc" name="cvc" autocomplete="cc-csc" placeholder="CVC" data-testid="flex-mock-cvc"></div>
</div>
<label for="postalCode">ZIP</label>
<input id="postalCode" name="postalCode" autocomplete="postal-code" placeholder="ZIP" data-testid="flex-mock-zip">
<button type="submit" data-testid="flex-mock-pay">${input.session.mode === "setup" ? "Save card" : "Pay"}</button>
</form>
${cancelLink(input.session)}`,
  )

/** The next-action step: a letter of medical necessity, or another card. */
export const nextActionPage = (input: PageInput, type: NextActionType) => {
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
  return layout(
    "Letter of medical necessity (Mockingbird)",
    `${summary(input)}
${alert(input.error)}
<p data-testid="flex-mock-lmn">One of these items needs a letter of medical necessity. Answer the short questionnaire to finish paying.</p>
<form method="post" action="" data-testid="flex-mock-lmn-form">
<input type="hidden" name="step" value="lmn">
<button type="submit" data-testid="flex-mock-lmn-submit">Submit questionnaire and pay</button>
</form>
${cancelLink(input.session)}`,
  )
}

/** A session that can no longer be paid (complete, expired, canceled). */
export const closedPage = (session: SessionRecord) =>
  layout(
    "Flex checkout (Mockingbird)",
    `<h1>This checkout is ${escapeHtml(session.status)}</h1>
<p data-testid="flex-mock-closed" data-status="${escapeHtml(session.status)}">Nothing more to pay here.</p>`,
  )

export const notFoundPage = () =>
  layout(
    "Flex checkout (Mockingbird)",
    `<h1>Checkout not found</h1><p data-testid="flex-mock-not-found">This link is invalid.</p>`,
  )

export const html = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
