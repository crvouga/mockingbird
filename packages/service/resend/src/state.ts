import { Collection, IdempotencyStore, IdSequence, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * One email the app "sent" (`POST /emails`): what `GET /__admin/outbox` returns. `to`, `cc` and
 * `bcc` hold bare lower-cased addresses (so `?to=` matches `Name <a@b.co>` recipients);
 * `toHeader` keeps them as sent. Attachments keep metadata only.
 */
export type SentEmail = {
  id: string
  from: string
  to: string[]
  toHeader: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  html: string | null
  text: string | null
  tags: { name: string; value: string }[]
  headers: Record<string, string>
  attachments: { filename: string; contentType: string | null; size: number }[]
  idempotencyKey: string | null
  scheduledAt: string | null
  createdAt: string
}

export type ReceivedAttachmentRecord = {
  id: string
  filename: string
  content_type: string
  content_disposition: string | null
  content_id: string | null
  size: number
  /** Base64 bytes, served by the download URL. */
  content: string
}

/** One inbound email (`POST /__admin/inbound`), as `GET /emails/receiving/{id}` serves it. */
export type ReceivedEmail = {
  id: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string | null
  html: string | null
  text: string | null
  headers: Record<string, string>
  messageId: string
  attachments: ReceivedAttachmentRecord[]
  createdAt: string
}

export class ResendState {
  readonly outbox: OutboxStore<SentEmail>
  readonly received: Collection<ReceivedEmail>
  /** Attachment id → received email id, for the unauthenticated download URL. */
  readonly attachmentIndex: Collection<{ emailId: string }>
  readonly idempotency: IdempotencyStore
  private readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    this.outbox = new OutboxStore(sqlite, namespace, "outbox")
    this.received = new Collection(sqlite, namespace, "received")
    this.attachmentIndex = new Collection(sqlite, namespace, "attachment_index")
    this.idempotency = new IdempotencyStore(sqlite, namespace)
    this.ids = new IdSequence(sqlite, namespace, "resend")
  }

  /** A UUID-shaped id, deterministic for a given history (Resend ids are UUIDs). */
  nextId(kind: "email" | "received" | "attachment"): string {
    const token = this.ids.next(`${kind}_`, 32).slice(kind.length + 1)
    const hex = [...token].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}
