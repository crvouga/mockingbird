import { opaqueToken } from "@crvouga/mockingbird-service"
import { type JunctionWebhookEvent, WEBHOOK_RETRY_DELAYS_MS } from "./state.js"

/**
 * Signed webhook delivery, the way Junction delivers through Svix.
 *
 * Signing lives here, next to the events, so a consumer never hand-rolls it. The
 * signature is standard Svix — `v1,` + base64 HMAC-SHA256, keyed by the base64 part of
 * `whsec_…`, over `"<svix-id>.<svix-timestamp>.<body>"` — so the official `svix`
 * verifier, and a receiver written for real Junction webhooks, accept it unchanged.
 */
export type WebhookEndpoint = {
  url: string
  /** Svix signing secret, `whsec_<base64>`. A bare base64 secret is accepted too. */
  secret: string
  /**
   * Delay before each attempt, in ms; the first entry delays the first attempt. Default:
   * Svix's schedule (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h).
   */
  retryDelaysMs?: readonly number[]
  /** Abort an attempt that takes longer than this. Default 15 s, like Svix. */
  timeoutMs?: number
  /** Added to every delivery, e.g. a routing scope for a shared receiver. */
  headers?: Record<string, string>
  fetch?: (request: Request) => Promise<Response>
  /** Injectable wall clock for signatures and delivery records. */
  now?: () => number
  /** Injectable scheduler for timeouts and retry delays. */
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

export type WebhookAttempt = {
  attempt: number
  /** Wall-clock time of the attempt, ISO-8601. */
  at: string
  /** Receiver's status code, or `null` when the request never completed. */
  status: number | null
  error: string | null
  durationMs: number
}

export type WebhookDelivery = {
  messageId: string
  namespace: string
  event: JunctionWebhookEvent
  state: "pending" | "delivered" | "failed"
  attempts: WebhookAttempt[]
}

export type WebhookDispatcher = {
  /** Queue an event for delivery. Returns immediately; delivery runs in the background. */
  publish(event: JunctionWebhookEvent, namespace: string): WebhookDelivery
  deliveries(namespace?: string): WebhookDelivery[]
  /** Deliver a message again now, as a new attempt, whatever its state. */
  replay(messageId: string): Promise<WebhookDelivery | undefined>
  /** Run every pending retry now instead of waiting out its delay. */
  flush(): Promise<void>
  /** Resolve once no delivery is in flight. */
  idle(): Promise<void>
  /** Cancel pending retries and forget every delivery. */
  clear(namespace?: string): void
}

const encoder = new TextEncoder()

const base64 = (bytes: ArrayBuffer): string => {
  let binary = ""
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const secretBytes = (secret: string): Uint8Array => {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  try {
    return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0))
  } catch {
    throw new TypeError("webhook secret must be whsec_<base64> (as Svix issues it)")
  }
}

/** The `svix-signature` value for one message: `v1,<base64 HMAC-SHA256>`. */
export const signSvix = async (
  secret: string,
  messageId: string,
  timestampSeconds: number,
  body: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${messageId}.${timestampSeconds}.${body}`),
  )
  return `v1,${base64(signed)}`
}

/**
 * Check a delivery's signature the way the `svix` verifier does: any `v1,` entry in the
 * space-separated header matches, and the timestamp is within `toleranceSeconds`.
 */
export const verifySvix = async (
  secret: string,
  headers: { "svix-id": string; "svix-timestamp": string; "svix-signature": string },
  body: string,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): Promise<boolean> => {
  const timestamp = Number.parseInt(headers["svix-timestamp"], 10)
  if (!Number.isFinite(timestamp)) return false
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000)
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? 300)) return false
  const expected = await signSvix(secret, headers["svix-id"], timestamp, body)
  return headers["svix-signature"].split(" ").some((entry) => entry === expected)
}

type Pending = { delivery: WebhookDelivery; timer: unknown | undefined }

/** Keep a long retry from holding the process open, where the runtime supports it. */
const unref = (timer: unknown) => {
  ;(timer as { unref?: () => void }).unref?.()
}

export const createWebhookDispatcher = (endpoint: WebhookEndpoint): WebhookDispatcher => {
  // Validate up front so a bad secret fails at boot, not on the first event.
  secretBytes(endpoint.secret)
  const delays = endpoint.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS
  const timeoutMs = endpoint.timeoutMs ?? 15_000
  const send = endpoint.fetch ?? ((request: Request) => fetch(request))
  const now = endpoint.now ?? Date.now
  const scheduleTimer =
    endpoint.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const cancel =
    endpoint.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const deliveries = new Map<string, WebhookDelivery>()
  const pending = new Map<string, Pending>()
  const inFlight = new Set<Promise<void>>()
  let sequence = 0

  const attempt = async (delivery: WebhookDelivery): Promise<boolean> => {
    const body = JSON.stringify(delivery.event)
    // Wall-clock, never the mock clock: receivers reject timestamps outside ~5 minutes
    // of their own clock, and an advanced mock clock would fail every delivery.
    const timestamp = Math.floor(now() / 1000)
    const started = now()
    const record: WebhookAttempt = {
      attempt: delivery.attempts.length + 1,
      at: new Date(started).toISOString(),
      status: null,
      error: null,
      durationMs: 0,
    }
    const controller = new AbortController()
    const timer = scheduleTimer(() => controller.abort(), timeoutMs)
    try {
      const response = await send(
        new Request(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...endpoint.headers,
            "svix-id": delivery.messageId,
            "svix-timestamp": String(timestamp),
            "svix-signature": await signSvix(endpoint.secret, delivery.messageId, timestamp, body),
          },
          body,
          signal: controller.signal,
        }),
      )
      record.status = response.status
      await response.body?.cancel()
    } catch (error) {
      record.error = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
    } finally {
      cancel(timer)
      record.durationMs = now() - started
      delivery.attempts.push(record)
    }
    // Svix treats any 2xx as delivered and retries everything else.
    return record.status !== null && record.status >= 200 && record.status < 300
  }

  const track = (work: Promise<void>) => {
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  }

  const schedule = (delivery: WebhookDelivery) => {
    const index = delivery.attempts.length
    if (index >= delays.length) {
      delivery.state = "failed"
      pending.delete(delivery.messageId)
      return
    }
    const run = () => {
      pending.delete(delivery.messageId)
      track(
        attempt(delivery).then((ok) => {
          if (ok) delivery.state = "delivered"
          else schedule(delivery)
        }),
      )
    }
    const delay = delays[index] ?? 0
    if (delay <= 0) {
      run()
      return
    }
    const timer = scheduleTimer(run, delay)
    unref(timer)
    pending.set(delivery.messageId, { delivery, timer })
  }

  return {
    publish(event, namespace) {
      sequence++
      const delivery: WebhookDelivery = {
        messageId: `msg_${opaqueToken(`junction:webhook:${namespace}:${sequence}`, 27)}`,
        namespace,
        event,
        state: "pending",
        attempts: [],
      }
      deliveries.set(delivery.messageId, delivery)
      schedule(delivery)
      return delivery
    },
    deliveries: (namespace) =>
      [...deliveries.values()].filter((d) => namespace === undefined || d.namespace === namespace),
    async replay(messageId) {
      const delivery = deliveries.get(messageId)
      if (!delivery) return undefined
      const queued = pending.get(messageId)
      if (queued?.timer !== undefined) cancel(queued.timer)
      pending.delete(messageId)
      const ok = await attempt(delivery)
      delivery.state = ok ? "delivered" : "failed"
      return delivery
    },
    async flush() {
      for (const [id, queued] of [...pending]) {
        if (queued.timer !== undefined) cancel(queued.timer)
        pending.delete(id)
        track(
          attempt(queued.delivery).then((ok) => {
            if (ok) queued.delivery.state = "delivered"
            else schedule(queued.delivery)
          }),
        )
      }
      await Promise.all([...inFlight])
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    clear(namespace) {
      for (const [id, delivery] of [...deliveries]) {
        if (namespace !== undefined && delivery.namespace !== namespace) continue
        const queued = pending.get(id)
        if (queued?.timer !== undefined) cancel(queued.timer)
        pending.delete(id)
        deliveries.delete(id)
      }
    },
  }
}
