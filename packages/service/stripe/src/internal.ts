import { faultEffect, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import type { AccountDirectory } from "./accounts.js"
import { requestInfo } from "./context.js"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { mergeMetadata } from "./fields.js"
import { shapeForEra } from "./shape.js"
import {
  type AccountState,
  type CustomerEntry,
  type CustomerRecord,
  type Metadata,
  type PriceRecord,
  type StripeState,
  seconds,
} from "./state.js"
import { type ApiEra, eraOf } from "./version.js"

type RecordValue = Record<string, unknown>

/** What the server publishes when the mock records an event: the exact bytes to deliver. */
export type StripeWebhookEvent = {
  /** `evt_…`, the id receivers dedupe on. */
  id: string
  type: string
  /** The account partition the event belongs to (webhook endpoints are tagged with it). */
  account: string
  /** The JSON event, rendered at the account's webhook API version. */
  body: string
}

export type WebhookPublisher = (event: StripeWebhookEvent) => void

export type Services = {
  state: StripeState
  publish: WebhookPublisher | undefined
  accounts: AccountDirectory
  /** Version webhook payloads render at, per account. */
  deliveryVersion: (account: string) => string
  /** How many endpoints an event of this account will be delivered to (`pending_webhooks`). */
  pendingWebhooks: (account: string, type: string) => number
  /** Path prefix that selects this instance's namespace (`/ns/<name>`), or `""`. */
  namespacePrefix: string
  /** Public base URL override for hosted pages; defaults to the caller's origin. */
  publicUrl: string | undefined
  /** Webhook endpoints created or changed through the API (the runtime re-derives fan-out). */
  endpointsChanged?: () => void
}

/** Everything a handler needs, resolved once per request (or per clock tick). */
export type RequestScope = {
  services: Services
  account: AccountState
  ids: StripeState["ids"]
  /** The mock clock, in ms. */
  now: () => number
  era: ApiEra
  /** Public base URL of this namespace's hosted pages, e.g. `http://127.0.0.1:12111/ns/w1`. */
  base: string
  /** Parameters of a fault effect that fired for this request, if it did. */
  effect: (name: string) => Record<string, unknown> | undefined
  emit: (type: string, object: RecordValue, previous?: RecordValue) => string
}

const eventRequest = (id: string | null, idempotencyKey: string | null) => ({
  id,
  idempotency_key: idempotencyKey,
})

/**
 * Record an event in the account's ledger (feeding `GET /v1/events`) and hand the webhook
 * payload to the publisher. The ledger keeps the full rendering, so `GET /v1/events` can shape
 * it for whichever API version reads it; the delivered bytes are shaped for the account's
 * webhook version.
 */
const recordEvent = (
  services: Services,
  account: AccountState,
  now: () => number,
  request: { id: string | null; idempotency_key: string | null },
  type: string,
  object: RecordValue,
  previous: RecordValue | undefined,
): string => {
  const { state } = services
  const id = state.ids.next("evt_", 24)
  const created = seconds(now)
  const version = services.deliveryVersion(account.account)
  const data = previous === undefined ? { object } : { object, previous_attributes: previous }
  const payload: RecordValue = {
    id,
    object: "event",
    api_version: version,
    created,
    data,
    livemode: false,
    pending_webhooks: services.pendingWebhooks(account.account, type),
    request,
    type,
  }
  const stored = JSON.stringify(payload)
  const sequence = account.events.nextSequence()
  account.events.insert(String(sequence), {
    id,
    type,
    created,
    account: account.account,
    body: stored,
    data: data as { object: RecordValue; previous_attributes?: RecordValue },
  })
  const body = JSON.stringify(shapeForEra(payload, eraOf(version)))
  // Delivery is best-effort: a failing publisher must never turn the API call into a 500. The
  // event is already in the ledger, so `GET /v1/events` (and a replay sweep) still sees it.
  try {
    services.publish?.({ id, type, account: account.account, body })
  } catch (error) {
    console.error(
      `stripe webhook publisher failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return id
}

export const requestScope = (services: Services, context: OperationContext): RequestScope => {
  const info = requestInfo(context.request)
  const account = services.state.for(info.account)
  const idempotencyKey = context.request.headers.get("idempotency-key")
  let requestId: string | undefined
  return {
    services,
    account,
    ids: services.state.ids,
    now: context.now,
    era: info.era,
    base: services.publicUrl ?? `${info.origin}${services.namespacePrefix}`,
    effect: (name) => faultEffect(context.request, name),
    emit: (type, object, previous) => {
      requestId ??= services.state.ids.next("req_")
      return recordEvent(
        services,
        account,
        context.now,
        eventRequest(requestId, idempotencyKey),
        type,
        object,
        previous,
      )
    },
  }
}

/** A request's scope, acting on an account found by object id (browser pages, 3-D Secure). */
export const scopeForAccount = (
  services: Services,
  context: OperationContext,
  account: string,
): RequestScope => {
  const info = requestInfo(context.request)
  const partition = services.state.for(account)
  return {
    services,
    account: partition,
    ids: services.state.ids,
    now: context.now,
    era: "basil",
    base: services.publicUrl ?? `${info.origin}${services.namespacePrefix}`,
    effect: (name) => faultEffect(context.request, name),
    emit: (type, object, previous) =>
      recordEvent(
        services,
        partition,
        context.now,
        eventRequest(null, null),
        type,
        object,
        previous,
      ),
  }
}

/** A scope for work nobody requested: clock ticks and admin actions. */
export const systemScope = (
  services: Services,
  account: AccountState,
  now: () => number,
  base = services.publicUrl ?? `http://localhost${services.namespacePrefix}`,
): RequestScope => ({
  services,
  account,
  ids: services.state.ids,
  now,
  era: "basil",
  base,
  effect: () => undefined,
  emit: (type, object, previous) =>
    recordEvent(services, account, now, eventRequest(null, null), type, object, previous),
})

/** Every field that changed, in the shape Stripe sends as `data.previous_attributes`. */
export const changedFields = (
  previous: RecordValue,
  next: RecordValue,
): RecordValue | undefined => {
  const changed: RecordValue = {}
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue
    changed[key] = previous[key] ?? null
  }
  return Object.keys(changed).length === 0 ? undefined : changed
}

export const requireLiveCustomer = (scope: RequestScope, id: string, param = "customer") => {
  const entry = scope.account.customers.get(id)
  if (!entry || entry.kind === "deleted") throw resourceMissing("customer", id, param)
  return entry.customer
}

export const findCustomer = (scope: RequestScope, id: string): CustomerRecord | undefined => {
  const entry: CustomerEntry | undefined = scope.account.customers.get(id)
  return entry?.kind === "live" ? entry.customer : undefined
}

export const customerEmail = (scope: RequestScope, id: string | null) =>
  id === null ? null : (findCustomer(scope, id)?.email ?? null)

export const customerName = (scope: RequestScope, id: string | null) =>
  id === null ? null : (findCustomer(scope, id)?.name ?? null)

/**
 * The current time for a customer, in seconds: its test clock's frozen time when it has one,
 * the mock clock otherwise.
 */
export const customerNow = (scope: RequestScope, customerId: string | null): number => {
  if (customerId === null) return seconds(scope.now)
  const clock = findCustomer(scope, customerId)?.test_clock
  if (!clock) return seconds(scope.now)
  return scope.account.testClocks.get(clock)?.frozen_time ?? seconds(scope.now)
}

export const requirePrice = (scope: RequestScope, id: string, param = "price"): PriceRecord => {
  const price = scope.account.prices.get(id)
  if (!price) throw resourceMissing("price", id, param)
  return price
}

/** The amount a price charges for `quantity` units, in cents. */
export const priceAmount = (price: PriceRecord, quantity: number) =>
  Math.round(Number(price.unit_amount_decimal) * quantity)

export const requireIntent = (scope: RequestScope, id: string, param = "intent") => {
  const intent = scope.account.paymentIntents.get(id)
  if (!intent) throw resourceMissing("payment_intent", id, param)
  return intent
}

export const requireCharge = (scope: RequestScope, id: string, param = "charge") => {
  const charge = scope.account.charges.get(id)
  if (!charge) throw resourceMissing("charge", id, param)
  return charge
}

export const requireInvoice = (scope: RequestScope, id: string, param = "invoice") => {
  const invoice = scope.account.invoices.get(id)
  if (!invoice) throw resourceMissing("invoice", id, param)
  return invoice
}

export const requireSubscription = (
  scope: RequestScope,
  id: string,
  param = "subscription_exposed_id",
) => {
  const subscription = scope.account.subscriptions.get(id)
  if (!subscription) throw resourceMissing("subscription", id, param)
  return subscription
}

export const requireSession = (scope: RequestScope, id: string, param = "session") => {
  const session = scope.account.checkoutSessions.get(id)
  if (!session) throw resourceMissing("checkout session", id, param)
  return session
}

export const requireCoupon = (scope: RequestScope, id: string, param = "coupon") => {
  const coupon = scope.account.coupons.get(id)
  if (!coupon) throw resourceMissing("coupon", id, param)
  return coupon
}

/** Apply a customer's balance delta and record the matching balance transaction. */
export const applyBalanceTransaction = (
  scope: RequestScope,
  input: {
    customer: CustomerRecord
    amount: number
    currency: string
    description: string | null
    metadata: Metadata
    type: string
    invoice?: string | null
  },
): { id: string; ending_balance: number } => {
  const id = scope.ids.next("cbtxn_")
  const ending = input.customer.balance + input.amount
  scope.account.customers.update(input.customer.id, {
    kind: "live",
    customer: {
      ...input.customer,
      balance: ending,
      currency: input.customer.currency ?? input.currency,
    },
  })
  scope.account.balanceTransactions.insert(id, {
    id,
    amount: input.amount,
    created: seconds(scope.now),
    credit_note: null,
    currency: input.currency,
    customer: input.customer.id,
    description: input.description,
    ending_balance: ending,
    invoice: input.invoice ?? null,
    metadata: input.metadata,
    type: input.type,
  })
  return { id, ending_balance: ending }
}

/** Metadata merge with Stripe's `""`-clears semantics. */
export const mergeRecordMetadata = (current: Metadata, incoming: unknown): Metadata =>
  incoming === undefined ? current : mergeMetadata(current, incoming)

export const requireParam = (params: RecordValue, key: string): string => {
  const value = params[key]
  if (typeof value !== "string" || value === "") throw parameterMissing(key)
  return value
}

export const stringOf = (params: RecordValue, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

export const intOf = (value: unknown): number | undefined => {
  if (value === undefined || value === "" || value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

export const booleanOf = (value: unknown): boolean | undefined =>
  value === true || value === "true"
    ? true
    : value === false || value === "false"
      ? false
      : undefined

export const recordOf = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined

/** `<id>_secret_<opaque>`: callers recover the intent id by splitting on `_secret_`. */
export const clientSecretFor = (id: string) => `${id}_secret_${opaqueToken(`${id}:secret`, 24)}`

/** Ensure a Stripe id-like path segment names something in this account. */
export const assertFound = <T>(
  value: T | undefined,
  kind: string,
  id: string,
  param: string,
): T => {
  if (value === undefined) throw resourceMissing(kind, id, param)
  return value
}

/** Stripe rejects an unknown enum value with this sentence shape. */
export const invalidEnum = (param: string, allowed: readonly string[]) =>
  invalidRequest(`Invalid ${param}: must be one of ${allowed.join(", ")}`, param)
