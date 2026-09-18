/**
 * Stripe's documented test payment methods and card tokens, limited to the ones the QA suites
 * suites use. A payment method may be attached by id without ever being created; a card token is
 * materialised by `POST /v1/payment_methods` with `card[token]`.
 */

export type CardDetails = {
  brand: string
  last4: string
  exp_month: number
  exp_year: number
  funding: "credit" | "debit" | "prepaid" | "unknown"
  country: string
  checks: Record<string, string>
}

export type ChargeOutcome =
  | { kind: "succeed" }
  | { kind: "card_error"; code: string; decline_code?: string; message: string }

const card = (brand: string, last4: string): CardDetails => ({
  brand,
  last4,
  exp_month: 12,
  exp_year: new Date().getUTCFullYear() + 3,
  funding: "credit",
  country: "US",
  checks: { address_line1_check: "pass", address_postal_code_check: "pass", cvc_check: "pass" },
})

export const TEST_PAYMENT_METHODS: Readonly<Record<string, CardDetails>> = {
  pm_card_visa: card("visa", "4242"),
  pm_card_mastercard: card("mastercard", "4444"),
  pm_card_amex: card("amex", "0005"),
  pm_card_discover: card("discover", "1117"),
  pm_card_authenticationRequired: card("visa", "3220"),
  pm_card_chargeDeclined: card("visa", "0341"),
  pm_card_visa_chargeDeclined: card("visa", "0341"),
  pm_card_visa_chargeDeclinedInsufficientFunds: card("visa", "9995"),
}

const declined = (code: string, message: string, declineCode: string): ChargeOutcome => ({
  kind: "card_error",
  code,
  decline_code: declineCode,
  message,
})

const TEST_OUTCOMES: Readonly<Record<string, ChargeOutcome>> = {
  pm_card_visa: { kind: "succeed" },
  pm_card_mastercard: { kind: "succeed" },
  pm_card_amex: { kind: "succeed" },
  pm_card_discover: { kind: "succeed" },
  pm_card_authenticationRequired: declined(
    "authentication_required",
    "Your card was declined. This transaction requires authentication.",
    "authentication_required",
  ),
  pm_card_chargeDeclined: declined("card_declined", "Your card was declined.", "generic_decline"),
  pm_card_visa_chargeDeclined: declined(
    "card_declined",
    "Your card was declined.",
    "generic_decline",
  ),
  pm_card_visa_chargeDeclinedInsufficientFunds: declined(
    "card_declined",
    "Your card has insufficient funds.",
    "insufficient_funds",
  ),
  tok_visa: { kind: "succeed" },
  tok_visa_debit: { kind: "succeed" },
  tok_mastercard: { kind: "succeed" },
  tok_amex: { kind: "succeed" },
  tok_createDispute: { kind: "succeed" },
  tok_chargeDeclinedInsufficientFunds: declined(
    "card_declined",
    "Your card has insufficient funds.",
    "insufficient_funds",
  ),
  tok_chargeDeclinedExpiredCard: declined("expired_card", "Your card has expired.", "expired_card"),
  tok_chargeCustomerFail: declined("card_declined", "Your card was declined.", "generic_decline"),
}

export const TEST_CARD_TOKENS: Readonly<Record<string, CardDetails>> = {
  tok_visa: card("visa", "4242"),
  tok_visa_debit: card("visa", "4242"),
  tok_mastercard: card("mastercard", "4444"),
  tok_amex: card("amex", "0005"),
  tok_createDispute: card("visa", "0002"),
  tok_chargeDeclinedInsufficientFunds: card("visa", "9995"),
  tok_chargeDeclinedExpiredCard: card("visa", "0069"),
  tok_chargeCustomerFail: card("visa", "0341"),
}

/** Unknown test ids behave like a plain successful visa card, the way Stripe's catch-alls do. */
export const chargeOutcomeFor = (tokenOrId: string): ChargeOutcome =>
  TEST_OUTCOMES[tokenOrId] ?? { kind: "succeed" }
