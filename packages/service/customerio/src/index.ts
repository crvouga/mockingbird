import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
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
  type DeliveryState,
  type Device,
  FAILURE_STATES,
  type Profile,
  type PushDetail,
  type Settings,
  type SubscriptionPreferences,
  type TransactionalMessage,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CdpEvent,
  Channel,
  CustomerOptOuts,
  Delivery,
  DeliveryState,
  Device,
  PersonDevices,
  Profile,
  PushDetail,
  SenderOptOut,
  Settings,
  SubscriptionPreferences,
  TrackedLink,
  TransactionalMessage,
} from "./state.js"
export {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSACTIONAL_MESSAGES,
  DELIVERY_STATES,
  FAILURE_STATES,
  MAX_DEVICES_PER_PERSON,
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
  "SendPush",
  "SendInboxMessage",
  "ListTransactionalMessages",
  "GetTransactionalMessage",
  "GetCustomerAttributes",
  "ListOptOuts",
  "GetCustomerOptOuts",
  "GetMessage",
])

/** The CDP semantic events that maintain a person's device list. */
export const DEVICE_UPSERT_EVENT = "Device Created or Updated"
export const DEVICE_DELETE_EVENT = "Device Deleted"

/** Unix seconds from an ISO timestamp, or undefined. */
const unixSeconds = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

const E164 = /^\+[1-9]\d{1,14}$/

/** The tracking domain answers unknown links with a plain-text 404. */
const clickNotFound = () =>
  new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain" } })

const cdpError = (status: number, error: string) => jsonRes(status, { error })
const appError = (status: number, error: string) => jsonRes(status, { meta: { error } })

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g

const boolRecord = (value: unknown): Record<string, boolean> | undefined => {
  if (!isRecord(value)) return undefined
  const out: Record<string, boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "boolean") out[key] = item
  }
  return out
}

const mergeBoolMap = (
  current: Record<string, boolean>,
  incoming: unknown,
): Record<string, boolean> => {
  const next = boolRecord(incoming)
  return next ? { ...current, ...next } : { ...current }
}

/** Shallow-merge traits. Subscription preferences merge one level so omitted keys and `false` stay. */
const mergeTraits = (
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...current, ...incoming }
  if (!("cio_subscription_preferences" in incoming)) return next
  if (!isRecord(incoming.cio_subscription_preferences)) return next
  const currentPrefs = isRecord(current.cio_subscription_preferences)
    ? current.cio_subscription_preferences
    : {}
  const incomingPrefs = incoming.cio_subscription_preferences
  next.cio_subscription_preferences = {
    ...currentPrefs,
    ...incomingPrefs,
    channels: mergeBoolMap(boolRecord(currentPrefs.channels) ?? {}, incomingPrefs.channels),
    topics: mergeBoolMap(boolRecord(currentPrefs.topics) ?? {}, incomingPrefs.topics),
  }
  return next
}

const preferencesOf = (traits: Record<string, unknown>): SubscriptionPreferences | undefined => {
  const raw = traits.cio_subscription_preferences
  if (!isRecord(raw)) return undefined
  return { channels: boolRecord(raw.channels) ?? {}, topics: boolRecord(raw.topics) ?? {} }
}

const channelsOffOf = (preferences: SubscriptionPreferences): ("email" | "sms")[] => {
  const off: ("email" | "sms")[] = []
  if (preferences.channels.email === false) off.push("email")
  if (preferences.channels.sms === false) off.push("sms")
  return off
}

const mergePreferences = (
  current: SubscriptionPreferences | undefined,
  incoming: { channels?: Record<string, boolean>; topics?: Record<string, boolean> },
): SubscriptionPreferences => ({
  channels: mergeBoolMap(current?.channels ?? {}, incoming.channels),
  topics: mergeBoolMap(current?.topics ?? {}, incoming.topics),
})

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
  private readonly baseNow: () => number
  /** The namespace clock (shared clock plus this namespace's offset), epoch ms. */
  readonly now: () => number
  private readonly wallClock: () => number
  private readonly onReport: ((event: ReportingEvent) => void) | undefined
  /** Serializes handlers so concurrent identifies merge instead of dropping traits. */
  private tail: Promise<void> = Promise.resolve()

  constructor(options: CustomerIoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? CUSTOMERIO_NAMESPACE
    this.baseNow = options.now ?? (() => Date.now())
    this.wallClock = options.wallClock ?? Date.now
    this.onReport = options.onReport
    this.state = new CustomerIoState(sqlite, namespace, {
      messages: options.messages ?? DEFAULT_TRANSACTIONAL_MESSAGES,
      settings: options.settings ?? {},
    })
    this.now = () => this.baseNow() + this.state.current().clockOffsetMs
    const handlers = defineOperations<SupportedOperationId>({
      CdpIdentify: (context) => this.enqueue(() => this.cdp(context, "identify")),
      CdpTrack: (context) => this.enqueue(() => this.cdp(context, "track")),
      CdpBatch: (context) => this.enqueue(() => this.cdp(context, "batch")),
      SendEmail: (context) => this.enqueue(() => this.send(context, "email")),
      SendSms: (context) => this.enqueue(() => this.send(context, "sms")),
      SendPush: (context) => this.enqueue(() => this.sendPush(context)),
      SendInboxMessage: (context) => this.enqueue(() => this.send(context, "inbox")),
      ListTransactionalMessages: (context) => this.enqueue(() => this.listMessages(context)),
      GetTransactionalMessage: (context) => this.enqueue(() => this.oneMessage(context)),
      ListOptOuts: (context) => this.enqueue(() => this.listOptOuts(context)),
      GetCustomerOptOuts: (context) => this.enqueue(() => this.customerOptOuts(context)),
      GetCustomerAttributes: (context) => this.enqueue(() => this.attributes(context)),
      GetMessage: (context) => this.enqueue(() => this.deliveryMessage(context)),
      ReportClick: (context) => this.enqueue(() => this.click(context, "post")),
      FollowClick: (context) => this.enqueue(() => this.click(context, "get")),
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

  /** Run `work` after every handler already queued. A rejection does not stall the next call. */
  private enqueue<T>(work: () => T): Promise<T> {
    const run = this.tail.then(work)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
    if (!duplicate && event.type === "track") this.applyDeviceEvent(item, event, at)
    if (duplicate || event.type !== "identify") return messageId
    const id = event.userId ?? event.anonymousId ?? ""
    const existing = this.state.profile(id)
    const traits = mergeTraits(existing?.traits ?? {}, event.traits)
    const preferences = preferencesOf(traits)
    this.state.upsertProfile(
      id,
      {
        traits,
        ...(typeof traits.email === "string" ? { email: traits.email } : {}),
        ...(typeof event.traits.unsubscribed === "boolean"
          ? { unsubscribed: event.traits.unsubscribed }
          : {}),
        ...(preferences ? { preferences, channelsOff: channelsOffOf(preferences) } : {}),
      },
      at,
    )
    return messageId
  }

  /**
   * `Device Created or Updated` upserts `context.device.token` on the event's `userId` (creating
   * the person when needed) and refreshes `last_used`; `Device Deleted` removes it. Events
   * without a `userId` or token change nothing.
   */
  private applyDeviceEvent(item: Json, event: CdpEvent, at: string): void {
    if (event.event !== DEVICE_UPSERT_EVENT && event.event !== DEVICE_DELETE_EVENT) return
    const userId = event.userId
    const context = isRecord(item.context) ? item.context : {}
    const device = isRecord(context.device) ? context.device : {}
    const token =
      typeof device.token === "string" && device.token
        ? device.token
        : typeof event.properties.device_id === "string" && event.properties.device_id
          ? event.properties.device_id
          : undefined
    if (!userId || !token) return
    if (event.event === DEVICE_DELETE_EVENT) {
      this.state.removeDevice(userId, token)
      return
    }
    const platform =
      typeof device.type === "string" && device.type
        ? device.type.toLowerCase()
        : typeof event.properties.device_platform === "string"
          ? event.properties.device_platform.toLowerCase()
          : "unknown"
    const lastUsed =
      typeof event.properties.last_used === "number" && Number.isFinite(event.properties.last_used)
        ? Math.floor(event.properties.last_used)
        : (unixSeconds(event.timestamp) ?? Math.floor(this.now() / 1000))
    if (!this.state.profile(userId)) this.state.upsertProfile(userId, {}, at)
    this.state.upsertDevice(userId, {
      id: token,
      platform,
      last_used: lastUsed,
      attributes: { ...event.properties },
    })
  }

  // ---------------------------------------------------------------- App API sends

  /**
   * `POST /v1/send/push`. Targets come from the person's device list: `to` absent or `all` is
   * every device, `last_used` the newest, otherwise the one token. Unknown targets follow the
   * `pushUnknownTargets` setting (or the `push_unknown_targets_rejected` preset).
   */
  private sendPush(context: OperationContext): Response {
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
    const identifiers = isRecord(body.identifiers)
      ? (body.identifiers as { id?: string; email?: string; cio_id?: string })
      : {}
    const named = (["id", "email", "cio_id"] as const).filter(
      (key) => typeof identifiers[key] === "string" && identifiers[key] !== "",
    )
    if (named.length !== 1) {
      return appError(400, "identifiers: must contain exactly one of id, email or cio_id")
    }
    if (body.platform !== undefined && body.platform !== "all") {
      return appError(400, "platform: values other than all require web push")
    }
    if (body.queue_draft === true) {
      return appError(400, "queue_draft: drafts are not modelled by the Mockingbird emulator")
    }
    const customData = isRecord(body.custom_data) ? body.custom_data : null
    for (const [key, value] of Object.entries(customData ?? {})) {
      if (typeof value !== "string") {
        return appError(
          400,
          `custom_data.${key}: must be a string (Firebase only supports strings)`,
        )
      }
    }
    const rawId = String(body.transactional_message_id)
    const message = this.state.message(rawId)
    if (!message && this.state.current().strictMessages) {
      return appError(400, "transactional_message_id not found")
    }
    const before = this.state.profileFor(identifiers)
    const reject =
      this.state.current().pushUnknownTargets === "reject" ||
      faultEffect(context.request, "push_unknown_targets_rejected") !== undefined
    if (!before && reject) return appError(400, "identifiers: no person matches the identifiers")
    if (identifiers.id && !before) this.state.upsertProfile(identifiers.id, {}, this.iso())
    const profile = before ?? (identifiers.id ? this.state.profile(identifiers.id) : undefined)
    if (profile && isRecord(body.custom_device) && typeof body.custom_device.token === "string") {
      const device = body.custom_device
      this.state.upsertDevice(profile.id, {
        id: device.token as string,
        platform: typeof device.platform === "string" ? device.platform.toLowerCase() : "unknown",
        last_used:
          typeof device.last_used === "number"
            ? Math.floor(device.last_used)
            : Math.floor(this.now() / 1000),
        attributes: isRecord(device.attributes) ? { ...device.attributes } : {},
      })
    }
    const devices = profile ? this.state.devicesOf(profile.id) : []
    const to = typeof body.to === "string" ? body.to : "all"
    let targets: string[]
    let toOnProfile: boolean | null = null
    if (to === "all") targets = devices.map((device) => device.id)
    else if (to === "last_used") {
      const newest = devices.reduce<Device | undefined>(
        (best, device) => (!best || device.last_used >= best.last_used ? device : best),
        undefined,
      )
      targets = newest ? [newest.id] : []
    } else {
      toOnProfile = devices.some((device) => device.id === to)
      targets = [to]
    }
    if (reject && toOnProfile === false) return appError(400, "to: device not found on profile")
    if (reject && targets.length === 0) return appError(400, "to: the person has no devices")
    const sendToUnsubscribed =
      body.send_to_unsubscribed === true ||
      (body.send_to_unsubscribed === undefined && !!message?.send_to_unsubscribed)
    const channelOff = profile?.preferences.channels.push === false
    const suppressed = !sendToUnsubscribed && (!!profile?.unsubscribed || channelOff)
    const retain = body.disable_message_retention !== true
    const keepBody = retain || this.state.current().retainMessageDataForTests
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : null)
    const push: PushDetail = {
      to,
      devices: targets,
      to_on_profile: toOnProfile,
      profile_found: !!before,
      title: keepBody ? text("title") : null,
      message: keepBody ? text("message") : null,
      custom_data: keepBody ? (customData as Record<string, string> | null) : null,
      custom_payload: keepBody && isRecord(body.custom_payload) ? body.custom_payload : null,
      sound: text("sound"),
      image_url: keepBody ? text("image_url") : null,
      link: keepBody ? text("link") : null,
    }
    const deliveryId = this.state.deliveryId()
    const queuedAt = Math.floor(this.now() / 1000)
    const reason = suppressed ? (profile?.unsubscribed ? "unsubscribed" : "channel_off") : null
    const delivery: Delivery = {
      id: deliveryId,
      to: targets.length ? targets : to,
      createdAt: this.iso(),
      channel: "push",
      transactionalMessageId: rawId,
      messageId: message?.id ?? null,
      identifiers,
      from: null,
      subject: null,
      messageData:
        keepBody && isRecord(body.message_data) ? body.message_data : keepBody ? {} : null,
      links: [],
      originalLinks: [],
      tracked: false,
      sendToUnsubscribed,
      disableMessageRetention: !retain,
      headers: {},
      attachments: [],
      state: suppressed ? "suppressed" : "pending",
      reason,
      failureMessage: reason,
      push,
      metrics: suppressed ? { suppressed: queuedAt } : {},
      visibleAt: this.now() + this.state.current().statusVisibleAfterMs,
      queuedAt,
      clicks: 0,
    }
    this.state.deliveries.record(delivery)
    const ids = { deliveryId, transactionalMessageId: rawId }
    if (faultEffect(context.request, "send_drop_after_accept") !== undefined) {
      throw new DroppedConnectionError()
    }
    if (faultEffect(context.request, "accepted_but_500") !== undefined) {
      return annotateResponse(appError(500, "internal server error"), { ids })
    }
    return annotateResponse(jsonRes(200, { delivery_id: deliveryId, queued_at: queuedAt }), {
      ids,
    })
  }

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
    const identifiers = isRecord(body.identifiers)
      ? (body.identifiers as { id?: string; email?: string; cio_id?: string })
      : {}
    const named = (["id", "email", "cio_id"] as const).filter(
      (key) => typeof identifiers[key] === "string" && identifiers[key] !== "",
    )
    if (named.length !== 1) {
      return appError(400, "identifiers: must contain exactly one of id, email or cio_id")
    }
    const rawId = String(body.transactional_message_id)
    const message = this.state.message(rawId)
    if (!message && this.state.current().strictMessages) {
      return appError(400, "transactional_message_id not found")
    }
    if (channel === "sms" && typeof body.to === "string" && !E164.test(body.to)) {
      return appError(400, "to: must be an E.164 phone number")
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
    // A send addressed by id creates the person when identify has not run yet. `to` stays literal.
    if (identifiers.id && !this.state.profile(identifiers.id)) {
      this.state.upsertProfile(identifiers.id, {}, this.iso())
    }
    const tracked =
      body.tracked === true || (body.tracked === undefined && !!message?.link_tracking)
    const deliveryId = this.state.deliveryId()
    const messageData = isRecord(body.message_data) ? body.message_data : {}
    const retain = body.disable_message_retention !== true
    const keepBody = retain || this.state.current().retainMessageDataForTests
    const originalLinks = urlsIn([messageData, body.body ?? ""])
    const links = originalLinks.map((url) => {
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
      messageData: keepBody ? messageData : null,
      links: keepBody ? links : [],
      originalLinks: keepBody ? originalLinks : [],
      tracked,
      sendToUnsubscribed,
      disableMessageRetention: !retain,
      headers: isRecord(body.headers) ? (body.headers as Record<string, string>) : {},
      attachments,
      state: suppressed ? "suppressed" : "pending",
      reason: suppressed ? (profile?.unsubscribed ? "unsubscribed" : "channel_off") : null,
      failureMessage: suppressed ? (profile?.unsubscribed ? "unsubscribed" : "channel_off") : null,
      metrics: suppressed ? { suppressed: queuedAt } : {},
      visibleAt: this.now() + this.state.current().statusVisibleAfterMs,
      queuedAt,
      clicks: 0,
    }
    this.state.deliveries.record(delivery)
    const ids = { deliveryId, transactionalMessageId: rawId }
    if (faultEffect(context.request, "send_drop_after_accept") !== undefined) {
      throw new DroppedConnectionError()
    }
    if (faultEffect(context.request, "accepted_but_500") !== undefined) {
      return annotateResponse(appError(500, "internal server error"), { ids })
    }
    return annotateResponse(jsonRes(200, { delivery_id: deliveryId, queued_at: queuedAt }), {
      ids,
    })
  }

  private listMessages(context: OperationContext): Response {
    const effect = faultEffect(context.request, "omit_trigger_names")
    const selected = Array.isArray(effect?.ids) ? effect.ids.map(String) : null
    const messages = this.state.catalog().map((message) => {
      const omit =
        effect !== undefined && (selected === null || selected.includes(String(message.id)))
      if (!omit) return message
      const { trigger_name: _trigger, ...rest } = message
      return rest
    })
    return jsonRes(200, { [this.state.current().transactionalListKey]: messages })
  }

  private oneMessage(context: OperationContext): Response {
    const message = this.state.message(context.params.transactional_id ?? "")
    return message ? jsonRes(200, { message }) : appError(404, "not found")
  }

  private listOptOuts(context: OperationContext): Response {
    const rawLimit = context.query.limit
    const limit = rawLimit === undefined ? 100 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      return appError(400, "limit must be between 1 and 1000")
    let after = 0
    if (context.query.start !== undefined) {
      try {
        const decoded = atob(String(context.query.start))
        if (!/^optouts:[1-9]\d*$/.test(decoded)) return appError(400, "invalid start cursor")
        after = Number(decoded.slice(8))
        if (!Number.isSafeInteger(after)) return appError(400, "invalid start cursor")
      } catch {
        return appError(400, "invalid start cursor")
      }
    }
    const from =
      typeof context.query.from === "string" ? context.query.from.trim().toLowerCase() : undefined
    const rows = this.state.optouts.list({ order: "oldest" }).flatMap((row) => {
      const profile = this.state.profile(row.value.customerId)
      const optouts = row.value.optouts.filter((item) => from === undefined || item.from === from)
      return row.seq > after && profile && optouts.length
        ? [{ seq: row.seq, customer_id: profile.id, cio_id: profile.cioId, optouts }]
        : []
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return jsonRes(200, {
      ...(rows.length > limit && last ? { next: btoa(`optouts:${last.seq}`) } : {}),
      optouts: page.map(({ seq: _seq, ...row }) => row),
    })
  }

  private customerOptOuts(context: OperationContext): Response {
    const customerId = context.params.customer_id ?? ""
    const idType = context.query.id_type ?? "id"
    const profile =
      idType === "id"
        ? this.state.profile(customerId)
        : idType === "email"
          ? this.state.profileByEmail(customerId)
          : idType === "cio_id"
            ? this.state.profileByCioId(customerId)
            : undefined
    if (!["id", "email", "cio_id"].includes(String(idType))) return appError(400, "invalid id_type")
    if (!profile) return appError(404, "not found")
    return jsonRes(200, { optouts: this.state.optouts.get(profile.id)?.optouts ?? [] })
  }

  private attributes(context: OperationContext): Response {
    const rawType = context.query.id_type
    const idType = rawType === undefined ? "id" : rawType
    if (idType !== "id" && idType !== "email" && idType !== "cio_id") {
      return appError(400, "id_type: must be id, email, or cio_id")
    }
    const customerId = context.params.customer_id ?? ""
    const profile =
      idType === "email"
        ? this.state.profileByEmail(customerId)
        : idType === "cio_id"
          ? this.state.profileByCioId(customerId)
          : this.state.profile(customerId)
    if (!profile) return appError(404, "not found")
    const attributes: Record<string, unknown> = {
      ...profile.traits,
      id: profile.id,
      cio_id: profile.cioId,
      ...(profile.email ? { email: profile.email } : {}),
      unsubscribed: profile.unsubscribed,
    }
    return annotateResponse(
      jsonRes(200, {
        customer: {
          identifiers: {
            id: profile.id,
            cio_id: profile.cioId,
            ...(profile.email ? { email: profile.email } : {}),
          },
          attributes,
          devices: this.state.devicesOf(profile.id).map(({ attributes, ...device }) => ({
            ...device,
            ...(Object.keys(attributes).length ? { attributes } : {}),
          })),
        },
      }),
      { ids: { userId: profile.id } },
    )
  }

  private deliveryMessage(context: OperationContext): Response {
    const delivery = this.state.deliveries.get(context.params.message_id ?? "")
    if (!delivery || this.now() < delivery.visibleAt) return appError(404, "not found")
    const failed = FAILURE_STATES.has(delivery.state)
    const failure = delivery.failureMessage ?? delivery.reason ?? delivery.state
    const recipient =
      delivery.channel === "inbox"
        ? null
        : typeof delivery.to === "string"
          ? delivery.to
          : delivery.to.join(",")
    return annotateResponse(
      jsonRes(200, {
        message: {
          id: delivery.id,
          type: delivery.channel === "inbox" ? "in_app" : delivery.channel,
          recipient,
          customer_id: delivery.identifiers.id ?? delivery.identifiers.cio_id ?? null,
          created: delivery.queuedAt,
          state: delivery.state,
          status: delivery.state,
          metrics: delivery.metrics,
          ...(failed
            ? { failure_message: failure, rejection_reason: failure, error: failure }
            : {}),
        },
      }),
      { ids: { deliveryId: delivery.id } },
    )
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
    let stored = profile
    if (id) {
      if (input.metric === "unsubscribed") {
        stored = this.state.upsertProfile(
          id,
          { unsubscribed: true, traits: { ...(profile?.traits ?? {}), unsubscribed: true } },
          at,
        )
      }
      if (input.metric === "subscribed") {
        const preferences = mergePreferences(profile?.preferences, {
          channels: { email: true, sms: true },
        })
        stored = this.state.upsertProfile(
          id,
          {
            unsubscribed: false,
            channelsOff: [],
            preferences,
            traits: {
              ...(profile?.traits ?? {}),
              unsubscribed: false,
              cio_subscription_preferences: preferences,
            },
          },
          at,
        )
      }
      if (input.metric === "spammed") {
        const preferences = mergePreferences(profile?.preferences, { channels: { email: false } })
        const off = new Set([...(profile?.channelsOff ?? []), "email" as const])
        stored = this.state.upsertProfile(
          id,
          {
            channelsOff: [...off],
            preferences,
            traits: { ...(profile?.traits ?? {}), cio_subscription_preferences: preferences },
          },
          at,
        )
      }
      if (input.metric === "cio_subscription_preferences_changed" && input.preferences) {
        const preferences = mergePreferences(profile?.preferences, input.preferences)
        stored = this.state.upsertProfile(
          id,
          {
            channelsOff: channelsOffOf(preferences),
            preferences,
            traits: { ...(profile?.traits ?? {}), cio_subscription_preferences: preferences },
          },
          at,
        )
      }
    }
    const event: ReportingEvent = {
      event_id: this.state.eventId(),
      object_type: input.objectType ?? (delivery ? delivery.channel : "customer"),
      metric: input.metric,
      // Signature and body timestamps follow the wall clock, not the mock clock.
      timestamp: Math.floor(this.wallClock() / 1000),
      data: {
        identifiers: { id, email, cio_id: stored?.cioId ?? null },
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

  /** Merge traits onto a profile (admin). Omitted traits stay; preference `false` stays. */
  mergeProfile(
    id: string,
    patch: {
      traits?: Record<string, unknown>
      email?: string | null
      unsubscribed?: boolean
      preferences?: { channels?: Record<string, boolean>; topics?: Record<string, boolean> }
    },
  ): Profile {
    const existing = this.state.profile(id)
    const traits = patch.traits
      ? mergeTraits(existing?.traits ?? {}, patch.traits)
      : { ...(existing?.traits ?? {}) }
    const preferences = patch.preferences
      ? mergePreferences(existing?.preferences, patch.preferences)
      : preferencesOf(traits)
    if (preferences && patch.preferences) traits.cio_subscription_preferences = preferences
    return this.state.upsertProfile(
      id,
      {
        traits,
        ...(patch.email !== undefined
          ? { email: patch.email }
          : typeof traits.email === "string"
            ? { email: traits.email }
            : {}),
        ...(patch.unsubscribed !== undefined
          ? { unsubscribed: patch.unsubscribed }
          : typeof patch.traits?.unsubscribed === "boolean"
            ? { unsubscribed: patch.traits.unsubscribed }
            : {}),
        ...(preferences ? { preferences, channelsOff: channelsOffOf(preferences) } : {}),
      },
      this.iso(),
    )
  }

  /** Move a delivery to `state` and stamp `metrics[state]` with the namespace clock. */
  transitionDelivery(id: string, state: DeliveryState): Delivery | undefined {
    const delivery = this.state.deliveries.get(id)
    if (!delivery) return undefined
    const at = Math.floor(this.now() / 1000)
    const next: Delivery = {
      ...delivery,
      state,
      metrics: { ...delivery.metrics, [state]: at },
      failureMessage: FAILURE_STATES.has(state)
        ? (delivery.failureMessage ?? state)
        : delivery.failureMessage,
    }
    this.state.deliveries.update(id, next)
    return next
  }

  /** Move this namespace's clock without touching the shared runtime clock. */
  advanceClock(ms: number): Settings {
    return this.state.update({ clockOffsetMs: this.state.current().clockOffsetMs + ms })
  }
}

export type { CustomerIoRuntime, CustomerIoRuntimeOptions } from "./runtime.js"
export {
  CUSTOMERIO_PRESETS,
  createRuntime,
  REPORTING_WEBHOOK_PATH,
  signReporting,
} from "./runtime.js"
