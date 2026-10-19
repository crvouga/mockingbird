import type { StripeWebhookEvent } from "./internal.js"

/** A per-customer hold, set with `PUT /__admin/payment-holds/:customer`. */
export type PaymentHold = {
  customer: string
  /** Webhooks whose `data.object.customer` is this customer wait for the release. */
  webhooks: boolean
  /** Secret-key reads filtered by this customer, or of an intent it owns, answer 503 `api_error`. */
  lookups: boolean
}

/** An event waiting for its customer's release, with the time it would have been signed at. */
export type HeldEvent = {
  event: StripeWebhookEvent
  customer: string
  /** Unix seconds the `Stripe-Signature` timestamp is pinned to when the event is released. */
  signedAt: number
}

/** The customer an event's object belongs to (`data.object.customer`, an id or an expanded object). */
export const customerOfEvent = (event: StripeWebhookEvent): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(event.body)
  } catch {
    return undefined
  }
  const object = (parsed as { data?: { object?: { customer?: unknown } } } | null)?.data?.object
  const customer = object?.customer
  if (typeof customer === "string") return customer
  const id = (customer as { id?: unknown } | null | undefined)?.id
  return typeof id === "string" ? id : undefined
}

/**
 * Customers whose payments are "in flight": their webhooks are held back, in order, until released,
 * and the reads that would reveal the outcome fail. One registry per namespace.
 */
export class PaymentHolds {
  private readonly holds = new Map<string, PaymentHold>()
  private queue: HeldEvent[] = []

  set(customer: string, hold: Omit<PaymentHold, "customer">): PaymentHold {
    const next = { customer, ...hold }
    this.holds.set(customer, next)
    return next
  }

  list(): Array<PaymentHold & { held: Array<{ id: string; type: string }> }> {
    return [...this.holds.values()].map((hold) => ({
      ...hold,
      held: this.queue
        .filter((entry) => entry.customer === hold.customer)
        .map((entry) => ({ id: entry.event.id, type: entry.event.type })),
    }))
  }

  has(customer: string): boolean {
    return this.holds.has(customer)
  }

  /** Whether any hold exists, so the common case skips parsing event bodies. */
  get active(): boolean {
    return this.holds.size > 0
  }

  /** The held customer an event belongs to, when its webhooks are held. */
  webhookHold(event: StripeWebhookEvent): string | undefined {
    if (!this.holds.size) return undefined
    const customer = customerOfEvent(event)
    return customer !== undefined && this.holds.get(customer)?.webhooks ? customer : undefined
  }

  holdsLookups(customer: string | null | undefined): boolean {
    return customer !== null && customer !== undefined && this.holds.get(customer)?.lookups === true
  }

  enqueue(entry: HeldEvent): void {
    this.queue.push(entry)
  }

  /** End the hold. The customer's queued events, oldest first, are returned to be delivered. */
  release(customer: string): HeldEvent[] {
    return this.take(customer)
  }

  /** End the hold and forget the queued events (they stay in `GET /v1/events`). */
  discard(customer: string): number {
    return this.take(customer).length
  }

  clear(): void {
    this.holds.clear()
    this.queue = []
  }

  private take(customer: string): HeldEvent[] {
    this.holds.delete(customer)
    const taken = this.queue.filter((entry) => entry.customer === customer)
    this.queue = this.queue.filter((entry) => entry.customer !== customer)
    return taken
  }
}

/**
 * The `Stripe-Signature` timestamp a released event keeps for its first delivery to each endpoint;
 * retries are signed afresh, as Stripe does.
 */
export class SigningPins {
  private readonly signedAt = new Map<string, number>()
  private readonly signedOnce = new Set<string>()

  pin(messageId: string, seconds: number): void {
    this.signedAt.set(messageId, seconds)
  }

  /** The pinned timestamp for a message's first signing at this URL; `undefined` once used or unpinned. */
  firstSigning(messageId: string, url: string): number | undefined {
    const pinned = this.signedAt.get(messageId)
    const key = `${messageId}\u0000${url}`
    if (pinned === undefined || this.signedOnce.has(key)) return undefined
    this.signedOnce.add(key)
    return pinned
  }

  clear(): void {
    this.signedAt.clear()
    this.signedOnce.clear()
  }
}
