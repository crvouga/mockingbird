/**
 * Stripe's documented test payment methods, card tokens and card numbers, limited to the ones
 * our suites use. A magic payment method id (`pm_card_visa`) resolves to a **new** `pm_` object
 * every time it is used, exactly as Stripe does; a token is materialised by
 * `POST /v1/payment_methods` with `card[token]`; a card number (hosted page, Stripe.js
 * stand-in) maps onto the token with the same behaviour and is never stored.
 */

export type CardDetails = {
  brand: string
  last4: string
  exp_month: number
  exp_year: number
  funding: "credit" | "debit" | "prepaid" | "unknown"
  country: string
  /** Issuing bank; our HSA/FSA detection matches it (only on prepaid cards). */
  issuer: string | null
  /** First six digits. */
  iin: string
  checks: Record<string, string | null>
}

export type DeclineOutcome = {
  kind: "card_error"
  code: string
  decline_code: string
  message: string
  advice_code: string | null
  network_decline_code: string | null
}

export type ChargeOutcome =
  | { kind: "succeed" }
  /** Needs a 3-D Secure challenge on-session; off-session it declines `authentication_required`. */
  | { kind: "authenticate"; offSession: "decline" | "succeed_when_saved" }
  | DeclineOutcome

const EXP_YEAR = 2034

const card = (
  brand: string,
  last4: string,
  iin: string,
  extra: Partial<CardDetails> = {},
): CardDetails => ({
  brand,
  last4,
  exp_month: 12,
  exp_year: EXP_YEAR,
  funding: "credit",
  country: "US",
  issuer: null,
  iin,
  checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: "pass" },
  ...extra,
})

const declined = (
  code: string,
  message: string,
  declineCode: string,
  networkCode: string,
  advice: string | null = "try_again_later",
): DeclineOutcome => ({
  kind: "card_error",
  code,
  decline_code: declineCode,
  message,
  advice_code: advice,
  network_decline_code: networkCode,
})

export const GENERIC_DECLINE = declined(
  "card_declined",
  "Your card was declined.",
  "generic_decline",
  "01",
)
export const INSUFFICIENT_FUNDS = declined(
  "card_declined",
  "Your card has insufficient funds.",
  "insufficient_funds",
  "51",
)
export const EXPIRED_CARD = declined(
  "expired_card",
  "Your card has expired.",
  "expired_card",
  "54",
  "do_not_try_again",
)
export const AUTHENTICATION_REQUIRED = declined(
  "authentication_required",
  "Your card was declined. This transaction requires authentication.",
  "authentication_required",
  "1A",
  null,
)

type TestCard = { details: CardDetails; outcome: ChargeOutcome; dispute?: boolean }

const VISA = card("visa", "4242", "424242")

/** Every test instrument, keyed by the token id the rest of the mock remembers. */
const CARDS: Record<string, TestCard> = {
  tok_visa: { details: VISA, outcome: { kind: "succeed" } },
  tok_visa_debit: {
    details: card("visa", "5556", "400005", { funding: "debit" }),
    outcome: { kind: "succeed" },
  },
  tok_mastercard: { details: card("mastercard", "4444", "555555"), outcome: { kind: "succeed" } },
  tok_amex: { details: card("amex", "0005", "378282"), outcome: { kind: "succeed" } },
  tok_discover: { details: card("discover", "1117", "601111"), outcome: { kind: "succeed" } },
  tok_chargeDeclined: { details: card("visa", "0002", "400000"), outcome: GENERIC_DECLINE },
  tok_chargeDeclinedInsufficientFunds: {
    details: card("visa", "9995", "400000"),
    outcome: INSUFFICIENT_FUNDS,
  },
  tok_chargeDeclinedExpiredCard: { details: card("visa", "0069", "400000"), outcome: EXPIRED_CARD },
  /** Attaches to a customer, then every charge declines. */
  tok_chargeCustomerFail: { details: card("visa", "0341", "400000"), outcome: GENERIC_DECLINE },
  tok_threeDSecure2Required: {
    details: card("visa", "3155", "400000"),
    outcome: { kind: "authenticate", offSession: "succeed_when_saved" },
  },
  tok_threeDSecureRequired: {
    details: card("visa", "3184", "400000"),
    outcome: { kind: "authenticate", offSession: "decline" },
  },
  tok_authenticationRequired: {
    details: card("visa", "3220", "400000"),
    outcome: { kind: "authenticate", offSession: "decline" },
  },
  tok_createDispute: {
    details: card("visa", "0259", "400000"),
    outcome: { kind: "succeed" },
    dispute: true,
  },
  /** The prepaid HSA card the Flex flows use: our HSA/FSA detection matches the issuer. */
  tok_hsa: {
    details: card("visa", "0072", "400005", { funding: "prepaid", issuer: "OPTUM BANK" }),
    outcome: { kind: "succeed" },
  },
}

/** Magic payment method ids, each an alias of a token. */
const PAYMENT_METHOD_ALIASES: Record<string, string> = {
  pm_card_visa: "tok_visa",
  pm_card_visa_debit: "tok_visa_debit",
  pm_card_mastercard: "tok_mastercard",
  pm_card_amex: "tok_amex",
  pm_card_discover: "tok_discover",
  pm_card_chargeDeclined: "tok_chargeDeclined",
  pm_card_visa_chargeDeclined: "tok_chargeDeclined",
  pm_card_chargeDeclinedInsufficientFunds: "tok_chargeDeclinedInsufficientFunds",
  pm_card_visa_chargeDeclinedInsufficientFunds: "tok_chargeDeclinedInsufficientFunds",
  pm_card_chargeDeclinedExpiredCard: "tok_chargeDeclinedExpiredCard",
  pm_card_chargeCustomerFail: "tok_chargeCustomerFail",
  pm_card_authenticationRequired: "tok_authenticationRequired",
  pm_card_threeDSecure2Required: "tok_threeDSecure2Required",
  pm_card_createDispute: "tok_createDispute",
}

/** Card numbers typed into the hosted page or the Stripe.js stand-in. */
const CARD_NUMBERS: Record<string, string> = {
  "4242424242424242": "tok_visa",
  "4000056655665556": "tok_visa_debit",
  "5555555555554444": "tok_mastercard",
  "378282246310005": "tok_amex",
  "6011111111111117": "tok_discover",
  "4000000000000002": "tok_chargeDeclined",
  "4000000000009995": "tok_chargeDeclinedInsufficientFunds",
  "4000000000000069": "tok_chargeDeclinedExpiredCard",
  "4000000000000341": "tok_chargeCustomerFail",
  "4000002500003155": "tok_threeDSecure2Required",
  "4000002760003184": "tok_threeDSecureRequired",
  "4000000000003220": "tok_authenticationRequired",
  "4000000000000259": "tok_createDispute",
  "4000051230000072": "tok_hsa",
}

/** Token id for a magic payment method id, card token, or card number; undefined if unknown. */
export const testInstrument = (value: string): string | undefined => {
  if (CARDS[value]) return value
  const alias = PAYMENT_METHOD_ALIASES[value]
  if (alias) return alias
  return CARD_NUMBERS[value.replace(/[\s-]/g, "")]
}

export const isMagicPaymentMethod = (id: string) => PAYMENT_METHOD_ALIASES[id] !== undefined

export const isTestToken = (id: string) => CARDS[id] !== undefined

/**
 * Details for a token. A Luhn-valid number that is not on Stripe's list behaves like a plain
 * visa that succeeds, the way Stripe's own test mode treats unknown test cards.
 */
export const cardDetailsFor = (token: string): CardDetails => CARDS[token]?.details ?? VISA

export const chargeOutcomeFor = (token: string | null): ChargeOutcome =>
  token === null ? { kind: "succeed" } : (CARDS[token]?.outcome ?? { kind: "succeed" })

export const disputesOnCharge = (token: string | null): boolean =>
  token !== null && CARDS[token]?.dispute === true

export const luhnValid = (number: string): boolean => {
  const digits = number.replace(/\D/g, "")
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

/** Brand and last4 for an unknown (but Luhn-valid) number. */
export const detailsForNumber = (number: string): CardDetails => {
  const digits = number.replace(/\D/g, "")
  const token = CARD_NUMBERS[digits]
  if (token) return cardDetailsFor(token)
  const brand = digits.startsWith("4")
    ? "visa"
    : digits.startsWith("5")
      ? "mastercard"
      : digits.startsWith("3")
        ? "amex"
        : "unknown"
  return card(brand, digits.slice(-4), digits.slice(0, 6))
}

/** Every token the suites can use, for docs and the QA corpus. */
export const TEST_TOKENS = Object.keys(CARDS)
export const TEST_PAYMENT_METHOD_IDS = Object.keys(PAYMENT_METHOD_ALIASES)
export const TEST_CARD_NUMBERS = Object.keys(CARD_NUMBERS)
