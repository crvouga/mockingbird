import { Collection, type OutboxItem, OutboxStore, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type ContactRecord = {
  id: string
  external_id: string | null
  role: "user" | "lead"
  email: string | null
  phone: string | null
  name: string | null
  created_at: number
  updated_at: number
  signed_up_at: number | null
  last_seen_at: number | null
  custom_attributes: Record<string, unknown>
}

export type Author = {
  type: "user" | "admin" | "bot"
  id: string
  name: string | null
  email: string | null
}

/** Attachment metadata only: the bytes a caller uploads are never stored. */
export type AttachmentRecord = {
  type: "upload"
  name: string
  url: string
  content_type: string
  filesize: number
  width: null
  height: null
}

export type PartRecord = {
  type: "conversation_part"
  id: string
  part_type: "comment" | "note" | "quick_reply" | "close" | "open" | "snoozed" | "assignment"
  /** HTML, as Intercom stores it. */
  body: string | null
  created_at: number
  updated_at: number
  notified_at: number
  assigned_to: { type: "admin"; id: string } | null
  author: Author
  attachments: AttachmentRecord[]
  external_id: null
  redacted: false
}

export type ConversationRecord = {
  id: string
  contactId: string
  created_at: number
  updated_at: number
  waiting_since: number | null
  snoozed_until: number | null
  state: "open" | "closed" | "snoozed"
  /** Whether the contact has read the latest admin message. */
  read: boolean
  title: string | null
  admin_assignee_id: number | null
  /** Admins who took part, for `teammates`. */
  teammates: string[]
  custom_attributes: Record<string, unknown>
  source: {
    type: "conversation"
    id: string
    delivered_as: "customer_initiated" | "admin_initiated"
    subject: string
    body: string
    author: Author
    attachments: AttachmentRecord[]
    url: null
    redacted: false
  }
  parts: PartRecord[]
}

/**
 * One message the API client sent (`POST /conversations`, `POST /conversations/{id}/reply`),
 * as metadata only: the body is never stored, just whether there was one and its length.
 */
export type OutboxRecord = OutboxItem & {
  /** `[conversationId, contactId]`, so `GET /__admin/outbox?to=` matches either. */
  to: string[]
  operation: "CreateConversation" | "ReplyConversation"
  conversationId: string
  contactId: string
  /** The reply's part id; `null` for the message that opened the conversation. */
  partId: string | null
  /** `source` for the message that opened the conversation, else the part's type. */
  partType: "source" | "comment" | "note" | "quick_reply"
  authorType: "user" | "admin"
  authorId: string
  hasBody: boolean
  bodyLength: number
  attachmentCount: number
  /** Same instant as `createdAt` (ISO-8601 on the mock clock). */
  at: string
}

export type AdminRecord = {
  type: "admin"
  id: string
  name: string
  email: string
  job_title: string | null
  away_mode_enabled: boolean
  away_mode_reassign: boolean
  has_inbox_seat: boolean
  team_ids: number[]
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these access tokens are accepted; empty means any non-empty token is. */
  tokens: string[]
  /**
   * Custom data attributes the workspace defines. Intercom rejects writes of undefined ones;
   * `null` (the default) accepts any.
   */
  customAttributes: string[] | null
}

export const DEFAULT_SETTINGS: Settings = { tokens: [], customAttributes: null }

export const DEFAULT_ADMINS: readonly AdminRecord[] = [
  {
    type: "admin",
    id: "1000001",
    name: "Mock Support",
    email: "support@mock.intercom.local",
    job_title: "Member Support",
    away_mode_enabled: false,
    away_mode_reassign: false,
    has_inbox_seat: true,
    team_ids: [],
  },
  {
    type: "admin",
    id: "1000002",
    name: "Mock Clinician",
    email: "clinician@mock.intercom.local",
    job_title: "Longevity Specialist",
    away_mode_enabled: false,
    away_mode_reassign: false,
    has_inbox_seat: true,
    team_ids: [],
  },
]

const hex = (input: string, length: number) =>
  [...opaqueToken(input, length)].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")

export class IntercomState {
  readonly contacts: Collection<ContactRecord>
  readonly conversations: Collection<ConversationRecord>
  readonly admins: Collection<AdminRecord>
  readonly settings: Collection<Settings>
  readonly counters: Collection<number>
  readonly outbox: OutboxStore<OutboxRecord>
  readonly workspaceId: string

  constructor(
    sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly seed: { admins: readonly AdminRecord[]; settings: Partial<Settings> },
  ) {
    this.contacts = new Collection(sqlite, namespace, "contacts")
    this.conversations = new Collection(sqlite, namespace, "conversations")
    this.admins = new Collection(sqlite, namespace, "admins")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.outbox = new OutboxStore<OutboxRecord>(sqlite, namespace, "outbox")
    this.workspaceId = "mockapp"
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.admins.count() === 0) {
      for (const admin of this.seed.admins) this.admins.insert(admin.id, admin)
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

  /** The next value of a named counter (1, 2, …), reset with the namespace. */
  next(name: string): number {
    const value = (this.counters.get(name) ?? 0) + 1
    this.counters.insert(name, value)
    return value
  }

  /** A 24-hex contact id, like Intercom's. */
  nextContactId(): string {
    return hex(`intercom:contact:${this.namespace}:${this.next("contact")}`, 24)
  }

  /** A numeric-string conversation id, like Intercom's. */
  nextConversationId(): string {
    return String(215_470_000_000_000 + this.next("conversation"))
  }

  nextPartId(): string {
    return String(30_000_000_000 + this.next("part"))
  }

  nextMessageId(): string {
    return String(40_000_000_000 + this.next("message"))
  }

  nextRequestId(): string {
    return `req_${hex(`intercom:request:${this.namespace}:${this.next("request")}`, 20)}`
  }

  nextNotificationId(): string {
    return `notif_${hex(`intercom:notification:${this.namespace}:${this.next("notification")}`, 32)}`
  }

  findContact(where: (contact: ContactRecord) => boolean): ContactRecord | undefined {
    return this.contacts.list({ order: "oldest", where }).at(0)?.value
  }
}
