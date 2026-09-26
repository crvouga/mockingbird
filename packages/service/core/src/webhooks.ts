import type { AdminRoutes } from "./control.js"
import { signSvix, signTimestamped, signTwilio } from "./signing.js"

/**
 * Outbound webhooks, shared by every service that has them.
 *
 * A service publishes a message (the exact bytes the vendor would send); the hub fans it out
 * to every matching endpoint, signs each delivery with the vendor's scheme, retries on the
 * vendor's schedule, and keeps a record a suite can read, replay or flush through
 * `/__admin/webhooks*`. Signature timestamps always use the wall clock, never the mock
 * clock: receivers check them against their own time, and an advanced mock clock would
 * otherwise fail every delivery.
 */

/** What a signer sees for one delivery attempt. */
export type SignInput = {
  messageId: string
  /** Exact bytes about to be sent. */
  body: string
  /** Wall-clock unix seconds of this attempt. */
  timestampSeconds: number
  /** Where the delivery is posted. */
  url: string
  /** The endpoint's secret, if it has one. */
  secret: string | undefined
  /** The endpoint's `signUrl` (the public URL the receiver verifies against), else `url`. */
  signUrl: string
  /** Form parameters, when the body is form-encoded (Twilio signs these, not the body). */
  form: Record<string, string> | undefined
  /** Stable event type and metadata captured with the message; avoids signer side-channel state. */
  type: string
  tags: Readonly<Record<string, string>>
}

/** Headers to add to one delivery. */
export type WebhookSigner = (
  input: SignInput,
) => Record<string, string> | Promise<Record<string, string>>

/** Named signers for the vendor schemes the catalog needs. */
export const signers = {
  /** No signature. */
  none: (): WebhookSigner => () => ({}),
  /** Svix (`svix-id`, `svix-timestamp`, `svix-signature: v1,<b64>`): Junction, Flex, Resend. */
  svix:
    (options: { prefix?: "svix" | "webhook" } = {}): WebhookSigner =>
    async ({ messageId, body, timestampSeconds, secret }) => {
      if (!secret) return {}
      const prefix = options.prefix ?? "svix"
      return {
        [`${prefix}-id`]: messageId,
        [`${prefix}-timestamp`]: String(timestampSeconds),
        [`${prefix}-signature`]: await signSvix(secret, messageId, timestampSeconds, body),
      }
    },
  /** `<header>: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`: Stripe, Persona, Fullscript. */
  timestamped:
    (header = "Stripe-Signature"): WebhookSigner =>
    async ({ body, timestampSeconds, secret }) =>
      secret ? { [header]: await signTimestamped(secret, timestampSeconds, body) } : {},
  /** `X-Twilio-Signature` over the public URL plus the sorted form parameters. */
  twilio:
    (): WebhookSigner =>
    async ({ signUrl, form, secret }) =>
      secret ? { "X-Twilio-Signature": await signTwilio(secret, signUrl, form ?? {}) } : {},
  /** The secret itself in a header (optionally templated): RxVortex, Pharmetika, AHA `Token <s>`. */
  header:
    (header: string, format: (secret: string) => string = (s) => s): WebhookSigner =>
    ({ secret }) =>
      secret ? { [header]: format(secret) } : {},
  /** Anything else: the service computes the headers itself. */
  custom: (sign: WebhookSigner): WebhookSigner => sign,
}

export type WebhookEndpoint = {
  /** Stable id; generated when omitted. */
  id?: string
  url: string
  secret?: string
  /** Event types to deliver; omit or include `"*"` for every type. */
  events?: string[]
  /** Deliver only messages whose tags include all of these (e.g. `{ account: "mso" }`). */
  tags?: Record<string, string>
  /** The public URL the receiver verifies signatures against (Twilio), when it differs. */
  signUrl?: string
  headers?: Record<string, string>
}

export type WebhookMessage = {
  id: string
  namespace: string
  type: string
  body: string
  contentType: string
  tags: Record<string, string>
  headers?: Record<string, string>
  /** Wall-clock ISO-8601 time of publication. */
  publishedAt: string
}

export type WebhookAttempt = {
  attempt: number
  at: string
  status: number | null
  error: string | null
  durationMs: number
  /** Exact receiver response body, when one was returned. */
  responseBody?: string | null
}

export type WebhookDelivery = {
  id: string
  messageId: string
  namespace: string
  type: string
  endpointId: string
  url: string
  state: "pending" | "delivered" | "failed" | "dropped"
  attempts: WebhookAttempt[]
}

/** A delivery-level fault: what happens to the next `count` messages in a namespace. */
export type WebhookFault = {
  mode: "duplicate" | "reorder" | "drop"
  /** Messages affected; default 1. */
  count?: number
}

export type PublishInput = {
  namespace: string
  type: string
  /** Exact body; objects are JSON-encoded. */
  body: string | Record<string, unknown> | unknown[]
  /** Default `application/json`, or form-encoded when `form` is given. */
  contentType?: string
  /** Form parameters, when the vendor posts `application/x-www-form-urlencoded`. */
  form?: Record<string, string>
  tags?: Record<string, string>
  /** Message-specific delivery headers, captured as part of durable message state. */
  headers?: Record<string, string>
  /** Message id; generated when omitted. */
  id?: string
}

export type WebhookHubOptions = {
  signer: WebhookSigner
  /**
   * Delay before each attempt, in ms; the first entry delays the first attempt. Default:
   * immediately, then 5 s, 5 min, 30 min, 2 h.
   */
  retryDelaysMs?: readonly number[]
  /** Abort an attempt after this long. Default 15 s. */
  timeoutMs?: number
  /** Which receiver statuses count as delivered. Default 2xx. */
  delivered?: (status: number) => boolean
  /** Endpoints every namespace delivers to (from `--webhook-url`). */
  endpoints?: WebhookEndpoint[]
  fetch?: (request: Request) => Promise<Response>
  /** Called in-process for every published message, delivered or not. */
  onMessage?: (message: WebhookMessage) => void
  /** Messages kept per namespace for `GET /__admin/webhooks/events`. Default 500. */
  keep?: number
  /** Injectable wall clock for signatures and attempt records. */
  now?: () => number
  /** Injectable deterministic identifier source. Receives `"msg_"` or `"dlv_"`. */
  id?: (prefix: string) => string
  /** Injectable scheduler used by timeouts and retries. */
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

export type WebhookHub = {
  publish(input: PublishInput): WebhookMessage
  /** Replace a namespace's own endpoints (`PUT /__admin/webhook-endpoints`). */
  setEndpoints(namespace: string, endpoints: WebhookEndpoint[]): WebhookEndpoint[]
  /** The endpoints a namespace delivers to: its own, plus the global ones. */
  endpoints(namespace: string): WebhookEndpoint[]
  messages(namespace?: string): WebhookMessage[]
  deliveries(namespace?: string): WebhookDelivery[]
  replay(deliveryId: string): Promise<WebhookDelivery | undefined>
  /** Run every pending retry (and release held reordered messages) now, and every retry those attempts schedule, until nothing is pending. */
  flush(): Promise<void>
  /** Resolve once nothing is in flight. */
  idle(): Promise<void>
  fault(namespace: string, fault: WebhookFault): void
  clear(namespace?: string): void
}

const DEFAULT_DELAYS = [0, 5_000, 300_000, 1_800_000, 7_200_000] as const

const unref = (timer: unknown) => {
  ;(timer as { unref?: () => void }).unref?.()
}

const randomId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`

const matchesEndpoint = (endpoint: WebhookEndpoint, message: WebhookMessage): boolean => {
  const events = endpoint.events ?? ["*"]
  if (!events.includes("*") && !events.includes(message.type)) return false
  for (const [key, value] of Object.entries(endpoint.tags ?? {})) {
    if (message.tags[key] !== value) return false
  }
  return true
}

export const createWebhookHub = (options: WebhookHubOptions): WebhookHub => {
  const delays = options.retryDelaysMs ?? DEFAULT_DELAYS
  const timeoutMs = options.timeoutMs ?? 15_000
  const delivered = options.delivered ?? ((status: number) => status >= 200 && status < 300)
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const keep = options.keep ?? 500
  const now = options.now ?? Date.now
  const id = options.id ?? randomId
  const scheduleTimer =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const cancel =
    options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const global = (options.endpoints ?? []).map((e, i) => ({ ...e, id: e.id ?? `we_global_${i}` }))
  const own = new Map<string, WebhookEndpoint[]>()
  const messages: WebhookMessage[] = []
  const deliveries = new Map<string, WebhookDelivery>()
  const pending = new Map<string, unknown | undefined>()
  const payloads = new Map<string, { message: WebhookMessage; endpoint: WebhookEndpoint }>()
  const faults = new Map<string, { mode: WebhookFault["mode"]; remaining: number }[]>()
  const held = new Map<string, WebhookMessage[]>()
  const inFlight = new Set<Promise<void>>()

  const track = (work: Promise<void>) => {
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  }

  const attempt = async (delivery: WebhookDelivery): Promise<boolean> => {
    const entry = payloads.get(delivery.id)
    if (!entry) return false
    const { message, endpoint } = entry
    const timestampSeconds = Math.floor(now() / 1000)
    const started = now()
    const record: WebhookAttempt = {
      attempt: delivery.attempts.length + 1,
      at: new Date(started).toISOString(),
      status: null,
      error: null,
      durationMs: 0,
      responseBody: null,
    }
    const controller = new AbortController()
    const timer = scheduleTimer(() => controller.abort(), timeoutMs)
    try {
      const signed = await options.signer({
        messageId: message.id,
        body: message.body,
        timestampSeconds,
        url: endpoint.url,
        secret: endpoint.secret,
        signUrl: endpoint.signUrl ?? endpoint.url,
        form: message.contentType.startsWith("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(message.body))
          : undefined,
        type: message.type,
        tags: message.tags,
      })
      const response = await send(
        new Request(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": message.contentType,
            ...endpoint.headers,
            ...message.headers,
            ...signed,
          },
          body: message.body,
          signal: controller.signal,
        }),
      )
      record.status = response.status
      record.responseBody = await response.text()
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
    return record.status !== null && delivered(record.status)
  }

  const schedule = (delivery: WebhookDelivery) => {
    const index = delivery.attempts.length
    if (index >= delays.length) {
      delivery.state = "failed"
      pending.delete(delivery.id)
      return
    }
    const run = () => {
      pending.delete(delivery.id)
      track(
        attempt(delivery).then((ok) => {
          if (ok) delivery.state = "delivered"
          else schedule(delivery)
        }),
      )
    }
    const delay = delays[index] ?? 0
    if (delay <= 0) {
      pending.set(delivery.id, undefined)
      run()
      return
    }
    const timer = scheduleTimer(run, delay)
    unref(timer)
    pending.set(delivery.id, timer)
  }

  const endpointsFor = (namespace: string) => [...(own.get(namespace) ?? []), ...global]

  const fanOut = (message: WebhookMessage, state: WebhookDelivery["state"] = "pending") => {
    for (const endpoint of endpointsFor(message.namespace)) {
      if (!matchesEndpoint(endpoint, message)) continue
      const delivery: WebhookDelivery = {
        id: id("dlv_"),
        messageId: message.id,
        namespace: message.namespace,
        type: message.type,
        endpointId: endpoint.id ?? "we_unknown",
        url: endpoint.url,
        state,
        attempts: [],
      }
      deliveries.set(delivery.id, delivery)
      payloads.set(delivery.id, { message, endpoint })
      if (state === "pending") schedule(delivery)
    }
  }

  const takeFault = (namespace: string): WebhookFault["mode"] | undefined => {
    const queue = faults.get(namespace)
    const head = queue?.[0]
    if (!queue || !head) return undefined
    head.remaining--
    if (head.remaining <= 0) queue.shift()
    return head.mode
  }

  const releaseHeld = (namespace: string) => {
    const waiting = held.get(namespace)
    if (!waiting) return
    held.delete(namespace)
    for (const message of waiting) fanOut(message)
  }

  const hub: WebhookHub = {
    publish(input) {
      const contentType =
        input.contentType ?? (input.form ? "application/x-www-form-urlencoded" : "application/json")
      const body =
        typeof input.body === "string"
          ? input.body
          : input.form
            ? new URLSearchParams(input.form).toString()
            : JSON.stringify(input.body)
      const message: WebhookMessage = {
        id: input.id ?? id("msg_"),
        namespace: input.namespace,
        type: input.type,
        body,
        contentType,
        tags: input.tags ?? {},
        headers: input.headers ?? {},
        publishedAt: new Date(now()).toISOString(),
      }
      messages.push(message)
      const ofNamespace = messages.filter((m) => m.namespace === message.namespace)
      const oldest = ofNamespace[0]
      if (ofNamespace.length > keep && oldest) messages.splice(messages.indexOf(oldest), 1)
      options.onMessage?.(message)
      const fault = takeFault(message.namespace)
      if (fault === "drop") {
        fanOut(message, "dropped")
        return message
      }
      if (fault === "reorder") {
        // Held until the next message goes out, so the receiver sees them swapped.
        held.set(message.namespace, [...(held.get(message.namespace) ?? []), message])
        return message
      }
      fanOut(message)
      if (fault === "duplicate") fanOut(message)
      releaseHeld(message.namespace)
      return message
    },
    setEndpoints(namespace, endpoints) {
      const withIds = endpoints.map((e, i) => ({ ...e, id: e.id ?? `we_${namespace}_${i}` }))
      own.set(namespace, withIds)
      return withIds
    },
    endpoints: endpointsFor,
    messages: (namespace) =>
      namespace === undefined ? [...messages] : messages.filter((m) => m.namespace === namespace),
    deliveries: (namespace) =>
      [...deliveries.values()].filter((d) => namespace === undefined || d.namespace === namespace),
    async replay(id) {
      const delivery = deliveries.get(id)
      if (!delivery) return undefined
      const ok = await attempt(delivery)
      if (ok) delivery.state = "delivered"
      return delivery
    },
    async flush() {
      // Drains until nothing is held or scheduled: a retry that an attempt failing during this
      // flush schedules runs too, so a caller asserting after `flush` never catches a delivery
      // between attempts. Bounded, as every pass moves each delivery an attempt closer to
      // `delivered` or `failed`.
      for (;;) {
        for (const namespace of [...held.keys()]) releaseHeld(namespace)
        const waiting = [...pending.entries()]
        for (const [id, timer] of waiting) {
          if (timer === undefined) continue
          cancel(timer)
          pending.delete(id)
          const delivery = deliveries.get(id)
          if (!delivery) continue
          track(
            attempt(delivery).then((ok) => {
              if (ok) delivery.state = "delivered"
              else schedule(delivery)
            }),
          )
        }
        await hub.idle()
        const scheduled = [...pending.values()].some((timer) => timer !== undefined)
        if (held.size === 0 && !scheduled) return
      }
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
    fault(namespace, fault) {
      const queue = faults.get(namespace) ?? []
      queue.push({ mode: fault.mode, remaining: Math.max(1, fault.count ?? 1) })
      faults.set(namespace, queue)
    },
    clear(namespace) {
      for (const [id, delivery] of deliveries) {
        if (namespace !== undefined && delivery.namespace !== namespace) continue
        const timer = pending.get(id)
        if (timer !== undefined) cancel(timer)
        pending.delete(id)
        deliveries.delete(id)
        payloads.delete(id)
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        if (namespace === undefined || messages[i]?.namespace === namespace) messages.splice(i, 1)
      }
      if (namespace === undefined) {
        held.clear()
        faults.clear()
        own.clear()
      } else {
        held.delete(namespace)
        faults.delete(namespace)
        own.delete(namespace)
      }
    },
  }
  return hub
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const adminError = (status: number, message: string): Response =>
  json(status, { error: { type: "mockingbird_admin", message } })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseEndpoint = (value: unknown): WebhookEndpoint | string => {
  if (!isRecord(value) || typeof value.url !== "string") return "each endpoint needs a url"
  try {
    new URL(value.url)
  } catch {
    return `not a URL: ${value.url}`
  }
  const endpoint: WebhookEndpoint = { url: value.url }
  if (typeof value.id === "string") endpoint.id = value.id
  if (typeof value.secret === "string") endpoint.secret = value.secret
  if (typeof value.signUrl === "string") endpoint.signUrl = value.signUrl
  const events = value.events ?? value.enabledEvents
  if (Array.isArray(events)) endpoint.events = events.map(String)
  if (isRecord(value.tags)) {
    endpoint.tags = Object.fromEntries(Object.entries(value.tags).map(([k, v]) => [k, String(v)]))
  }
  if (typeof value.account === "string")
    endpoint.tags = { ...endpoint.tags, account: value.account }
  if (isRecord(value.headers)) {
    endpoint.headers = Object.fromEntries(
      Object.entries(value.headers).map(([k, v]) => [k, String(v)]),
    )
  }
  return endpoint
}

/**
 * The standard webhook admin routes, for a runtime that owns `hub`:
 *
 * - `GET /webhooks` deliveries, `GET /webhooks/events` published messages (with bodies:
 *   they are the mock's own output), `POST /webhooks/:id/replay`, `POST /webhooks/flush`
 * - `GET|PUT|DELETE /webhook-endpoints` per namespace
 * - `POST /webhooks/faults {mode: duplicate|reorder|drop, count?}`
 */
export const webhookAdminRoutes = (hub: WebhookHub): AdminRoutes => ({
  "GET /webhooks": ({ url, namespace }) =>
    json(200, {
      deliveries: hub
        .deliveries(url.searchParams.get("all") === "1" ? undefined : namespace)
        .filter((d) => {
          const type = url.searchParams.get("type")
          return type === null || d.type === type
        }),
    }),
  "GET /webhooks/events": ({ url, namespace }) => {
    const type = url.searchParams.get("type")
    return json(200, {
      events: hub
        .messages(url.searchParams.get("all") === "1" ? undefined : namespace)
        .filter((m) => type === null || m.type === type)
        .map((m) => ({ ...m, payload: parsePayload(m) })),
    })
  },
  "POST /webhooks/:id/replay": async ({ params }) => {
    const replayed = await hub.replay(params.id as string)
    return replayed ? json(200, replayed) : adminError(404, `no delivery ${params.id}`)
  },
  "POST /webhooks/flush": async () => {
    await hub.flush()
    return json(200, { status: "ok" })
  },
  "POST /webhooks/faults": ({ body, namespace }) => {
    if (!isRecord(body) || !["duplicate", "reorder", "drop"].includes(String(body.mode))) {
      return adminError(400, "mode must be duplicate, reorder or drop")
    }
    const fault: WebhookFault = { mode: body.mode as WebhookFault["mode"] }
    if (typeof body.count === "number") fault.count = body.count
    hub.fault(namespace, fault)
    return json(201, { namespace, ...fault })
  },
  "GET /webhook-endpoints": ({ namespace }) =>
    json(200, {
      endpoints: hub.endpoints(namespace).map(({ secret, ...rest }) => ({
        ...rest,
        secret: secret ? "(set)" : null,
      })),
    }),
  "PUT /webhook-endpoints": ({ body, namespace }) => {
    const list = Array.isArray(body) ? body : isRecord(body) ? body.endpoints : undefined
    if (!Array.isArray(list)) return adminError(400, "expected [{url, secret?, events?}]")
    const parsed: WebhookEndpoint[] = []
    for (const each of list) {
      const endpoint = parseEndpoint(each)
      if (typeof endpoint === "string") return adminError(400, endpoint)
      parsed.push(endpoint)
    }
    const set = hub.setEndpoints(namespace, parsed)
    return json(200, { endpoints: set.map((e) => ({ ...e, secret: e.secret ? "(set)" : null })) })
  },
  "DELETE /webhook-endpoints": ({ namespace }) => {
    hub.setEndpoints(namespace, [])
    return json(200, { status: "ok" })
  },
})

const parsePayload = (message: WebhookMessage): unknown => {
  if (message.contentType.startsWith("application/json")) {
    try {
      return JSON.parse(message.body)
    } catch {
      return message.body
    }
  }
  if (message.contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(message.body))
  }
  return message.body
}
