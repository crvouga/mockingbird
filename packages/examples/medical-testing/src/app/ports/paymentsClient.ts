import type { HostedFlowStep } from "./hostedFlow.js"

export type CheckoutLineItem = { name: string; unitAmountCents: number; quantity: number }

export type CreateCheckoutSessionInput = {
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
  lineItems: CheckoutLineItem[]
}

export type CheckoutSession = { id: string; hostedPageUrl: string }

export type CheckoutCompletedEvent = {
  type: "checkout.completed"
  checkoutSessionId: string
  metadata: Record<string, string>
}
export type PaymentsEvent = CheckoutCompletedEvent | { type: "unhandled" }

export type HostedCheckoutResult = { redirectedTo: string }

/**
 * A payments provider's checkout + webhook surface, shaped after real
 * hosted-checkout integrations (Stripe Checkout and friends): create a
 * session, send the shopper to its hosted page, and later receive an
 * asynchronously-delivered, signature-verified webhook confirming payment.
 */
export interface PaymentsClient {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession>

  /** Verifies and parses an inbound webhook payload — throws on a bad/missing signature. */
  constructWebhookEvent(payload: string, signatureHeader: string | null): Promise<PaymentsEvent>

  /** Opens a checkout session's hosted payment page. */
  openHostedCheckout(checkoutSessionId: string): Promise<HostedFlowStep<HostedCheckoutResult>>
  continueHostedCheckout(
    flowId: string,
    action: string,
    method: string,
    body: string,
  ): Promise<HostedFlowStep<HostedCheckoutResult>>
}
