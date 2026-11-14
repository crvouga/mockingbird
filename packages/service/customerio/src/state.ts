import { Collection, IdSequence, type OutboxItem, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** One transactional message (template) in the workspace, as `GET /v1/transactional` lists it. */
export type TransactionalMessage = {
  id: number
  name: string
  trigger_name: string
  description: string
  send_to_unsubscribed: boolean
  link_tracking: boolean
  open_tracking: boolean
  hide_message_body: boolean
  queue_drafts: boolean
  created_at: number
  updated_at: number
}

export type Channel = "email" | "sms" | "push" | "inbox"

/** Lifecycle states a delivery can be moved through. `pending` is the initial accepted state. */
export const DELIVERY_STATES = [
  "pending",
  "sent",
  "delivered",
  "bounced",
  "dropped",
  "failed",
  "spammed",
  "undeliverable",
  "suppressed",
] as const

export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** Terminal failure states. `delivered` is success; anything else (including `sent`) stays open. */
export const FAILURE_STATES = new Set<DeliveryState>([
  "bounced",
  "dropped",
  "failed",
  "spammed",
  "undeliverable",
  "suppressed",
])

/** One level of Customer.io subscription preferences. Explicit `false` is kept. */
export type SubscriptionPreferences = {
  channels: Record<string, boolean>
  topics: Record<string, boolean>
}

/**
 * One transactional send, which is also the outbox entry a suite asserts on. `messageData` is
 * dropped when the request set `disable_message_retention` (Customer.io keeps no body then).
 */
export type Delivery = OutboxItem & {
  channel: Channel
  transactionalMessageId: string
  /** The catalog message the id or trigger name resolved to, when it did. */
  messageId: number | null
  identifiers: { id?: string; email?: string; cio_id?: string }
  from: string | null
  subject: string | null
  messageData: Record<string, unknown> | null
  /** URLs stored for the recipient (tracked links are rewritten to `/click/<linkId>`). */
  links: string[]
  /** The same URLs before tracking rewrote them. */
  originalLinks: string[]
  tracked: boolean
  sendToUnsubscribed: boolean
  disableMessageRetention: boolean
  headers: Record<string, string>
  attachments: string[]
  /** `pending` until an admin transition. `suppressed` when the profile cannot be sent. */
  state: DeliveryState
  /** Why a send was suppressed: `unsubscribed` or `channel_off`. */
  reason: string | null
  failureMessage: string | null
  /** Push sends only: the targeted devices and the overrides sent (bodies dropped without retention). */
  push?: PushDetail
  /** Unix seconds keyed by the state that was entered (`delivered`, `bounced`, …). */
  metrics: Record<string, number>
  /** `GET /v1/messages/{id}` stays 404 until the mock clock reaches this instant. */
  visibleAt: number
  queuedAt: number
  clicks: number
}

/**
 * One device on a person, as `GET /v1/customers/{id}/attributes` lists it: `id` is the push
 * token, `last_used` unix seconds, `attributes` the device event's properties.
 */
export type Device = {
  id: string
  platform: string
  last_used: number
  attributes: Record<string, unknown>
}

/** A person's device list (stored apart from the profile so tokens can move between people). */
export type PersonDevices = { userId: string; devices: Device[] }

/** Customer.io keeps at most 25 devices per person; a 26th evicts the oldest `last_used`. */
export const MAX_DEVICES_PER_PERSON = 25

/** What a push send targeted, recorded on its delivery. */
export type PushDetail = {
  /** The request's `to`: `all`, `last_used`, or a device token. */
  to: string
  /** Tokens the send was addressed to. */
  devices: string[]
  /** For a token `to`: whether the token was on the profile. `null` for `all` / `last_used`. */
  to_on_profile: boolean | null
  /** Whether the person existed before the send. */
  profile_found: boolean
  title: string | null
  message: string | null
  custom_data: Record<string, string> | null
  custom_payload: Record<string, unknown> | null
  sound: string | null
  image_url: string | null
  link: string | null
}

/** One CDP call (identify or track), with the fields a suite asserts on. */
export type CdpEvent = {
  messageId: string
  type: "identify" | "track"
  userId: string | null
  anonymousId: string | null
  event: string | null
  traits: Record<string, unknown>
  properties: Record<string, unknown>
  timestamp: string | null
  receivedAt: string
  /** The same `messageId` arrived earlier: accepted, not applied again. */
  duplicate: boolean
}

/** A person as identify calls and reporting events have shaped them. */
export type Profile = {
  id: string
  /** Customer.io's `cio_id`, assigned when the profile is first written. */
  cioId: string
  email: string | null
  traits: Record<string, unknown>
  unsubscribed: boolean
  /** Channels switched off through subscription preferences. */
  channelsOff: ("email" | "sms")[]
  preferences: SubscriptionPreferences
  updatedAt: string
}

/** Sender opt-outs are independent of marketing subscription preferences. */
export type SenderOptOut = { channel: "sms" | "whatsapp"; from: string }
export type CustomerOptOuts = { customerId: string; optouts: SenderOptOut[] }

export type TrackedLink = { linkId: string; deliveryId: string; url: string }

/**
 * Read-only workspace content the App API lists (`PUT /__admin/content` seeds it; empty by
 * default). Items are stored in the vendor's response shape.
 */
export const CONTENT_LISTS = [
  "reporting_webhooks",
  "topics",
  "snippets",
  "campaigns",
  "newsletters",
  "sender_identities",
] as const
export type ContentList = (typeof CONTENT_LISTS)[number]
export type ContentItems = { list: ContentList; items: Record<string, unknown>[] }

/** A finished customer export (`POST /v1/exports/customers`) and the CSV it produced. */
export type CustomerExport = {
  id: number
  type: "customers"
  status: "done"
  failed: false
  total: number
  downloads: number
  created_at: number
  updated_at: number
  deduplicate_id: string
  /** The export file, frozen when the export was created. Not part of the API body. */
  csv: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /**
   * Refuse sends whose `transactional_message_id` is neither a catalog id nor a trigger name
   * (Customer.io's behaviour). Off by default: the processor derives trigger names from every
   * notification type, which a test workspace cannot list in advance.
   */
  strictMessages: boolean
  /** Base of rewritten tracked links, e.g. `https://links.example.com`. */
  trackingBase: string
  /** Write keys / App API keys accepted as-is; empty means any non-empty key works. */
  keys: string[]
  /**
   * `GET /v1/messages/{id}` returns 404 until this many milliseconds after the send.
   * Advance the namespace clock (`POST /__admin/namespace-clock`) to reveal it.
   */
  statusVisibleAfterMs: number
  /** Added to the shared mock clock so each namespace can move time on its own. */
  clockOffsetMs: number
  /**
   * Keep `messageData` in the admin outbox even when the send set `disable_message_retention`.
   * The public message read still omits `message_data`.
   */
  retainMessageDataForTests: boolean
  /**
   * Object key `GET /v1/transactional` uses. `messages` matches the contract; `transactional`
   * is the alternate key the trigger-name validator also accepts.
   */
  transactionalListKey: "messages" | "transactional"
  /**
   * Push sends whose `to` token is not on the profile, whose person has no profile, or whose
   * person has no devices: `accept` records them (flagged on the delivery), `reject` answers 400.
   * Customer.io's answer is unobserved; `accept` is the emulator default.
   */
  pushUnknownTargets: "accept" | "reject"
  /**
   * A device event naming a token another person holds: `move` takes it off the other person
   * (the default), `share` leaves it on both.
   */
  deviceTokenOwnership: "move" | "share"
}

export const DEFAULT_SETTINGS: Settings = {
  strictMessages: false,
  trackingBase: "https://links.customer.io",
  keys: [],
  statusVisibleAfterMs: 0,
  clockOffsetMs: 0,
  retainMessageDataForTests: false,
  transactionalListKey: "messages",
  pushUnknownTargets: "accept",
  deviceTokenOwnership: "move",
}

/** Our backend's legacy transactional email keys (`customer-io.transactional-email-port.ts`). */
export const TRANSACTIONAL_EMAIL_KEYS = [
  "welcome",
  "bloodwork_reminder",
  "appointment",
  "keys",
  "forms",
  "billing",
  "bloodwork",
  "provider_bloodwork",
  "bloodwork_results",
  "payment_failed",
  "payment_charged",
  "subscription_renewal",
  "new_message_email",
  "requisition_pdf",
  "post_wellness_visit",
  "post_provider_visit",
  "post_bloodwork_review",
  "event_bloodwork_scheduled",
  "event_bloodwork_booth_location",
] as const

const CATALOG_EPOCH = 1_735_689_600

/**
 * The seeded workspace: one message per legacy trigger name (`acme_<key>`), plus the inbox
 * and playground notifications, ids from 1.
 */
export const DEFAULT_TRANSACTIONAL_MESSAGES: TransactionalMessage[] = [
  ...TRANSACTIONAL_EMAIL_KEYS.map((key) => `acme_${key}`),
  "acme_inbox_message",
  "acme_playground_notification",
].map((trigger, index) => ({
  id: index + 1,
  name: trigger.replace(/^acme_/, "Acme ").replace(/_/g, " "),
  trigger_name: trigger,
  description: "",
  send_to_unsubscribed: true,
  link_tracking: false,
  open_tracking: true,
  hide_message_body: false,
  queue_drafts: false,
  created_at: CATALOG_EPOCH,
  updated_at: CATALOG_EPOCH,
}))

export class CustomerIoState {
  readonly deliveries: OutboxStore<Delivery>
  readonly cdp: Collection<CdpEvent>
  readonly profiles: Collection<Profile>
  readonly optouts: Collection<CustomerOptOuts>
  readonly messages: Collection<TransactionalMessage>
  readonly links: Collection<TrackedLink>
  readonly devices: Collection<PersonDevices>
  readonly settings: Collection<Settings>
  readonly content: Collection<ContentItems>
  readonly exports: Collection<CustomerExport>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: {
      messages: readonly TransactionalMessage[]
      settings: Partial<Settings>
    },
  ) {
    this.deliveries = new OutboxStore<Delivery>(sqlite, namespace, "deliveries")
    this.cdp = new Collection(sqlite, namespace, "cdp")
    this.profiles = new Collection(sqlite, namespace, "profiles")
    this.optouts = new Collection(sqlite, namespace, "optouts")
    this.messages = new Collection(sqlite, namespace, "transactional")
    this.links = new Collection(sqlite, namespace, "links")
    this.devices = new Collection(sqlite, namespace, "devices")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.content = new Collection(sqlite, namespace, "content")
    this.exports = new Collection(sqlite, namespace, "exports")
    this.ids = new IdSequence(sqlite, namespace, "customerio")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.messages.count() === 0) {
      for (const message of this.seed.messages) this.messages.insert(String(message.id), message)
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** One workspace content list, in stored order (empty when never seeded). */
  contentOf(list: ContentList): Record<string, unknown>[] {
    return this.content.get(list)?.items ?? []
  }

  setContent(list: ContentList, items: Record<string, unknown>[]): void {
    if (this.content.has(list)) this.content.update(list, { list, items })
    else this.content.insert(list, { list, items })
  }

  catalog(): TransactionalMessage[] {
    return this.messages.list({ order: "oldest" }).map((row) => row.value)
  }

  /** A catalog message by numeric id or (case-insensitive) trigger name. */
  message(idOrTrigger: string): TransactionalMessage | undefined {
    const byId = /^\d+$/.test(idOrTrigger)
      ? this.messages.get(String(Number(idOrTrigger)))
      : undefined
    if (byId) return byId
    const lower = idOrTrigger.toLowerCase()
    return this.catalog().find((m) => m.trigger_name.toLowerCase() === lower)
  }

  setOptOut(
    customerId: string,
    from: string,
    channel: SenderOptOut["channel"],
    optout: boolean,
  ): CustomerOptOuts | undefined {
    if (!this.profile(customerId)) return undefined
    const sender = from.trim().toLowerCase()
    const current = this.optouts.get(customerId)
    const optouts = (current?.optouts ?? []).filter(
      (item) => item.channel !== channel || item.from !== sender,
    )
    if (optout) optouts.push({ channel, from: sender })
    const next = { customerId, optouts }
    // Keep even an empty row so existing pagination cursors retain their position.
    if (current) this.optouts.update(customerId, next)
    else this.optouts.insert(customerId, next)
    return next
  }

  profile(id: string): Profile | undefined {
    return this.profiles.get(id)
  }

  profileByEmail(email: string): Profile | undefined {
    const lower = email.toLowerCase()
    return this.profiles.list({ where: (p) => p.email?.toLowerCase() === lower }).at(0)?.value
  }

  profileByCioId(cioId: string): Profile | undefined {
    return this.profiles.list({ where: (p) => p.cioId === cioId }).at(0)?.value
  }

  /** The profile an App API `identifiers` object names (id, else cio_id, else email). */
  profileFor(identifiers: { id?: string; email?: string; cio_id?: string }): Profile | undefined {
    if (identifiers.id) return this.profile(identifiers.id)
    if (identifiers.cio_id) return this.profileByCioId(identifiers.cio_id)
    if (identifiers.email) return this.profileByEmail(identifiers.email)
    return undefined
  }

  upsertProfile(id: string, patch: Partial<Omit<Profile, "id">>, at: string): Profile {
    const existing = this.profile(id)
    const next: Profile = {
      id,
      cioId: existing?.cioId ?? this.ids.next("cio", 8),
      email: existing?.email ?? null,
      traits: existing?.traits ?? {},
      unsubscribed: existing?.unsubscribed ?? false,
      channelsOff: existing?.channelsOff ?? [],
      preferences: existing?.preferences ?? { channels: {}, topics: {} },
      ...patch,
      updatedAt: at,
    }
    this.profiles.insert(id, next)
    return next
  }

  devicesOf(userId: string): Device[] {
    return this.devices.get(userId)?.devices ?? []
  }

  /** Replace a person's device list (oldest first, capped at {@link MAX_DEVICES_PER_PERSON}). */
  setDevices(userId: string, devices: Device[]): Device[] {
    const kept = [...devices]
    while (kept.length > MAX_DEVICES_PER_PERSON) {
      let oldest = 0
      for (const [index, device] of kept.entries()) {
        if (device.last_used < (kept[oldest] as Device).last_used) oldest = index
      }
      kept.splice(oldest, 1)
    }
    if (this.devices.has(userId)) this.devices.update(userId, { userId, devices: kept })
    else this.devices.insert(userId, { userId, devices: kept })
    return kept
  }

  /** Take tokens off everyone except `userId` (the `move` ownership rule). */
  releaseTokens(userId: string, tokens: readonly string[]): void {
    if (this.current().deviceTokenOwnership !== "move" || tokens.length === 0) return
    for (const row of this.devices.list()) {
      if (row.value.userId === userId) continue
      const rest = row.value.devices.filter((device) => !tokens.includes(device.id))
      if (rest.length !== row.value.devices.length) this.setDevices(row.value.userId, rest)
    }
  }

  /** Add or refresh one device; it becomes the newest entry. */
  upsertDevice(userId: string, device: Device): Device[] {
    this.releaseTokens(userId, [device.id])
    const rest = this.devicesOf(userId).filter((existing) => existing.id !== device.id)
    return this.setDevices(userId, [...rest, device])
  }

  removeDevice(userId: string, token: string): Device[] {
    const current = this.devicesOf(userId)
    if (!current.some((device) => device.id === token)) return current
    return this.setDevices(
      userId,
      current.filter((device) => device.id !== token),
    )
  }

  deliveryId(): string {
    return this.ids.next("", 28)
  }

  linkId(): string {
    return this.ids.next("l", 15)
  }

  eventId(): string {
    return this.ids.next("01J", 23).toUpperCase()
  }
}
