import type { ExploreRng, ExploreState, LogicalCommand } from "@crvouga/mockingbird-commands"
import {
  QA_AMOUNTS,
  QA_COUPON_CODES,
  QA_CUSTOMER,
  QA_METADATA,
  QA_SEARCH_QUERIES,
  QA_TEST_PAYMENT_METHODS,
} from "./qa-corpus.js"

type RecordValue = Record<string, unknown>
type Pick = <T>(values: readonly T[], rng: ExploreRng) => T | undefined

const pick: Pick = (values, rng) => values[rng.nextInt(Math.max(0, values.length - 1))]

const asRecord = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined

const withBody = (command: LogicalCommand, body: RecordValue): LogicalCommand => ({
  ...command,
  body,
  invalid: undefined,
})

/**
 * Pin sampled commands onto the values the QA suites actually send, so offline seedParity walks
 * stay deterministic and hit the same code paths a real run does: amounts and currency from the
 * corpus, the metadata keys the backend reads, and the documented test payment methods.
 */
export const reshapeQaCommand = (
  command: LogicalCommand,
  _state: ExploreState,
  rng: ExploreRng,
): LogicalCommand => {
  const id = command.operationId
  const body = asRecord(command.body)
  const parameters = asRecord(command.parameters)
  const next: RecordValue = body === undefined ? {} : { ...body }

  if (next.currency === undefined || next.currency === "") next.currency = "usd"

  if (id === "PostCustomers") {
    next.email = QA_CUSTOMER.email
    next.name = QA_CUSTOMER.name
    next.phone = QA_CUSTOMER.phone
    return withBody(command, { ...next, metadata: { ...QA_METADATA } })
  }

  if (id === "PostPaymentIntents" || id === "PostPaymentIntentsIntent") {
    const amount = pick(QA_AMOUNTS, rng)
    if (amount !== undefined) next.amount = amount
    next.metadata = { ...QA_METADATA }
    const method = pick(QA_TEST_PAYMENT_METHODS, rng)
    if (method !== undefined) {
      next.payment_method = method
      next.confirm = true
    }
    return withBody(command, next)
  }

  if (id === "PostPaymentIntentsIntentConfirm") {
    const method = pick(QA_TEST_PAYMENT_METHODS, rng)
    if (method !== undefined) next.payment_method = method
    return withBody(command, next)
  }

  if (id === "PostSubscriptions") {
    const amount = pick(QA_AMOUNTS, rng)
    void amount
    return withBody(command, {
      ...next,
      metadata: { ...QA_METADATA },
      payment_behavior: "allow_incomplete",
    })
  }

  if (id === "PostSubscriptionsSubscriptionExposedId") {
    return withBody(command, { ...next, metadata: { ...QA_METADATA } })
  }

  if (id === "PostPrices") {
    next.currency = "usd"
    next.recurring = { interval: "month", interval_count: 1 }
    return withBody(command, next)
  }

  if (id === "PostCoupons") {
    next.duration = "once"
    next.currency = "usd"
    const amount = pick(QA_AMOUNTS, rng)
    if (amount !== undefined) next.amount_off = amount
    delete next.percent_off
    return withBody(command, next)
  }

  if (id === "PostPromotionCodes") {
    const code = pick(QA_COUPON_CODES, rng)
    if (code !== undefined) next.code = code
    return withBody(command, next)
  }

  if (id === "PostInvoiceitems") {
    const amount = pick(QA_AMOUNTS, rng)
    if (amount !== undefined) next.amount = amount
    return withBody(command, next)
  }

  if (id === "PostCheckoutSessions") {
    next.mode = "payment"
    next.currency = "usd"
    return withBody(command, next)
  }

  if (
    id === "GetCustomersSearch" ||
    id === "GetPaymentIntentsSearch" ||
    id === "GetProductsSearch"
  ) {
    const query = pick(QA_SEARCH_QUERIES, rng)
    if (query === undefined) return command
    return { ...command, parameters: { ...(parameters ?? {}), query } }
  }

  if (body === undefined) return command
  return withBody(command, next)
}
