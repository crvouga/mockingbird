import { createRuntime, type StripeWebhookEvent } from "@crvouga/mockingbird-service-stripe"
import type { HostedFlowStep } from "../../app/ports/hostedFlow.js"
import type {
  CreateCheckoutSessionInput,
  HostedCheckoutResult,
  PaymentsClient,
  PaymentsEvent,
} from "../../app/ports/paymentsClient.js"

const ACCOUNT_ID = "acct_cove_demo"
const SECRET_KEY = "sk_test_cove_demo"
const WEBHOOK_SECRET = "whsec_cove_demo"
const BASE_URL = "https://api.stripe.mock"

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const signWebhookPayload = async (payload: string, secret: string): Promise<string> => {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = await hmacSha256Hex(secret, `${timestamp}.${payload}`)
  return `t=${timestamp},v1=${digest}`
}

const verifyWebhookSignature = async (
  payload: string,
  header: string | null,
  secret: string,
): Promise<boolean> => {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(",").map((pair) => pair.split("=") as [string, string]),
  )
  if (!parts.t || !parts.v1) return false
  const expected = await hmacSha256Hex(secret, `${parts.t}.${payload}`)
  return expected === parts.v1
}

/**
 * Implements `PaymentsClient` against Mockingbird's in-process Stripe mock.
 * The mock already ships a real, functional hosted checkout page at
 * `GET/POST /c/pay/:sessionId` (card entry, decline handling, and a real
 * redirect to `success_url`/`cancel_url` on completion) — no extension of
 * the package was needed for this.
 */
export const createStripeMockPayments = (params: {
  dispatch: (request: Request) => Promise<Response>
  webhookUrl: string
}): PaymentsClient => {
  const stripe = createRuntime({
    accounts: [{ id: ACCOUNT_ID, keys: [SECRET_KEY] }],
    onWebhook: (event: StripeWebhookEvent) => {
      if (event.type !== "checkout.session.completed") return
      void deliverWebhook(event.body)
    },
  })

  const deliverWebhook = async (payload: string): Promise<void> => {
    const signature = await signWebhookPayload(payload, WEBHOOK_SECRET)
    await params.dispatch(
      new Request(params.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: payload,
      }),
    )
  }

  const createCheckoutSession = async (input: CreateCheckoutSessionInput) => {
    const form: Record<string, string> = {
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }
    for (const [key, value] of Object.entries(input.metadata)) form[`metadata[${key}]`] = value
    input.lineItems.forEach((item, index) => {
      form[`line_items[${index}][price_data][currency]`] = "usd"
      form[`line_items[${index}][price_data][unit_amount]`] = String(item.unitAmountCents)
      form[`line_items[${index}][price_data][product_data][name]`] = item.name
      form[`line_items[${index}][quantity]`] = String(item.quantity)
    })

    const response = await stripe.fetch(
      new Request(`${BASE_URL}/v1/checkout/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form),
      }),
    )
    if (!response.ok) throw new Error(`Checkout session creation failed (${response.status})`)
    const session = (await response.json()) as { id: string; url: string }
    return { id: session.id, hostedPageUrl: session.url }
  }

  const constructWebhookEvent = async (
    payload: string,
    signatureHeader: string | null,
  ): Promise<PaymentsEvent> => {
    const valid = await verifyWebhookSignature(payload, signatureHeader, WEBHOOK_SECRET)
    if (!valid) throw new Error("Invalid payments webhook signature")
    const body = JSON.parse(payload) as {
      type: string
      data: { object: { id: string; metadata: Record<string, string> } }
    }
    if (body.type !== "checkout.session.completed") return { type: "unhandled" }
    return {
      type: "checkout.completed",
      checkoutSessionId: body.data.object.id,
      metadata: body.data.object.metadata ?? {},
    }
  }

  const openHostedCheckout = async (
    checkoutSessionId: string,
  ): Promise<HostedFlowStep<HostedCheckoutResult>> => {
    const response = await stripe.fetch(new Request(`${BASE_URL}/c/pay/${checkoutSessionId}`))
    if (!response.ok) return { kind: "error", message: "Could not open the hosted checkout page." }
    return { kind: "html", flowId: checkoutSessionId, html: await response.text() }
  }

  const continueHostedCheckout = async (
    flowId: string,
    action: string,
    method: string,
    body: string,
  ): Promise<HostedFlowStep<HostedCheckoutResult>> => {
    // The hosted page's form has no `action` attribute — per the HTML spec
    // that means "submit to the page's own URL", which is `/c/pay/:flowId`
    // here (`flowId` is the checkout session id throughout this adapter).
    const target = new URL(action || `/c/pay/${flowId}`, BASE_URL)
    const response = await stripe.fetch(
      new Request(target, {
        method,
        headers:
          method.toUpperCase() === "GET"
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" },
        ...(method.toUpperCase() === "GET" ? {} : { body }),
      }),
    )

    const location = response.headers.get("location")
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      return { kind: "done", result: { redirectedTo: new URL(location, BASE_URL).toString() } }
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("text/html"))
      return { kind: "html", flowId, html: await response.text() }
    return { kind: "error", message: `Payment failed (${response.status}).` }
  }

  return {
    createCheckoutSession,
    constructWebhookEvent,
    openHostedCheckout,
    continueHostedCheckout,
  }
}
