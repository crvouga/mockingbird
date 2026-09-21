import { opaqueToken } from "@crvouga/mockingbird-service"
import { cardError, invalidRequest, resourceMissing, stateError } from "./errors.js"
import { type RequestScope, requireLiveCustomer } from "./internal.js"
import { renderCharge, renderDispute, renderPaymentIntent, renderPaymentMethod } from "./render.js"
import {
  type ChargeRecord,
  type Metadata,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  seconds,
} from "./state.js"
import {
  AUTHENTICATION_REQUIRED,
  type CardDetails,
  cardDetailsFor,
  chargeOutcomeFor,
  type DeclineOutcome,
  detailsForNumber,
  disputesOnCharge,
  EXPIRED_CARD,
  GENERIC_DECLINE,
  INSUFFICIENT_FUNDS,
  isMagicPaymentMethod,
  luhnValid,
  testInstrument,
} from "./test-tokens.js"

type RecordValue = Record<string, unknown>

export const REUSE_AFTER_CONSUMED =
  "The provided PaymentMethod was previously used with a PaymentIntent without Customer attachment, shared with a connected account without Customer attachment, or was detached from a Customer. It may not be used again. To use a PaymentMethod multiple times, you must attach it to a Customer first."

export const ATTACH_AFTER_CONSUMED =
  "This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again."

export const DETACH_UNATTACHED =
  "The payment method you provided is not attached to a customer so detachment is impossible."

export const cardPayload = (details: CardDetails, seed: string): RecordValue => ({
  brand: details.brand,
  checks: details.checks,
  country: details.country,
  display_brand: details.brand,
  exp_month: details.exp_month,
  exp_year: details.exp_year,
  fingerprint: opaqueToken(`card:${seed}`, 16),
  funding: details.funding,
  generated_from: null,
  iin: details.iin,
  issuer: details.issuer,
  last4: details.last4,
  networks: { available: [details.brand], preferred: null },
  regulated_status: "unregulated",
  three_d_secure_usage: { supported: true },
  wallet: null,
})

const EMPTY_BILLING_DETAILS = {
  address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
  email: null,
  name: null,
  phone: null,
  tax_id: null,
}

/** A new card payment method for a test token (never a card number: only its token). */
export const newPaymentMethod = (
  scope: RequestScope,
  token: string,
  details: CardDetails = cardDetailsFor(token),
  extra: { billing_details?: RecordValue; metadata?: Metadata } = {},
): PaymentMethodRecord => {
  const id = scope.ids.next("pm_", 24)
  const record: PaymentMethodRecord = {
    id,
    type: "card",
    created: seconds(scope.now),
    customer: null,
    billing_details: { ...EMPTY_BILLING_DETAILS, ...extra.billing_details },
    card: cardPayload(details, `${details.brand}:${details.last4}:${token}`),
    metadata: extra.metadata ?? {},
    token,
  }
  scope.account.paymentMethods.insert(id, record)
  return record
}

/**
 * Resolve a payment method id. Stripe's magic test ids (`pm_card_visa` and friends) resolve to a
 * **new** `pm_` object on every use, exactly as Stripe clones them.
 */
export const resolvePaymentMethod = (
  scope: RequestScope,
  id: string,
  param = "payment_method",
): PaymentMethodRecord => {
  if (isMagicPaymentMethod(id)) return newPaymentMethod(scope, testInstrument(id) as string)
  const existing = scope.account.paymentMethods.get(id)
  if (!existing) throw resourceMissing("PaymentMethod", id, param)
  return existing
}

/** `card[token]=tok_visa` → a new payment method. */
export const paymentMethodFromToken = (scope: RequestScope, token: string): PaymentMethodRecord => {
  const known = testInstrument(token)
  if (!known || !token.startsWith("tok_"))
    throw invalidRequest(`No such token: '${token}'`, "card[token]", "resource_missing")
  return newPaymentMethod(scope, known)
}

/**
 * Raw card details (the hosted page and the Stripe.js stand-in send them). Only the matching
 * test token, brand and last four digits are kept; the number itself is never stored.
 */
export const paymentMethodFromCard = (
  scope: RequestScope,
  number: string,
  param = "card[number]",
): PaymentMethodRecord => {
  const digits = number.replace(/[\s-]/g, "")
  if (!luhnValid(digits))
    throw cardError("Your card number is incorrect.", "incorrect_number", "incorrect_number", {
      param,
    })
  const token = testInstrument(digits) ?? "tok_visa"
  return newPaymentMethod(scope, token, detailsForNumber(digits))
}

/** Attach a payment method to a customer, with Stripe's reuse rules. */
export const attachPaymentMethod = (
  scope: RequestScope,
  method: PaymentMethodRecord,
  customerId: string,
): PaymentMethodRecord => {
  requireLiveCustomer(scope, customerId)
  if (method.consumed === true) throw stateError(ATTACH_AFTER_CONSUMED)
  if (method.customer === customerId) return method
  if (method.customer !== null)
    throw invalidRequest(
      `The payment method you provided has already been attached to a customer.`,
      "payment_method",
    )
  const attached: PaymentMethodRecord = { ...method, customer: customerId }
  scope.account.paymentMethods.update(method.id, attached)
  scope.emit("payment_method.attached", renderPaymentMethod(attached))
  return attached
}

const FEE_PERCENT = 0.029
const FEE_FIXED = 30
const AVAILABLE_AFTER = 7 * 86_400

/** A charge's (or refund's) line in the account's balance ledger. */
export const recordBalanceTransaction = (
  scope: RequestScope,
  input: {
    amount: number
    currency: string
    source: string
    type: "charge" | "refund" | "adjustment"
    description: string | null
  },
): string => {
  const id = scope.ids.next("txn_", 24)
  const created = seconds(scope.now)
  const fee = input.type === "charge" ? Math.round(input.amount * FEE_PERCENT) + FEE_FIXED : 0
  scope.account.ledger.insert(id, {
    id,
    amount: input.amount,
    available_on: created + AVAILABLE_AFTER,
    created,
    currency: input.currency,
    description: input.description,
    fee,
    net: input.amount - fee,
    reporting_category: input.type,
    source: input.source,
    status: "pending",
    type: input.type,
  })
  return id
}

const outcomeFor = (decline: DeclineOutcome | undefined): RecordValue =>
  decline === undefined
    ? {
        advice_code: null,
        network_advice_code: null,
        network_decline_code: null,
        network_status: "approved_by_network",
        reason: null,
        risk_level: "normal",
        risk_score: 12,
        seller_message: "Payment complete.",
        type: "authorized",
      }
    : {
        advice_code: decline.advice_code,
        network_advice_code: null,
        network_decline_code: decline.network_decline_code,
        network_status: "declined_by_network",
        reason: decline.decline_code,
        risk_level: "normal",
        risk_score: 1,
        seller_message: "The bank did not return any further details with this decline.",
        type: "issuer_declined",
      }

/** Record a charge; a successful, captured one also lands in the balance ledger. */
export const createCharge = (
  scope: RequestScope,
  input: {
    amount: number
    currency: string
    customer: string | null
    payment_intent: string | null
    method: PaymentMethodRecord | null
    captured?: boolean
    invoice?: string | null
    metadata?: Metadata
    description?: string | null
    decline?: DeclineOutcome
  },
): ChargeRecord => {
  const id = scope.ids.next("ch_", 24)
  const failed = input.decline !== undefined
  const captured = !failed && (input.captured ?? true)
  const record: ChargeRecord = {
    id,
    amount: input.amount,
    amount_captured: captured ? input.amount : 0,
    amount_refunded: 0,
    captured,
    created: seconds(scope.now),
    currency: input.currency,
    customer: input.customer,
    description: input.description ?? null,
    disputed: false,
    invoice: input.invoice ?? null,
    metadata: input.metadata ?? {},
    paid: !failed,
    payment_intent: input.payment_intent,
    payment_method: input.method?.id ?? null,
    refunded: false,
    status: failed ? "failed" : "succeeded",
    refund_ids: [],
    failure_code: input.decline?.code ?? null,
    failure_message: input.decline?.message ?? null,
    outcome: outcomeFor(input.decline),
    balance_transaction: null,
    card: input.method?.card ?? null,
    dispute: null,
  }
  if (captured)
    record.balance_transaction = recordBalanceTransaction(scope, {
      amount: input.amount,
      currency: input.currency,
      source: id,
      type: "charge",
      description: input.description ?? null,
    })
  scope.account.charges.insert(id, record)
  scope.emit(failed ? "charge.failed" : "charge.succeeded", renderCharge(record))
  if (!failed && disputesOnCharge(input.method?.token ?? null))
    openDispute(scope, record, "fraudulent")
  return record
}

/** Open a dispute on a charge (`POST /__admin/disputes`, or the `tok_createDispute` card). */
export const openDispute = (
  scope: RequestScope,
  charge: ChargeRecord,
  reason = "general",
  amount = charge.amount,
  status = "needs_response",
) => {
  const id = scope.ids.next("dp_", 24)
  const dispute = {
    id,
    amount,
    charge: charge.id,
    created: seconds(scope.now),
    currency: charge.currency,
    metadata: {},
    payment_intent: charge.payment_intent,
    reason,
    status,
  }
  scope.account.disputes.insert(id, dispute)
  scope.account.charges.update(charge.id, { ...charge, disputed: true, dispute: id })
  scope.emit("charge.dispute.created", renderDispute(dispute))
  return dispute
}

/** The decline a fault preset forces (`card_declined`), if one fired for this request. */
const forcedDecline = (scope: RequestScope): DeclineOutcome | undefined => {
  const params = scope.effect("card_declined")
  if (params === undefined) return undefined
  const code = typeof params.decline_code === "string" ? params.decline_code : "generic_decline"
  if (code === "insufficient_funds") return INSUFFICIENT_FUNDS
  if (code === "expired_card") return EXPIRED_CARD
  if (code === "authentication_required") return AUTHENTICATION_REQUIRED
  return GENERIC_DECLINE
}

export type ConfirmOptions = {
  /** The customer is not present (`off_session=true`, renewals, invoice payment). */
  offSession: boolean
  /** A 3-D Secure challenge is passed on the spot (the hosted Checkout page). */
  autoAuthenticate?: boolean
}

/**
 * Confirm a PaymentIntent with a payment method: charge the card and move the intent to
 * `succeeded` (or `requires_capture`), `requires_action` for an on-session 3-D Secure card, or
 * record the failed charge and throw Stripe's 402 `card_error`, which embeds the failed intent
 * and payment method exactly as Stripe does.
 */
export const confirmIntent = (
  scope: RequestScope,
  intent: PaymentIntentRecord,
  method: PaymentMethodRecord,
  options: ConfirmOptions,
): PaymentIntentRecord => {
  if (intent.status === "canceled")
    throw invalidRequest(
      "This PaymentIntent's payment_method could not be updated because it has a status of canceled. You may only update the payment_method of a PaymentIntent with one of the following statuses: requires_payment_method, requires_confirmation, requires_action.",
      undefined,
      "payment_intent_unexpected_state",
    )
  if (intent.status === "succeeded")
    throw invalidRequest(
      "You cannot confirm this PaymentIntent because it has already succeeded after being previously confirmed.",
      undefined,
      "payment_intent_unexpected_state",
    )
  if (method.consumed === true) throw invalidRequest(REUSE_AFTER_CONSUMED, "payment_method")
  const outcome = chargeOutcomeFor(method.token)
  const forced = forcedDecline(scope)
  let decline: DeclineOutcome | undefined = forced
  if (decline === undefined) {
    if (outcome.kind === "card_error") decline = outcome
    else if (outcome.kind === "authenticate" && !options.autoAuthenticate) {
      if (options.offSession) {
        if (outcome.offSession === "decline" || method.customer === null)
          decline = AUTHENTICATION_REQUIRED
      } else {
        const waiting: PaymentIntentRecord = {
          ...intent,
          payment_method: method.id,
          status: "requires_action",
          next_action: {
            type: "use_stripe_sdk",
            use_stripe_sdk: {
              type: "three_d_secure_redirect",
              stripe_js: `${scope.base}/c/3ds/${intent.id}/authenticate`,
              source: method.id,
            },
          },
        }
        scope.account.paymentIntents.update(intent.id, waiting)
        scope.emit("payment_intent.requires_action", renderPaymentIntent(waiting))
        return waiting
      }
    }
  }
  if (decline !== undefined) {
    const charge = createCharge(scope, {
      amount: intent.amount,
      currency: intent.currency,
      customer: intent.customer,
      payment_intent: intent.id,
      method,
      invoice: intent.invoice,
      metadata: intent.metadata,
      description: intent.description,
      decline,
    })
    const renderedMethod = renderPaymentMethod(method)
    // Stripe omits the optional codes a decline does not carry (they are never null).
    const lastError = {
      ...(decline.advice_code ? { advice_code: decline.advice_code } : {}),
      charge: charge.id,
      code: decline.code,
      ...(decline.decline_code ? { decline_code: decline.decline_code } : {}),
      doc_url: `https://stripe.com/docs/error-codes/${decline.code.replace(/_/g, "-")}`,
      message: decline.message,
      ...(decline.network_decline_code
        ? { network_decline_code: decline.network_decline_code }
        : {}),
      payment_method: renderedMethod,
      payment_method_type: "card",
      type: "card_error",
    }
    const failed: PaymentIntentRecord = {
      ...intent,
      latest_charge: charge.id,
      payment_method: null,
      status: "requires_payment_method",
      next_action: null,
      last_payment_error: lastError,
      charge_ids: [...intent.charge_ids, charge.id],
    }
    scope.account.paymentIntents.update(intent.id, failed)
    const rendered = renderPaymentIntent(failed)
    scope.emit("payment_intent.payment_failed", rendered)
    throw cardError(decline.message, decline.code, decline.decline_code, {
      advice_code: decline.advice_code,
      charge: charge.id,
      network_decline_code: decline.network_decline_code,
      payment_intent: rendered,
      payment_method: renderedMethod,
    })
  }
  const manual = intent.capture_method === "manual"
  const charge = createCharge(scope, {
    amount: intent.amount,
    currency: intent.currency,
    customer: intent.customer,
    payment_intent: intent.id,
    method,
    invoice: intent.invoice,
    metadata: intent.metadata,
    description: intent.description,
    captured: !manual,
  })
  let saved = method
  if (intent.customer !== null && intent.setup_future_usage !== null && method.customer === null)
    saved = attachPaymentMethod(scope, method, intent.customer)
  else if (method.customer === null) {
    saved = { ...method, consumed: true }
    scope.account.paymentMethods.update(method.id, saved)
  }
  const settled: PaymentIntentRecord = {
    ...intent,
    amount_capturable: manual ? intent.amount : 0,
    amount_received: manual ? 0 : intent.amount,
    last_payment_error: null,
    latest_charge: charge.id,
    next_action: null,
    payment_method: saved.id,
    status: manual ? "requires_capture" : "succeeded",
    charge_ids: [...intent.charge_ids, charge.id],
  }
  scope.account.paymentIntents.update(intent.id, settled)
  scope.emit(
    manual ? "payment_intent.amount_capturable_updated" : "payment_intent.succeeded",
    renderPaymentIntent(settled),
  )
  return settled
}

/** The customer's default payment method, if it has a usable one. */
export const defaultPaymentMethodOf = (
  scope: RequestScope,
  customerId: string | null,
): PaymentMethodRecord | undefined => {
  if (customerId === null) return undefined
  const entry = scope.account.customers.get(customerId)
  if (entry?.kind !== "live") return undefined
  const id = entry.customer.invoice_settings.default_payment_method
  return id === null ? undefined : scope.account.paymentMethods.get(id)
}
