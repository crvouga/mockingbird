import { createHmac } from "node:crypto"
import { document } from "./generated/openapi.js"
import type { StripeState } from "./state.js"

export const STRIPE_VERSION = document.info.version

export const signWebhook = (secret: string, payload: string, timestamp: number) => {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")
  return `t=${timestamp},v1=${digest}`
}

const deliverable = (url: string) => {
  try {
    const host = new URL(url).hostname
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")
  } catch {
    return false
  }
}

const subscribed = (events: string[], type: string) => events.includes("*") || events.includes(type)

/**
 * Record an event and, for loopback webhook endpoints, deliver a signed POST before returning.
 * Delivery stays on loopback so random parity URLs never leave the process.
 */
export const recordEvent = async (
  state: StripeState,
  type: string,
  object: Record<string, unknown>,
  created: number,
  idempotencyKey: string | null = null,
) => {
  const endpoints = await state.webhookEndpoints.list({
    where: (endpoint) => endpoint.status === "enabled" && subscribed(endpoint.enabled_events, type),
  })
  const id = await state.ids.next("evt_")
  const event = {
    id,
    object: "event",
    api_version: STRIPE_VERSION,
    created,
    data: { object },
    livemode: false,
    pending_webhooks: endpoints.length,
    request: { id: null, idempotency_key: idempotencyKey },
    type,
  }
  await state.events.insert(id, {
    id,
    api_version: STRIPE_VERSION,
    created,
    data: { object },
    pending_webhooks: endpoints.length,
    request: { id: null, idempotency_key: idempotencyKey },
    type,
  })
  const payload = JSON.stringify(event)
  for (const endpoint of endpoints) {
    if (!deliverable(endpoint.value.url)) continue
    const header = signWebhook(endpoint.value.secret, payload, created)
    try {
      await fetch(endpoint.value.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": header,
        },
        body: payload,
        signal: AbortSignal.timeout(1500),
      })
    } catch {
      // The endpoint is optional. A refused loopback delivery must not fail the API call.
    }
  }
  return event
}
