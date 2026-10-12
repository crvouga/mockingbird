import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  hmac,
  type MockControls,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  CUSTOMERIO_NAMESPACE,
  CustomerIoAPI,
  customerIoCredential,
  type ReportInput,
} from "./index.js"
import {
  DELIVERY_STATES,
  type DeliveryState,
  type Settings,
  type TransactionalMessage,
} from "./state.js"

/** Where our backend receives reporting webhooks (`customer-io.reporting.controller.ts`). */
export const REPORTING_WEBHOOK_PATH = "/v1/customer-io/reporting-webhook"

/** `x-cio-signature`: hex HMAC-SHA256 of `v0:<x-cio-timestamp>:<body>`. */
export const signReporting = (secret: string, timestampSeconds: number, body: string) =>
  hmac("SHA-256", secret, `v0:${timestampSeconds}:${body}`, "hex")

const SENDS = ["SendEmail", "SendSms", "SendInboxMessage"] as const
const CDP = ["CdpIdentify", "CdpTrack", "CdpBatch"] as const
const onSends = (rule: Omit<NonNullable<FaultPreset["rules"]>[number], "operationId">) =>
  SENDS.map((operationId) => ({ operationId, ...rule }))
const onCdp = (rule: Omit<NonNullable<FaultPreset["rules"]>[number], "operationId">) =>
  CDP.map((operationId) => ({ operationId, ...rule }))

/**
 * Every named Customer.io misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const CUSTOMERIO_PRESETS: Record<string, FaultPreset> = {
  transactional_message_missing: {
    description:
      'Sends answer 400 {meta: {error: "transactional_message_id not found"}} (trigger_name_missing, then fallback)',
    rules: onSends({
      status: 400,
      body: { meta: { error: "transactional_message_id not found" } },
    }),
  },
  transactional_404: {
    description: "Sends answer 404 (also read as trigger_name_missing)",
    rules: onSends({ status: 404, body: { meta: { error: "not found" } } }),
  },
  request_timeout_408: {
    description:
      "Sends answer 408 before the handler runs (no delivery). Ambiguous: the caller keeps its reservation",
    rules: onSends({ status: 408, body: { meta: { error: "request timeout" } } }),
  },
  server_error: {
    description:
      "Sends answer 500 before the handler runs (no delivery). Ambiguous: the caller keeps its reservation",
    rules: onSends({ status: 500, body: { meta: { error: "internal server error" } } }),
  },
  accepted_but_500: {
    description: "Sends queue the message (it lands in the outbox), then answer 500",
    rules: SENDS.map((operationId) => ({ operationId, effect: "accepted_but_500" })),
  },
  rate_limited: {
    description: "Sends answer 429: definite, safe to re-POST on the next attempt",
    rules: onSends({
      status: 429,
      headers: { "retry-after": "1" },
      body: { meta: { error: "rate limit exceeded" } },
    }),
  },
  invalid_app_key: {
    description: "App API calls answer 401",
    rules: [
      ...onSends({ status: 401, body: { meta: { error: "Unauthorized request" } } }),
      {
        pathPrefix: "/v1/transactional",
        status: 401,
        body: { meta: { error: "Unauthorized request" } },
      },
      {
        operationId: "GetCustomerAttributes",
        status: 401,
        body: { meta: { error: "Unauthorized request" } },
      },
      {
        operationId: "GetMessage",
        status: 401,
        body: { meta: { error: "Unauthorized request" } },
      },
    ],
  },
  send_drop: {
    description: "Sends drop the connection before the handler runs: ambiguous, no delivery",
    rules: SENDS.map((operationId) => ({ operationId, drop: true })),
  },
  send_drop_before_accept: {
    description: "Sends drop the connection before enqueue: ambiguous, no delivery",
    rules: SENDS.map((operationId) => ({ operationId, drop: true })),
  },
  send_drop_after_accept: {
    description:
      "Sends record the delivery, then drop the connection: ambiguous, exactly one delivery",
    rules: SENDS.map((operationId) => ({ operationId, effect: "send_drop_after_accept" })),
  },
  cdp_unavailable: {
    description: "CDP calls answer 503 (the SDK retries, then fails the callback)",
    rules: onCdp({ status: 503, body: { error: "Service Unavailable" } }),
  },
  cdp_bad_request: {
    description: "CDP calls answer 400 (the SDK does not retry; the callback fails)",
    rules: onCdp({ status: 400, body: { error: "Bad Request" } }),
  },
  cdp_slow: {
    description: "CDP calls take 15 s (our 10 s delivery timeout fires first)",
    rules: onCdp({ latencyMs: 15_000 }),
  },
  transactional_list_unavailable: {
    description: "GET /v1/transactional answers 503 (the trigger-name validator records an error)",
    rules: [
      {
        operationId: "ListTransactionalMessages",
        status: 503,
        body: { meta: { error: "service unavailable" } },
      },
    ],
  },
  omit_trigger_names: {
    description:
      "GET /v1/transactional lists messages without trigger_name (the validator reads each by id)",
    rules: [{ operationId: "ListTransactionalMessages", effect: "omit_trigger_names" }],
  },
  webhook_duplicate: {
    description: "The next reporting event is delivered twice (same event_id)",
    webhook: { mode: "duplicate" },
  },
  webhook_drop: {
    description: "The next reporting event is never delivered",
    webhook: { mode: "drop" },
  },
  webhook_reorder: {
    description:
      "The next reporting event is held until the one after it, then the two are swapped",
    webhook: { mode: "reorder" },
  },
}

type WebhookHubOptionsSubset = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type CustomerIoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  /** Real-time clock for webhook freshness/signing; injectable for deterministic tests. */
  wallClock?: () => number
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  messages?: readonly TransactionalMessage[]
  settings?: Partial<Settings>
  /**
   * Where reporting events go (`POST /v1/customer-io/reporting-webhook`), signed with
   * `secret` (the app's `CUSTOMERIO_REPORTING_WEBHOOK_SIGNING_KEY`, 32+ characters).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookHubOptionsSubset
}

export type CustomerIoRuntime = ServiceRuntime<CustomerIoAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<CustomerIoAPI>): AdminRoutes => ({
  ...outboxAdminRoutes(
    runtime,
    (api) => api.state.deliveries,
    (params) => {
      const channel = params.get("channel")
      const message = params.get("transactional_message_id")
      const userId = params.get("userId")
      const recipient = params.get("recipient")
      const deliveryId = params.get("deliveryId")
      if (
        channel === null &&
        message === null &&
        userId === null &&
        recipient === null &&
        deliveryId === null
      ) {
        return undefined
      }
      return (item) =>
        (channel === null || item.channel === channel) &&
        (message === null || item.transactionalMessageId === message) &&
        (userId === null || (item.identifiers as { id?: string }).id === userId) &&
        (deliveryId === null || item.id === deliveryId) &&
        (recipient === null || String(item.to).toLowerCase() === recipient.toLowerCase())
    },
  ),
  "GET /cdp/events": ({ url, namespace }) => {
    const userId = url.searchParams.get("userId")
    const type = url.searchParams.get("type")
    const event = url.searchParams.get("event")
    return json(200, {
      events: runtime
        .instance(namespace)
        .state.cdp.list({
          order: "oldest",
          where: (e) =>
            (userId === null || e.userId === userId) &&
            (type === null || e.type === type) &&
            (event === null || e.event === event),
        })
        .map((row) => row.value),
    })
  },
  "GET /profiles": ({ namespace }) =>
    json(200, { profiles: runtime.instance(namespace).profiles() }),
  "GET /profiles/:id": ({ params, namespace }) => {
    const profile = runtime.instance(namespace).state.profile(params.id as string)
    return profile ? json(200, profile) : adminError(404, `no profile ${params.id}`)
  },
  "PUT /profiles/:id": ({ params, body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: {
      traits?: Record<string, unknown>
      email?: string | null
      unsubscribed?: boolean
      preferences?: { channels?: Record<string, boolean>; topics?: Record<string, boolean> }
    } = {}
    if (isRecord(body.traits)) patch.traits = body.traits
    if (typeof body.email === "string" || body.email === null) patch.email = body.email
    if (typeof body.unsubscribed === "boolean") patch.unsubscribed = body.unsubscribed
    if (isRecord(body.preferences)) {
      patch.preferences = body.preferences as {
        channels?: Record<string, boolean>
        topics?: Record<string, boolean>
      }
    }
    return json(200, runtime.instance(namespace).mergeProfile(params.id as string, patch))
  },
  "POST /optouts": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      typeof body.customerId !== "string" ||
      typeof body.from !== "string" ||
      !body.from.trim() ||
      typeof body.optout !== "boolean" ||
      (body.channel !== undefined && body.channel !== "sms" && body.channel !== "whatsapp")
    ) {
      return adminError(400, "expected {customerId, from, optout: boolean, channel?: sms|whatsapp}")
    }
    const result = runtime
      .instance(namespace)
      .state.setOptOut(
        body.customerId,
        body.from,
        body.channel === "whatsapp" ? "whatsapp" : "sms",
        body.optout,
      )
    return result ? json(200, result) : adminError(404, "unknown customer")
  },
  "POST /deliveries/:id": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.state !== "string") {
      return adminError(400, `expected {"state": ${DELIVERY_STATES.join("|")}}`)
    }
    if (!DELIVERY_STATES.includes(body.state as DeliveryState)) {
      return adminError(400, `state must be one of ${DELIVERY_STATES.join(", ")}`)
    }
    const delivery = runtime
      .instance(namespace)
      .transitionDelivery(params.id as string, body.state as DeliveryState)
    return delivery ? json(200, delivery) : adminError(404, `no delivery ${params.id}`)
  },
  "POST /namespace-clock": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.advance !== "number" || !Number.isFinite(body.advance)) {
      return adminError(400, 'expected {"advance": <milliseconds>}')
    }
    return json(200, runtime.instance(namespace).advanceClock(body.advance))
  },
  "POST /reporting-events": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.metric !== "string") {
      return adminError(
        400,
        'expected {"metric": "unsubscribed"|"subscribed"|"spammed"|"cio_subscription_preferences_changed"|…, "userId"?, "email"?, "deliveryId"?, "objectType"?, "preferences"?}',
      )
    }
    const text = (key: string) =>
      typeof body[key] === "string" ? (body[key] as string) : undefined
    const input: ReportInput = { metric: body.metric }
    for (const key of ["objectType", "userId", "email", "deliveryId", "href", "linkId"] as const) {
      const value = text(key)
      if (value !== undefined) input[key] = value
    }
    if (isRecord(body.preferences))
      input.preferences = body.preferences as ReportInput["preferences"] & object
    const event = runtime.instance(namespace).report(input)
    return typeof event === "string" ? adminError(404, event) : json(201, event)
  },
  "GET /transactional": ({ namespace }) =>
    json(200, { messages: runtime.instance(namespace).state.catalog() }),
  "PUT /transactional": ({ body, namespace }) => {
    const list = Array.isArray(body) ? body : isRecord(body) ? body.messages : undefined
    if (!Array.isArray(list)) return adminError(400, "expected [{id, name, trigger_name, …}]")
    const state = runtime.instance(namespace).state
    for (const row of state.catalog()) state.messages.delete(String(row.id))
    for (const [index, raw] of list.entries()) {
      if (!isRecord(raw) || typeof raw.trigger_name !== "string") {
        return adminError(400, `messages[${index}]: trigger_name is required`)
      }
      const id = typeof raw.id === "number" ? raw.id : index + 1
      state.messages.insert(String(id), {
        id,
        name: typeof raw.name === "string" ? raw.name : raw.trigger_name,
        trigger_name: raw.trigger_name,
        description: typeof raw.description === "string" ? raw.description : "",
        send_to_unsubscribed: raw.send_to_unsubscribed !== false,
        link_tracking: raw.link_tracking === true,
        open_tracking: raw.open_tracking !== false,
        hide_message_body: raw.hide_message_body === true,
        queue_drafts: false,
        created_at: 1_735_689_600,
        updated_at: 1_735_689_600,
      })
    }
    return json(200, { messages: state.catalog() })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (typeof body.strictMessages === "boolean") patch.strictMessages = body.strictMessages
    if (typeof body.trackingBase === "string") patch.trackingBase = body.trackingBase
    if (Array.isArray(body.keys)) patch.keys = body.keys.map(String)
    if (
      typeof body.statusVisibleAfterMs === "number" &&
      Number.isFinite(body.statusVisibleAfterMs)
    ) {
      patch.statusVisibleAfterMs = body.statusVisibleAfterMs
    }
    if (typeof body.clockOffsetMs === "number" && Number.isFinite(body.clockOffsetMs)) {
      patch.clockOffsetMs = body.clockOffsetMs
    }
    if (typeof body.retainMessageDataForTests === "boolean") {
      patch.retainMessageDataForTests = body.retainMessageDataForTests
    }
    if (body.transactionalListKey === "messages" || body.transactionalListKey === "transactional") {
      patch.transactionalListKey = body.transactionalListKey
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Customer.io mock with Mockingbird's full service contract: `/__admin/health`, `/__admin/*`,
 * namespaces by header, by `/__admin/ns/<name>` path prefix, or by key (the CDP write key or the App API
 * key: `PUT /__admin/credentials {"credentials": {"<key>": "<namespace>"}}`), clock control,
 * fault presets, the transactional outbox, and signed reporting webhooks.
 */
export const createRuntime = (options: CustomerIoRuntimeOptions = {}): CustomerIoRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.custom(async ({ body, timestampSeconds, secret }) =>
      secret
        ? {
            "x-cio-timestamp": String(timestampSeconds),
            "x-cio-signature": await signReporting(secret, timestampSeconds, body),
          }
        : {},
    ),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    ...(options.wallClock ? { now: options.wallClock } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<CustomerIoAPI>({
    name: CUSTOMERIO_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: customerIoCredential,
    presets: CUSTOMERIO_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new CustomerIoAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.wallClock ? { wallClock: options.wallClock } : {}),
        ...(options.messages ? { messages: options.messages } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onReport: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.metric,
            body: event,
            id: event.event_id,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
