/**
 * A reference Paddle integration, the shape most SaaS backends take: the official SDK for the
 * catalog and customer calls, a transaction handed to Paddle.js for checkout, and a webhook
 * handler that verifies `Paddle-Signature` with the SDK and turns subscription events into
 * entitlements. There is no in-repo consumer for Paddle yet; this port is what the acceptance
 * tests drive, and what an agent integrating Paddle can copy.
 */
import { type Environment, Paddle, type Subscription } from "@paddle/paddle-node-sdk"

export type Plan = "free" | "starter" | "pro"

export type Entitlement = {
  customerId: string
  plan: Plan
  status: "active" | "trialing" | "past_due" | "paused" | "canceled"
  renewsAt: string | null
  cancelAt: string | null
}

export class PaddleBilling {
  readonly paddle: Paddle
  readonly entitlements = new Map<string, Entitlement>()

  constructor(
    private readonly config: {
      apiKey: string
      baseUrl: string
      webhookSecret: string
      plans: Record<string, Plan>
    },
  ) {
    // The SDK maps `environment` to a base URL and otherwise uses the value verbatim, so a mock
    // (or a proxy) is addressed by passing its URL as the environment.
    this.paddle = new Paddle(config.apiKey, { environment: config.baseUrl as Environment })
  }

  /** The Paddle customer for an app user: found by email, or created. */
  async ensureCustomer(email: string, name?: string) {
    for await (const customer of this.paddle.customers.list({ email: [email] })) return customer
    return this.paddle.customers.create({ email, ...(name ? { name } : {}) })
  }

  /** A transaction for Paddle.js to open (`Paddle.Checkout.open({ transactionId })`). */
  async startCheckout(input: {
    email: string
    priceId: string
    quantity?: number
    userId: string
  }) {
    const customer = await this.ensureCustomer(input.email)
    return this.paddle.transactions.create({
      items: [{ priceId: input.priceId, quantity: input.quantity ?? 1 }],
      customerId: customer.id,
      customData: { user_id: input.userId },
    })
  }

  /** Cancel at the end of the paid period (the safe default in a customer portal). */
  cancelAtPeriodEnd(subscriptionId: string) {
    return this.paddle.subscriptions.cancel(subscriptionId, {
      effectiveFrom: "next_billing_period",
    })
  }

  /** Verify a notification and apply it. Returns the event type handled, or null when ignored. */
  async handleWebhook(rawBody: string, signature: string | null): Promise<string | null> {
    if (!signature) throw new Error("missing Paddle-Signature")
    const event = await this.paddle.webhooks.unmarshal(
      rawBody,
      this.config.webhookSecret,
      signature,
    )
    if (!event) return null
    if (event.eventType.startsWith("subscription.")) {
      this.applySubscription(event.data as Subscription)
      return event.eventType
    }
    return null
  }

  private applySubscription(subscription: Subscription) {
    const priceId = subscription.items.find((item) => item.recurring)?.price?.id ?? ""
    const plan = this.config.plans[priceId] ?? "free"
    const canceled = subscription.status === "canceled"
    this.entitlements.set(subscription.customerId, {
      customerId: subscription.customerId,
      plan: canceled ? "free" : plan,
      status: subscription.status,
      renewsAt: subscription.nextBilledAt,
      cancelAt:
        subscription.scheduledChange?.action === "cancel"
          ? subscription.scheduledChange.effectiveAt
          : null,
    })
  }
}
