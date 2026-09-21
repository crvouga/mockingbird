import { Collection, IdSequence, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { MessageAddress, MessageContent } from "./content.js"

/** A message exactly as `GET /api/messages/{id}` answers (the SDK's `Message` model). */
export type Message = {
  id: string
  type: "Email" | "SMS"
  from: MessageAddress[]
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  received: string
  subject: string
  html: MessageContent
  text: MessageContent
  attachments: {
    id: string
    contentType: string
    fileName: string
    contentId: string | null
    length: number
    url: string
  }[]
  metadata: {
    headers: { field: string; value: string }[]
    ehlo: string | null
    mailFrom: string | null
    rcptTo: MessageAddress[]
  }
  server: string
}

/**
 * One stored message. `to` holds every recipient's lower-cased email or phone (to, cc, bcc),
 * so the standard `GET /__admin/outbox?to=` filter works; `server` is the inbox it landed in,
 * or `"*"` for mail ingested without one (visible from every server id).
 */
export type InboxRecord = {
  id: string
  to: string[]
  createdAt: string
  receivedMs: number
  server: string
  message: Message
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /**
   * Poll delays sent in `x-ms-delay` while a search matches nothing; the SDK waits this long
   * before polling again. Default `[20]`, so `messages.get` resolves ~20 ms after arrival.
   */
  pollDelaysMs: number[]
}

export const DEFAULT_SETTINGS: Settings = { pollDelaysMs: [20] }

export class MailosaurState {
  readonly messages: Collection<InboxRecord>
  readonly outbox: OutboxStore<InboxRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.messages = new Collection(sqlite, namespace, "messages")
    this.outbox = new OutboxStore(sqlite, namespace, "messages")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "mailosaur")
  }

  current(): Settings {
    return this.settings.get("settings") ?? { ...DEFAULT_SETTINGS, ...this.seed }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    if (this.settings.has("settings")) this.settings.update("settings", next)
    else this.settings.insert("settings", next)
    return next
  }

  /** A GUID-shaped id, deterministic for a given history (Mailosaur ids are GUIDs). */
  nextId(prefix = "msg"): string {
    const token = this.ids.next(`${prefix}_`, 32).slice(prefix.length + 1)
    const hex = [...token].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}
