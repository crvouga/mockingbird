import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  extractLinks,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CdpEvent,
  type Channel,
  CustomerIoState,
  DEFAULT_TRANSACTIONAL_MESSAGES,
  type Delivery,
  type Profile,
  type Settings,
  type TransactionalMessage,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CdpEvent,
  Channel,
  Delivery,
  Profile,
  Settings,
  TrackedLink,
  TransactionalMessage,
} from "./state.js"
export {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSACTIONAL_MESSAGES,
  TRANSACTIONAL_EMAIL_KEYS,
} from "./state.js"

export const CUSTOMERIO_NAMESPACE = "customerio"

/** The body Customer.io's reporting webhook posts (the fields our receiver's zod schema reads). */
export type ReportingEvent = {
  event_id: string
  object_type: string
  metric: string
  timestamp: number
  data: {
    identifiers: { id: string | null; email: string | null; cio_id: string | null }
    customer_id: string | null
    email_address?: string | null
    delivery_id?: string
    transactional_message_id?: number
    href?: string
    link_id?: string
    content?: string
  }
}

/** What a suite (or a click) asks the mock to report. */
export type ReportInput = {
  metric: string
  objectType?: string
  userId?: string
  email?: string
  deliveryId?: string
  /** `cio_subscription_preferences_changed`: `{topics?, channels?}`, sent as a JSON string. */
  preferences?: { topics?: Record<string, boolean>; channels?: Record<string, boolean> }
  href?: string
  linkId?: string
}

export type CustomerIoAPIOptions = APIOptions & {
  /** The workspace's transactional messages. Default {@link DEFAULT_TRANSACTIONAL_MESSAGES}. */
  messages?: readonly TransactionalMessage[]
  settings?: Partial<Settings>
  /** Called for every reporting event; the runtime signs and delivers it. */
  onReport?: (event: ReportingEvent) => void
  /** Wall clock used for receiver freshness checks. Defaults to `Date.now`. */
  wallClock?: () => number
}

/** The CDP write key (Basic username) or App API key (Bearer): how requests map to namespaces. */
export const customerIoCredential = (request: Request): string | undefined =>
  basicAuth(request)?.username || bearerToken(request)

const CDP_OPERATIONS = new Set(["CdpIdentify", "CdpTrack", "CdpBatch"])
const APP_OPERATIONS = new Set([
  "SendEmail",
  "SendSms",
  "SendInboxMessage",
  "ListTransactionalMessages",
  "GetTransactionalMessage",
])

/** The tracking domain answers unknown links with a plain-text 404. */
const clickNotFound = () =>
  new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain" } })

const cdpError = (status: number, error: string) => jsonRes(status, { error })
const appError = (status: number, error: string) => jsonRes(status, { meta: { error } })

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g

/** Every URL in the message data (string values, HTML hrefs included), in order, deduplicated. */
const urlsIn = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") {
    for (const url of [...extractLinks(value), ...(value.match(URL_PATTERN) ?? [])]) {
      if (/^https?:\/\//.test(url) && !out.includes(url)) out.push(url)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) urlsIn(item, out)
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) urlsIn(item, out)
  }
  return out
}

/**
 * Stateful mock of Customer.io's CDP and App API. CDP calls shape profiles; transactional
 * sends land in the outbox (suppressed for unsubscribed profiles unless
 * `send_to_unsubscribed`); tracked links are rewritten to `/click/<linkId>`; reporting events
 * (admin-triggered, or a click) go to the reporting webhook.
 */
export class CustomerIoAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: CustomerIoState
  private readonly service: Service
  private readonly now: () => number
  private readonly wallClock: () => number
  private readonly onReport: ((event: ReportingEvent) => void) | undefined

  constructor(options: CustomerIoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? CUSTOMERIO_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.wallClock = options.wallClock ?? Date.now
    this.onReport = options.onReport
    this.state = new CustomerIoState(sqlite, namespace, {
      messages: options.messages ?? DEFAULT_TRANSACTIONAL_MESSAGES,
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      CdpIdentify: (context) => this.cdp(context, "identify"),
      CdpTrack: (context) => this.cdp(context, "track"),
      CdpBatch: (context) => this.cdp(context, "batch"),
      SendEmail: (context) => this.send(context, "email"),
      SendSms: (context) => this.send(context, "sms"),
      SendInboxMessage: (context) => this.send(context, "inbox"),
      ListTransactionalMessages: (context) =>
        jsonRes(200, {
          messages: this.state
            .catalog()
            .map((m) =>
              faultEffect(context.request, "omit_trigger_names") !== undefined
                ? { ...m, trigger_name: undefined }
                : m,
            ),
        }),
      GetTransactionalMessage: (context) => {
        const message = this.state.message(context.params.transactional_id ?? "")
        return message ? jsonRes(200, { message }) : appError(404, "not found")
      },
      ReportClick: (context) => this.click(context, "post"),
      FollowClick: (context) => this.click(context, "get"),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        new URL(request.url).pathname.startsWith("/click")
          ? clickNotFound()
          : appError(404, "not found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const id = context.operation.operationId
        const keys = this.state.current().keys
        if (CDP_OPERATIONS.has(id)) {
          const key = basicAuth(context.request)?.username
          if (!key || (keys.length > 0 && !keys.includes(key))) {
            return cdpError(401, "Unauthorized")
          }
        }
        if (APP_OPERATIONS.has(id)) {
          const key = bearerToken(context.request)
          if (!key || (keys.length > 0 && !keys.includes(key))) {
            return appError(401, "Unauthorized request")
          }
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  // ---------------------------------------------------------------- CDP

  private cdp(context: OperationContext, kind: "identify" | "track" | "batch"): Response {
    if (context.body.kind !== "json" || !isRecord(context.body.value)) {
      return cdpError(400, "Invalid JSON body")
    }
    const issue = bodyIssues(context)[0]
    if (issue) return cdpError(400, `${issue.path || "body"}: ${issue.message}`)
    const body = context.body.value
    const items = kind === "batch" ? (body.batch as Json[]) : [{ ...body, type: kind } as Json]
    for (const [index, item] of items.entries()) {
      const type = item.type
      if (type !== "identify" && type !== "track") {
        return cdpError(400, `batch.${index}.type: must be identify or track`)
      }
      if (typeof item.userId !== "string" && typeof item.anonymousId !== "string") {
        return cdpError(400, "userId or anonymousId is required")
      }
    }
    const ids: string[] = []
    for (const item of items) ids.push(this.ingest(item))
    return annotateResponse(jsonRes(200, { success: true }), {
      ids: { messageIds: ids.join(",") },
    })
  }

  /** Apply one CDP event; a repeated `messageId` is recorded as a duplicate and not re-applied. */
  private ingest(item: Json): string {
    const at = this.iso()
    const messageId =
      typeof item.messageId === "string" && item.messageId
        ? item.messageId
        : `mb-${this.state.ids.next("m", 20)}`
    const duplicate = this.state.cdp.has(messageId)
    const event: CdpEvent = {
      messageId,
      type: item.type as "identify" | "track",
      userId: typeof item.userId === "string" ? item.userId : null,
      anonymousId: typeof item.anonymousId === "string" ? item.anonymousId : null,
      event: typeof item.event === "string" ? item.event : null,
      traits: isRecord(item.traits) ? item.traits : {},
      properties: isRecord(item.properties) ? item.properties : {},
      timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
      receivedAt: at,
      duplicate,
    }
    this.state.cdp.insert(duplicate ? `${messageId}#${this.state.cdp.count()}` : messageId, event)
    if (duplicate || event.type !== "identify") return messageId
    const id = event.userId ?? event.anonymousId ?? ""
    const existing = this.state.profile(id)
    const traits = { ...(existing?.traits ?? {}), ...event.traits }
    this.state.upsertProfile(
      id,
      {
        traits,
        ...(typeof traits.email === "string" ? { email: traits.email } : {}),
        ...(typeof event.traits.unsubscribed === "boolean"
          ? { unsubscribed: event.traits.unsubscribed }
          : {}),
      },
      at,
    )
    return messageId
  }

  // ---------------------------------------------------------------- App API sends

  private send(context: OperationContext, channel: Channel): Response {
    if (context.body.kind !== "json" || !isRecord(context.body.value)) {
      return appError(400, "invalid JSON body")
    }
    const issue = bodyIssues(context)[0]
    if (issue) {
      const missing = /^missing required property (.+)$/.exec(issue.message)
      return appError(
        400,
        missing
          ? `${[issue.path, missing[1]].filter(Boolean).join(".")}: is required`
          : `${issue.path || "body"}: ${issue.message}`,
      )
    }
    const body = context.body.value
    const identifiers = body.identifiers as { id?: string; email?: string; cio_id?: string }
    if (!identifiers.id && !identifiers.email && !identifiers.cio_id) {
      return appError(400, "identifiers: must contain exactly one of id, email or cio_id")
    }
    const rawId = String(body.transactional_message_id)
    const message = this.state.message(rawId)
    if (!message && this.state.current().strictMessages) {
      return appError(400, "transactional_message_id not found")
    }
    const profile = this.state.profileFor(identifiers)
    let to: string | null = typeof body.to === "string" ? body.to : null
    if (channel === "email") to ??= identifiers.email ?? profile?.email ?? null
    if (channel === "sms") {
      const phone = profile?.traits.phone
      to ??= typeof phone === "string" ? phone : null
    }
    if (channel === "inbox") to = identifiers.id ?? identifiers.cio_id ?? identifiers.email ?? null
    if (!to) {
      return appError(
        400,
        channel === "email"
          ? "to: is required when the profile has no email attribute"
          : "to: is required when the profile has no phone attribute",
      )
    }
    const tracked =
      body.tracked === true || (body.tracked === undefined && !!message?.link_tracking)
    const deliveryId = this.state.deliveryId()
    const messageData = isRecord(body.message_data) ? body.message_data : {}
    const retain = body.disable_message_retention !== true
    const links = urlsIn([messageData, body.body ?? ""]).map((url) => {
      if (!tracked) return url
      const linkId = this.state.linkId()
      this.state.links.insert(linkId, { linkId, deliveryId, url })
      return `${this.state.current().trackingBase.replace(/\/$/, "")}/click/${linkId}`
    })
    const sendToUnsubscribed =
      body.send_to_unsubscribed === true ||
      (body.send_to_unsubscribed === undefined && !!message?.send_to_unsubscribed)
    const channelOff =
      channel !== "inbox" && !!profile?.channelsOff.includes(channel === "sms" ? "sms" : "email")
    const suppressed = !sendToUnsubscribed && (!!profile?.unsubscribed || channelOff)
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as { filename: string }[]).map((a) => a.filename)
      : isRecord(body.attachments)
        ? Object.keys(body.attachments)
        : []
    const queuedAt = Math.floor(this.now() / 1000)
    const delivery: Delivery = {
      id: deliveryId,
      to,
      createdAt: this.iso(),
      channel,
      transactionalMessageId: rawId,
      messageId: message?.id ?? null,
      identifiers,
      from: typeof body.from === "string" ? body.from : null,
      subject: typeof body.subject === "string" ? body.subject : null,
      messageData: retain ? messageData : null,
      links: retain ? links : [],
      tracked,
      sendToUnsubscribed,
      disableMessageRetention: !retain,
      headers: isRecord(body.headers) ? (body.headers as Record<string, string>) : {},
      attachments,
      state: suppressed ? "suppressed" : "sent",
      queuedAt,
      clicks: 0,
    }
    this.state.deliveries.record(delivery)
    const ids = { deliveryId, transactionalMessageId: rawId }
    if (faultEffect(context.request, "accepted_but_500") !== undefined) {
      return annotateResponse(appError(500, "internal server error"), { ids })
    }
    return annotateResponse(jsonRes(200, { delivery_id: deliveryId, queued_at: queuedAt }), {
      ids,
    })
  }

  // ---------------------------------------------------------------- link tracking

  private click(context: OperationContext, mode: "post" | "get"): Response {
    const link = this.state.links.get(context.params.linkId ?? "")
    if (!link) return clickNotFound()
    const delivery = this.state.deliveries.get(link.deliveryId)
    if (delivery) {
      this.state.deliveries.update(delivery.id, { ...delivery, clicks: delivery.clicks + 1 })
      this.report({
        metric: "clicked",
        objectType: delivery.channel === "sms" ? "sms" : "email",
        deliveryId: delivery.id,
        href: link.url,
        linkId: link.linkId,
      })
    }
    const ids = { linkId: link.linkId, deliveryId: link.deliveryId }
    if (mode === "get") {
      return annotateResponse(
        new Response(null, { status: 302, headers: { location: link.url } }),
        {
          ids,
        },
      )
    }
    return annotateResponse(new Response(null, { status: 200 }), { ids })
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Emit a reporting event and apply what it means to the profile (unsubscribed / subscribed /
   * spammed / subscription preferences). Returns the event, or a reason it could not be built.
   */
  report(input: ReportInput): ReportingEvent | string {
    const delivery = input.deliveryId ? this.state.deliveries.get(input.deliveryId) : undefined
    if (input.deliveryId && !delivery) return `no delivery ${input.deliveryId}`
    const userId = input.userId ?? delivery?.identifiers.id ?? null
    const profile = userId
      ? this.state.profile(userId)
      : input.email
        ? this.state.profileFor({ email: input.email })
        : undefined
    const email =
      input.email ??
      delivery?.identifiers.email ??
      (delivery?.channel === "email" && typeof delivery.to === "string" ? delivery.to : null) ??
      profile?.email ??
      null
    const at = this.iso()
    const id = userId ?? profile?.id ?? null
    if (id) {
      if (input.metric === "unsubscribed") this.state.upsertProfile(id, { unsubscribed: true }, at)
      if (input.metric === "subscribed") {
        this.state.upsertProfile(id, { unsubscribed: false, channelsOff: [] }, at)
      }
      if (input.metric === "spammed") {
        const off = new Set([...(profile?.channelsOff ?? []), "email" as const])
        this.state.upsertProfile(id, { channelsOff: [...off] }, at)
      }
      if (input.metric === "cio_subscription_preferences_changed" && input.preferences) {
        const off = new Set(profile?.channelsOff ?? [])
        for (const [channel, on] of Object.entries(input.preferences.channels ?? {})) {
          if (channel !== "email" && channel !== "sms") continue
          if (on) off.delete(channel)
          else off.add(channel)
        }
        this.state.upsertProfile(id, { channelsOff: [...off] }, at)
      }
    }
    const event: ReportingEvent = {
      event_id: this.state.eventId(),
      object_type: input.objectType ?? (delivery ? delivery.channel : "customer"),
      metric: input.metric,
      // Our receiver rejects timestamps more than 5 min ahead of its wall clock.
      timestamp: Math.floor(Math.min(this.now(), this.wallClock()) / 1000),
      data: {
        identifiers: { id, email, cio_id: null },
        customer_id: id,
        email_address: email,
        ...(delivery ? { delivery_id: delivery.id } : {}),
        ...(delivery?.messageId ? { transactional_message_id: delivery.messageId } : {}),
        ...(input.href ? { href: input.href } : {}),
        ...(input.linkId ? { link_id: input.linkId } : {}),
        ...(input.preferences ? { content: JSON.stringify(input.preferences) } : {}),
      },
    }
    this.onReport?.(event)
    return event
  }

  profiles(): Profile[] {
    return this.state.profiles.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { CustomerIoRuntime, CustomerIoRuntimeOptions } from "./runtime.js"
export {
  CUSTOMERIO_PRESETS,
  createRuntime,
  REPORTING_WEBHOOK_PATH,
  signReporting,
} from "./runtime.js"
