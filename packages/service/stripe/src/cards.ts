import { opaqueToken } from "@crvouga/mockingbird-service"
import { cardError } from "./errors.js"
import type { CardDetails, CardOutcome } from "./state.js"

/**
 * Structurally valid card numbers succeed except Stripe's documented test numbers, which keep
 * their decline and authentication outcomes. That is what Elements and the server SDKs send.
 */
const SPECIAL: Record<string, CardOutcome> = {
  "4000000000000002": {
    kind: "decline",
    code: "card_declined",
    decline_code: "generic_decline",
    message: "Your card was declined.",
  },
  "4000000000009995": {
    kind: "decline",
    code: "card_declined",
    decline_code: "insufficient_funds",
    message: "Your card has insufficient funds.",
  },
  "4000000000009987": {
    kind: "decline",
    code: "card_declined",
    decline_code: "lost_card",
    message: "Your card was declined.",
  },
  "4000000000009979": {
    kind: "decline",
    code: "card_declined",
    decline_code: "stolen_card",
    message: "Your card was declined.",
  },
  "4000000000000069": {
    kind: "decline",
    code: "expired_card",
    decline_code: "expired_card",
    message: "Your card has expired.",
  },
  "4000000000000127": {
    kind: "decline",
    code: "incorrect_cvc",
    decline_code: "incorrect_cvc",
    message: "Your card's security code is incorrect.",
  },
  "4000000000000119": {
    kind: "decline",
    code: "processing_error",
    decline_code: "processing_error",
    message: "An error occurred while processing your card. Try again in a little bit.",
  },
  "4000002500003155": { kind: "authenticate" },
  "4000002760003184": { kind: "authenticate" },
  "4000000000003220": { kind: "authenticate" },
  "4000008260003178": { kind: "authenticate" },
}

/** Magic ids the server SDKs pass instead of raw card numbers. */
export const MAGIC_PAYMENT_METHODS: Record<string, { number: string; funding: string }> = {
  pm_card_visa: { number: "4242424242424242", funding: "credit" },
  pm_card_visa_debit: { number: "4000056655665556", funding: "debit" },
  pm_card_mastercard: { number: "5555555555554444", funding: "credit" },
  pm_card_mastercard_debit: { number: "5200828282828210", funding: "debit" },
  pm_card_mastercard_prepaid: { number: "5105105105105100", funding: "prepaid" },
  pm_card_amex: { number: "378282246310005", funding: "credit" },
  pm_card_discover: { number: "6011111111111117", funding: "credit" },
  pm_card_diners: { number: "3056930009020004", funding: "credit" },
  pm_card_jcb: { number: "3566002020360505", funding: "credit" },
  pm_card_unionpay: { number: "6200000000000005", funding: "credit" },
  pm_card_chargeDeclined: { number: "4000000000000002", funding: "credit" },
  pm_card_chargeDeclinedInsufficientFunds: { number: "4000000000009995", funding: "credit" },
  pm_card_chargeDeclinedLostCard: { number: "4000000000009987", funding: "credit" },
  pm_card_chargeDeclinedStolenCard: { number: "4000000000009979", funding: "credit" },
  pm_card_chargeDeclinedExpiredCard: { number: "4000000000000069", funding: "credit" },
  pm_card_chargeDeclinedIncorrectCvc: { number: "4000000000000127", funding: "credit" },
  pm_card_chargeDeclinedProcessingError: { number: "4000000000000119", funding: "credit" },
  pm_card_authenticationRequired: { number: "4000002500003155", funding: "credit" },
  pm_card_authenticationRequiredOnSetup: { number: "4000002500003155", funding: "credit" },
  pm_card_threeDSecure2Required: { number: "4000000000003220", funding: "credit" },
  pm_card_threeDSecureRequired: { number: "4000000000003220", funding: "credit" },
}

export const MAGIC_TOKENS: Record<string, { number: string; funding: string }> = {
  tok_visa: { number: "4242424242424242", funding: "credit" },
  tok_visa_debit: { number: "4000056655665556", funding: "debit" },
  tok_mastercard: { number: "5555555555554444", funding: "credit" },
  tok_mastercard_debit: { number: "5200828282828210", funding: "debit" },
  tok_amex: { number: "378282246310005", funding: "credit" },
  tok_discover: { number: "6011111111111117", funding: "credit" },
  tok_diners: { number: "3056930009020004", funding: "credit" },
  tok_jcb: { number: "3566002020360505", funding: "credit" },
  tok_unionpay: { number: "6200000000000005", funding: "credit" },
  tok_chargeDeclined: { number: "4000000000000002", funding: "credit" },
  tok_chargeDeclinedInsufficientFunds: { number: "4000000000009995", funding: "credit" },
  tok_chargeDeclinedExpiredCard: { number: "4000000000000069", funding: "credit" },
  tok_chargeDeclinedIncorrectCvc: { number: "4000000000000127", funding: "credit" },
  tok_chargeDeclinedProcessingError: { number: "4000000000000119", funding: "credit" },
}

const luhn = (digits: string) => {
  let sum = 0
  let alternate = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index])
    if (alternate) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    alternate = !alternate
  }
  return sum % 10 === 0
}

export const brandOf = (number: string) => {
  if (/^3[47]/.test(number)) return "amex"
  if (/^4/.test(number)) return "visa"
  if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) return "mastercard"
  if (/^6(?:011|5)/.test(number)) return "discover"
  if (/^3(?:0[0-5]|[68])/.test(number)) return "diners"
  if (/^35/.test(number)) return "jcb"
  if (/^62/.test(number)) return "unionpay"
  return "unknown"
}

const outcomeOf = (number: string): CardOutcome => SPECIAL[number] ?? { kind: "success" }

export const cardFromNumber = (
  number: string,
  expMonth: number,
  expYear: number,
  cvc: string | undefined,
  param: string,
  funding = "credit",
): CardDetails => {
  const digits = number.replace(/[\s-]/g, "")
  if (!/^\d{13,19}$/.test(digits) || !luhn(digits))
    throw cardError({
      code: "invalid_number",
      message: "Your card number is incorrect.",
      param: `${param}[number]`,
    })
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12)
    throw cardError({
      code: "invalid_expiry_month",
      message: "Your card's expiration month is invalid.",
      param: `${param}[exp_month]`,
    })
  const year = expYear < 100 ? 2000 + expYear : expYear
  const now = new Date()
  const expired =
    year < now.getUTCFullYear() ||
    (year === now.getUTCFullYear() && expMonth < now.getUTCMonth() + 1)
  if (year > now.getUTCFullYear() + 50 || expired)
    throw cardError({
      code: "invalid_expiry_year",
      message: "Your card's expiration year is invalid.",
      param: `${param}[exp_year]`,
    })
  const brand = brandOf(digits)
  if (cvc !== undefined && cvc !== "") {
    const expected = brand === "amex" ? 4 : 3
    if (!new RegExp(`^\\d{${expected}}$`).test(cvc))
      throw cardError({
        code: "invalid_cvc",
        message: "Your card's security code is invalid.",
        param: `${param}[cvc]`,
      })
  }
  return {
    brand,
    country: "US",
    cvc_check: cvc ? "pass" : "unchecked",
    exp_month: expMonth,
    exp_year: year,
    fingerprint: opaqueToken(`card:${digits}`, 16),
    funding,
    last4: digits.slice(-4),
    outcome: outcomeOf(digits),
  }
}

export const renderCard = (card: CardDetails) => ({
  brand: card.brand,
  checks: {
    address_line1_check: null,
    address_postal_code_check: null,
    cvc_check: card.cvc_check,
  },
  country: card.country,
  display_brand: card.brand,
  exp_month: card.exp_month,
  exp_year: card.exp_year,
  fingerprint: card.fingerprint,
  funding: card.funding,
  generated_from: null,
  last4: card.last4,
  networks: { available: [card.brand], preferred: null },
  regulated_status: "unregulated",
  three_d_secure_usage: { supported: true },
  wallet: null,
})
