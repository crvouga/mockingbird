/**
 * A port of our Customer.io consumers:
 *
 * - `B/customer-io/customer-io.notification-adapter.ts` (CDP identify + track through
 *   `@customerio/cdp-analytics-node`, then the App API inbox message) and
 *   `customer-io.delivery.ts` (the per-event callback wait with a 10 s timeout);
 * - `B/customer-io/customer-io.transactional-email-adapter.ts` (`/v1/send/email`, the
 *   missing-trigger-name fallback);
 * - `packages/notification-processor/src/customerio/transactional-client.ts` (`/v1/send/{email,sms}`
 *   with definite / ambiguous failure classification);
 * - `apps/notification-service/src/customerio-trigger-name-validator.ts` (`GET /v1/transactional`);
 * - `B/mobile-links/mobile-links-click-reporter.service.ts` (`POST /click/{linkId}`);
 * - `B/customer-io/customer-io.reporting.controller.ts` + `customer-io.reporting-webhook.ts`
 *   (the signed reporting webhook receiver), with an in-memory database.
 *
 * Same URLs, headers, bodies, status branches and error extraction. The hosts are parameters
 * (the app hardcodes them per region: seam G-Y1).
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Analytics } from "@customerio/cdp-analytics-node"

export type Fetch = (input: Request) => Promise<Response>

const compactProperties = (properties: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== null),
  )

// ------------------------------------------------------------------ customer-io.delivery.ts

export const CUSTOMERIO_DELIVERY_TIMEOUT_MS = 10_000

export class CustomerIoDeliveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Customer.io delivery timed out after ${timeoutMs}ms`)
    this.name = "CustomerIoDeliveryTimeoutError"
  }
}

export const waitForCustomerIoDelivery = (
  enqueue: (callback: (error?: unknown) => void) => void,
  timeoutMs = CUSTOMERIO_DELIVERY_TIMEOUT_MS,
) =>
  new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new CustomerIoDeliveryTimeoutError(timeoutMs))
    }, timeoutMs)
    enqueue((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve()
    })
  })

// ------------------------------------------------------------------ notification adapter

export type NotificationRequest = {
  userId: number
  type: string
  transactionId: string
  redirectPath: string
  properties: Record<string, unknown>
  inbox: { title: string; body: string; topic?: string }
}

export type NotificationConfig = {
  appApiHost: string
  appApiKey: string | null
  inboxTransactionalMessageId: string | null
  inboxEnabled: boolean
  deploymentUrl?: string
  deliveryTimeoutMs?: number
}

/** `CustomerIoNotificationAdapter.send`: null on every failure (it logs and swallows). */
export const sendNotification = async (
  client: Analytics,
  user: { email: string; timezone?: string | null },
  request: NotificationRequest,
  config: NotificationConfig,
  send: Fetch,
): Promise<
  | {
      provider: "customerio"
      userId: string
      inboxMessage:
        | { status: "sent"; transactionalMessageId: string }
        | { status: "skipped"; reason: "disabled_or_unconfigured" }
    }
  | { failed: string }
> => {
  const fallback = (() => {
    if (!config.deploymentUrl || /^[a-z][a-z\d+.-]*:/i.test(request.redirectPath)) return undefined
    const base = new URL(config.deploymentUrl)
    const url = new URL(request.redirectPath, base)
    return url.origin === base.origin ? url.toString() : undefined
  })()
  try {
    const userId = String(request.userId)
    const timeout = config.deliveryTimeoutMs ?? CUSTOMERIO_DELIVERY_TIMEOUT_MS
    const identifyDelivered = waitForCustomerIoDelivery((callback) => {
      client.identify(
        {
          userId,
          traits: compactProperties({ email: user.email, timezone: user.timezone ?? undefined }),
        },
        callback,
      )
    }, timeout)
    const trackDelivered = waitForCustomerIoDelivery((callback) => {
      client.track(
        {
          userId,
          event: "geviti.notification.requested",
          messageId: request.transactionId,
          properties: compactProperties({
            ...request.properties,
            notificationType: request.type,
            redirectPath: request.redirectPath,
            redirectUrl: fallback,
            inboxTitle: request.inbox.title,
            inboxBody: request.inbox.body,
            inboxTopic: request.inbox.topic,
            inboxType: request.type,
          }),
        },
        callback,
      )
    }, timeout)
    await Promise.all([identifyDelivered, trackDelivered])

    if (!config.inboxEnabled || !config.appApiKey || !config.inboxTransactionalMessageId) {
      return {
        provider: "customerio",
        userId,
        inboxMessage: { status: "skipped", reason: "disabled_or_unconfigured" },
      }
    }
    const response = await send(
      new Request(`${config.appApiHost}/v1/send/inbox_message`, {
        method: "POST",
        signal: AbortSignal.timeout(CUSTOMERIO_DELIVERY_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${config.appApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transactional_message_id: config.inboxTransactionalMessageId,
          identifiers: { id: userId },
          message_data: compactProperties({
            ...request.properties,
            title: request.inbox.title,
            body: request.inbox.body,
            topic: request.inbox.topic,
            type: request.type,
            notificationType: request.type,
            redirectPath: request.redirectPath,
            redirectUrl: fallback,
            transactionId: request.transactionId,
          }),
        }),
      }),
    )
    if (!response.ok) return { failed: `customerio_inbox_http_error; status=${response.status}` }
    return {
      provider: "customerio",
      userId,
      inboxMessage: { status: "sent", transactionalMessageId: config.inboxTransactionalMessageId },
    }
  } catch (error) {
    return { failed: error instanceof Error ? error.name : String(error) }
  }
}

// ------------------------------------------------------------------ transactional email adapter

const MESSAGE_NOT_FOUND_PATTERN = /[\\"'“”‘’]*transactional_message_id[\\"'“”‘’]*\s+not\s+found/i

/** Backend adapter version: tests the raw body text. */
export const isMissingTransactionalMessageBody = (status: number, body: string): boolean => {
  if (status < 400 || status >= 500) return false
  if (status === 404) return true
  return MESSAGE_NOT_FOUND_PATTERN.test(body)
}

export class TransactionalEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "TransactionalEmailDeliveryError"
  }
}

export type TransactionalEmailConfig = {
  appApiHost: string
  appApiKey: string | null
  /** `CUSTOMERIO_TX_MSG_ID_<KEY>` overrides. */
  messageIds?: Record<string, string>
  /** `CUSTOMERIO_TX_ENABLED_TYPES`. */
  enabledTypes?: string[]
  /** `CUSTOMERIO_TX_LINK_TRACKING_ENABLED`. */
  linkTracking?: boolean
}

/** `getCustomerIoTransactionalEmailTarget`. */
export const transactionalEmailTarget = (config: TransactionalEmailConfig, key: string) => {
  const override = config.messageIds?.[key]
  if (override) return { transactionalMessageId: override, source: "message_id" as const }
  if (!(config.enabledTypes ?? []).includes(key)) return null
  const trigger = `geviti_${key.replace(/\./g, "_")}`
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(trigger)) return null
  return { transactionalMessageId: trigger, source: "trigger_name" as const }
}

/** `CustomerIoTransactionalEmailAdapter.tryDeliver`: null means "fall back to Resend". */
export const tryDeliverTransactionalEmail = async (
  config: TransactionalEmailConfig,
  request: {
    key: string
    toEmail: string
    identifier?: string
    from?: string
    subject?: string
    messageData: Record<string, unknown>
    attachments?: { filename: string; contentBase64: string; contentType?: string }[]
  },
  send: Fetch,
): Promise<{ deliveryId: string | null; transactionalMessageId: string } | null> => {
  const target = transactionalEmailTarget(config, request.key)
  if (!target || !config.appApiKey || !request.toEmail) return null
  const body: Record<string, unknown> = {
    transactional_message_id: target.transactionalMessageId,
    identifiers: request.identifier ? { id: request.identifier } : { email: request.toEmail },
    to: request.toEmail,
    message_data: compactProperties(request.messageData),
    send_to_unsubscribed: true,
    tracked: config.linkTracking === true,
  }
  if (request.from) body.from = request.from
  if (request.subject) body.subject = request.subject
  if (request.attachments?.length) {
    body.attachments = request.attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64,
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }))
  }
  try {
    const response = await send(
      new Request(`${config.appApiHost}/v1/send/email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.appApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }),
    )
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "")
      if (isMissingTransactionalMessageBody(response.status, responseBody)) return null
      throw new TransactionalEmailDeliveryError(
        `Customer.io transactional email "${request.key}" failed: ${response.status} ${response.statusText} ${responseBody}`.trim(),
        response.status,
      )
    }
    const parsed = (await response.json().catch(() => ({}))) as { delivery_id?: string }
    return {
      deliveryId: parsed.delivery_id ?? null,
      transactionalMessageId: target.transactionalMessageId,
    }
  } catch (error) {
    if (error instanceof TransactionalEmailDeliveryError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new TransactionalEmailDeliveryError(
      `Customer.io transactional email "${request.key}" failed: ${reason}`,
    )
  }
}

// ------------------------------------------------------------------ processor transactional client

export class CustomerIoTransactionalError extends Error {
  readonly status?: number
  readonly ambiguous: boolean
  readonly detail?: string
  readonly reason?: "trigger_name_missing"

  constructor(
    message: string,
    options: {
      status?: number
      ambiguous: boolean
      detail?: string
      reason?: "trigger_name_missing"
    },
  ) {
    super(message)
    this.name = "CustomerIoTransactionalError"
    this.ambiguous = options.ambiguous
    if (options.status !== undefined) this.status = options.status
    if (options.detail !== undefined) this.detail = options.detail
    if (options.reason !== undefined) this.reason = options.reason
  }
}

export const isMissingTransactionalMessage = (
  status: number | undefined,
  detail: string | undefined,
): boolean => {
  if (status === undefined) return false
  if (status < 400 || status >= 500) return false
  if (status === 404) return true
  return detail !== undefined && MESSAGE_NOT_FOUND_PATTERN.test(detail)
}

const AMBIGUOUS_CLIENT_STATUSES = new Set([408])
const DEFINITE_TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

export const isDefiniteRejection = (status: number | undefined): boolean => {
  if (status === undefined) return false
  if (status < 400 || status >= 500) return false
  return !AMBIGUOUS_CLIENT_STATUSES.has(status)
}

export const isDefiniteTransportError = (error: unknown): boolean => {
  const cause = (error as { cause?: unknown } | null)?.cause
  const code = (cause as { code?: unknown } | null)?.code ?? (error as { code?: unknown })?.code
  return typeof code === "string" && DEFINITE_TRANSPORT_ERROR_CODES.has(code)
}

export const extractCustomerIoErrorDetail = (body: string): string | undefined => {
  if (!body) return undefined
  let detail = body
  try {
    const parsed = JSON.parse(body) as { meta?: { error?: unknown } }
    const metaError = parsed?.meta?.error
    if (typeof metaError === "string" && metaError.length > 0) detail = metaError
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return detail.slice(0, 200)
}

/** `sendCustomerIoTransactional`. */
export const sendCustomerIoTransactional = async (request: {
  appApiHost: string
  apiKey: string
  channel: "email" | "sms"
  transactionalMessageId: string
  identifier: string
  to: string
  messageData: Record<string, unknown>
  sendToUnsubscribed?: boolean
  headers?: Record<string, string>
  tracked: boolean
  disableMessageRetention: boolean
  timeoutMs?: number
  fetchImpl: Fetch
}): Promise<{ deliveryId: string | null }> => {
  const body = JSON.stringify({
    transactional_message_id: request.transactionalMessageId,
    identifiers: { id: request.identifier },
    to: request.to,
    message_data: request.messageData,
    send_to_unsubscribed: request.sendToUnsubscribed === true,
    ...(request.headers ? { headers: request.headers } : {}),
    tracked: request.tracked,
    disable_message_retention: request.disableMessageRetention,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 10_000)
  let response: Response
  try {
    response = await request.fetchImpl(
      new Request(`${request.appApiHost}/v1/send/${request.channel}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      }),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown_error"
    throw new CustomerIoTransactionalError(
      `Customer.io transactional ${request.channel} send failed before a response (${reason})`,
      { ambiguous: !isDefiniteTransportError(error) },
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const detail = extractCustomerIoErrorDetail(await response.text().catch(() => ""))
    throw new CustomerIoTransactionalError(
      `Customer.io transactional ${request.channel} send rejected with ${response.status}`,
      {
        status: response.status,
        ambiguous: !isDefiniteRejection(response.status),
        ...(detail !== undefined ? { detail } : {}),
        ...(isMissingTransactionalMessage(response.status, detail)
          ? { reason: "trigger_name_missing" as const }
          : {}),
      },
    )
  }
  const parsed = (await response.json().catch(() => ({}))) as { delivery_id?: string }
  return { deliveryId: parsed.delivery_id ?? null }
}

// ------------------------------------------------------------------ trigger-name validator

export class TriggerNameListError extends Error {
  constructor(readonly status: number | null) {
    super(`Customer.io App API /v1/transactional failed with ${status ?? "no response"}`)
    this.name = "TriggerNameListError"
  }
}

const readTriggerName = (entry: { trigger_name?: unknown }) => {
  if (typeof entry.trigger_name !== "string") return null
  const trimmed = entry.trigger_name.trim()
  return trimmed === "" ? "" : trimmed.toLowerCase()
}

/** `listTransactionalTriggerNames`: the list, then a detail read for entries without a name. */
export const listTransactionalTriggerNames = async (deps: {
  appApiKey: string
  appApiHost: string
  fetchImpl: Fetch
}): Promise<ReadonlySet<string>> => {
  const get = async (path: string) => {
    const response = await deps.fetchImpl(
      new Request(`${deps.appApiHost}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.appApiKey}`, "Content-Type": "application/json" },
      }),
    )
    if (!response.ok) throw new TriggerNameListError(response.status)
    return (await response.json()) as Record<string, unknown>
  }
  const body = await get("/v1/transactional")
  const list = (
    Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.transactional)
        ? body.transactional
        : []
  ) as { id?: unknown; trigger_name?: unknown }[]
  const collected = new Set<string>()
  const needsDetail: string[] = []
  for (const entry of list) {
    const name = readTriggerName(entry)
    if (name === null) {
      if (typeof entry.id === "number" || (typeof entry.id === "string" && entry.id.trim())) {
        needsDetail.push(String(entry.id))
      }
      continue
    }
    if (name !== "") collected.add(name)
  }
  for (const id of needsDetail.slice(0, 25)) {
    const detail = await get(`/v1/transactional/${encodeURIComponent(id)}`)
    const name = detail.message
      ? readTriggerName(detail.message as { trigger_name?: unknown })
      : null
    if (name) collected.add(name)
  }
  return collected
}

// ------------------------------------------------------------------ click reporter

/** `MobileLinksClickReporterService.send` (the base is `https://${domain}` in the app). */
export const reportClick = async (
  base: string,
  linkId: string,
  send: Fetch,
): Promise<{ status: "sent" | "failed"; httpStatus?: number }> => {
  if (!/^[A-Za-z0-9._~-]+$/.test(linkId)) return { status: "failed" }
  try {
    const response = await send(
      new Request(`${base}/click/${linkId}`, {
        method: "POST",
        body: "",
        signal: AbortSignal.timeout(2_000),
      }),
    )
    return { status: response.ok ? "sent" : "failed", httpStatus: response.status }
  } catch {
    return { status: "failed" }
  }
}

// ------------------------------------------------------------------ reporting webhook receiver

export const verifyCustomerIoReportingSignature = (
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
): boolean => {
  if (!timestamp || !/^\d+$/.test(timestamp)) return false
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
}

type ReportingEventShape = {
  event_id: string
  metric: string
  object_type?: string
  timestamp: number
  data: {
    identifiers: { id?: string | null }
    email_address?: string | null
    content?: string
  }
}

/** `customerIoReportingEventSchema.safeParse`. */
const parseReportingEvent = (raw: unknown): ReportingEventShape | null => {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== "object") return null
  const data = r.data as Record<string, unknown> | undefined
  const identifiers = data?.identifiers as Record<string, unknown> | undefined
  const ok =
    typeof r.event_id === "string" &&
    r.event_id.length >= 1 &&
    r.event_id.length <= 256 &&
    typeof r.metric === "string" &&
    r.metric.length >= 1 &&
    (r.object_type === undefined || typeof r.object_type === "string") &&
    typeof r.timestamp === "number" &&
    Number.isInteger(r.timestamp) &&
    r.timestamp > 0 &&
    r.timestamp <= 8_640_000_000_000 &&
    !!data &&
    typeof data === "object" &&
    !!identifiers &&
    typeof identifiers === "object" &&
    (identifiers.id === undefined ||
      identifiers.id === null ||
      typeof identifiers.id === "string") &&
    (data.email_address === undefined ||
      data.email_address === null ||
      typeof data.email_address === "string") &&
    (data.content === undefined || typeof data.content === "string")
  return ok ? (raw as ReportingEventShape) : null
}

export const resolveCustomerIoSuppression = (
  event: ReportingEventShape,
  marketingTopicKey: string | null,
): ("email" | "sms")[] => {
  const channels = new Set<"email" | "sms">()
  if (event.metric === "unsubscribed") {
    if (event.object_type === "customer" || event.data.email_address !== undefined) {
      channels.add("email")
      channels.add("sms")
    } else if (event.object_type === "email" || event.object_type === "sms") {
      channels.add(event.object_type)
    }
  }
  if (event.metric === "spammed" && event.object_type === "email") channels.add("email")
  if (event.metric === "cio_subscription_preferences_changed") {
    if (!event.data.content)
      throw new Error("Customer.io subscription preference content is missing")
    const preferences = JSON.parse(event.data.content) as {
      topics?: Record<string, boolean>
      channels?: Record<string, boolean>
    }
    for (const channel of ["email", "sms"] as const) {
      if (preferences.channels?.[channel] === false) channels.add(channel)
    }
    if (marketingTopicKey && preferences.topics?.[marketingTopicKey] === false) {
      channels.add("email")
      channels.add("sms")
    }
  }
  return [...channels]
}

export const resolveCustomerIoEnabledChannels = (event: ReportingEventShape) => {
  if (event.metric === "subscribed") return ["email", "sms"] as const
  const channels = new Set<"email" | "sms">()
  if (event.metric === "cio_subscription_preferences_changed" && event.data.content) {
    const preferences = JSON.parse(event.data.content) as { channels?: Record<string, boolean> }
    for (const channel of ["email", "sms"] as const) {
      if (preferences.channels?.[channel] === true) channels.add(channel)
    }
  }
  return [...channels]
}

/** The receiver's database effects, in memory. */
export class ReportingReceiver {
  readonly processed = new Set<string>()
  readonly suppressed = new Map<number, Set<"email" | "sms">>()
  readonly optIns: { userId: number; channels: readonly string[]; eventId: string }[] = []
  /** Event ids the replay marker turned away (`customerio_reporting_webhook_duplicate`). */
  readonly duplicates: string[] = []

  constructor(
    private readonly secret: string,
    readonly users: Set<number>,
    private readonly marketingTopicKey: string | null = null,
  ) {}

  /** `CustomerIoReportingController.receive`: an HTTP status and body. */
  async receive(request: Request): Promise<{ status: number; body: unknown }> {
    if (!this.secret || this.secret.length < 32) {
      return { status: 503, body: "signature verification is not configured" }
    }
    const rawBody = await request.text()
    if (
      !verifyCustomerIoReportingSignature(
        rawBody,
        request.headers.get("x-cio-timestamp"),
        request.headers.get("x-cio-signature"),
        this.secret,
      )
    ) {
      return { status: 401, body: "Invalid Customer.io reporting signature" }
    }
    let raw: unknown
    try {
      raw = JSON.parse(rawBody)
    } catch {
      return { status: 400, body: "Invalid Customer.io reporting body" }
    }
    const event = parseReportingEvent(raw)
    if (!event) return { status: 400, body: "Invalid Customer.io reporting event" }
    if (event.timestamp > Math.floor(Date.now() / 1000) + 300) {
      return { status: 400, body: "Invalid Customer.io reporting timestamp" }
    }
    const id = event.data.identifiers.id
    if (!id || !/^\d+$/.test(id)) return { status: 200, body: { received: true, applied: false } }
    const userId = Number(id)
    if (this.processed.has(event.event_id)) {
      this.duplicates.push(event.event_id)
      return { status: 200, body: { received: true, applied: false } }
    }
    this.processed.add(event.event_id)
    const channels = resolveCustomerIoSuppression(event, this.marketingTopicKey)
    const enabled = resolveCustomerIoEnabledChannels(event)
    if (channels.length === 0 && enabled.length === 0) {
      return { status: 200, body: { received: true, applied: false } }
    }
    if (!this.users.has(userId)) return { status: 200, body: { received: true, applied: false } }
    if (channels.length > 0) {
      const set = this.suppressed.get(userId) ?? new Set()
      for (const channel of channels) set.add(channel)
      this.suppressed.set(userId, set)
    }
    if (enabled.length > 0) this.optIns.push({ userId, channels: enabled, eventId: event.event_id })
    return { status: 200, body: { received: true, applied: channels.length > 0 } }
  }
}
