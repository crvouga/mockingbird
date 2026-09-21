import { Collection, IdSequence, type OutboxItem, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { ValidationError } from "./phone.js"

export type VerificationStatus = "pending" | "approved" | "canceled" | "expired"

/**
 * One Verify verification. `code` never leaves the mock through the vendor API: tests read it
 * with `GET /__admin/verify/:e164/latest` (or from the outbox), as a phone would receive it.
 */
export type VerificationRecord = {
  sid: string
  serviceSid: string
  accountSid: string
  to: string
  channel: string
  code: string
  status: VerificationStatus
  /** Check attempts made against this verification (right or wrong). */
  attempts: number
  sendAttempts: { attemptSid: string; channel: string; time: string; timeMs: number }[]
  createdAtMs: number
  dateCreated: string
  dateUpdated: string
}

/** A Message resource as `Messages.json` answers it. */
export type MessageRecord = {
  sid: string
  account_sid: string
  api_version: "2010-04-01"
  body: string
  to: string
  from: string | null
  messaging_service_sid: string | null
  status: "queued" | "accepted"
  direction: "outbound-api"
  num_segments: string
  num_media: string
  price: null
  price_unit: "USD"
  error_code: null
  error_message: null
  date_created: string
  date_updated: string
  date_sent: null
  uri: string
  subresource_uris: { media: string; feedback: string }
}

export type RecordingRecord = {
  sid: string
  accountSid: string
  callSid: string
  /** The WAV exactly as served with `RequestedChannels=2`. */
  wavBase64: string
  channels: number
  duration: number
  createdAt: string
  deleted: boolean
}

/** What the mock "sent": outbound SMS and every Verify code delivery. */
export type TwilioOutboxItem = OutboxItem & {
  kind: "sms" | "verify"
  sid: string
  to: string
  from: string | null
  messagingServiceSid: string | null
  body: string
  channel: string
  /** The Verify code, for `kind: "verify"`. */
  code?: string
  mediaUrls?: string[]
}

export type LookupOverride = { valid: boolean; validationErrors: ValidationError[] }

/** Per-namespace Verify knobs, set through `PUT /__admin/verify`; cleared on reset. */
export type VerifySettings = {
  /** Every new verification gets this code; `null` means a random 6-digit code. */
  fixedCode: string | null
  /** Verifications expire this long after creation, on the mock clock (Twilio: 10 min). */
  ttlSeconds: number
  /** Checks allowed per verification; the next one is 429 60202. */
  maxCheckAttempts: number
  /** Sends allowed per number and service within `sendWindowSeconds`; the next is 429 60203. */
  maxSendAttempts: number
  sendWindowSeconds: number
}

export const DEFAULT_VERIFY_SETTINGS: VerifySettings = {
  fixedCode: null,
  ttlSeconds: 600,
  maxCheckAttempts: 5,
  maxSendAttempts: 5,
  sendWindowSeconds: 600,
}

/** FNV-1a, mixed; the same family `opaqueToken` uses. */
const mix = (input: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  return hash >>> 0
}

/** Deterministic lowercase hex of `length` characters derived from `input`. */
export const hexOf = (input: string, length = 32): string => {
  let out = ""
  for (let round = 0; out.length < length; round++) {
    out += mix(`${input}:${round}`).toString(16).padStart(8, "0")
  }
  return out.slice(0, length)
}

/** Deterministic digits of `length` derived from `input` (a Verify code). */
export const digitsOf = (input: string, length = 6): string => {
  let out = ""
  for (let round = 0; out.length < length; round++) {
    out += String(mix(`${input}:${round}`) % 1_000_000_000).padStart(9, "0")
  }
  return out.slice(0, length)
}

export class TwilioState {
  readonly verifications: Collection<VerificationRecord>
  readonly messages: Collection<MessageRecord>
  readonly recordings: Collection<RecordingRecord>
  readonly lookups: Collection<LookupOverride>
  readonly settings: Collection<VerifySettings>
  readonly outbox: OutboxStore<TwilioOutboxItem>
  private readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly seed: Partial<VerifySettings> = {},
  ) {
    this.verifications = new Collection(sqlite, namespace, "verifications")
    this.messages = new Collection(sqlite, namespace, "messages")
    this.recordings = new Collection(sqlite, namespace, "recordings")
    this.lookups = new Collection(sqlite, namespace, "lookups")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.outbox = new OutboxStore(sqlite, namespace)
    this.ids = new IdSequence(sqlite, namespace, "twilio")
  }

  /** A Twilio sid: two-letter prefix plus 32 hex characters, deterministic per history. */
  sid(prefix: string): string {
    return `${prefix}${hexOf(`${this.namespace}:${this.ids.next(prefix)}`)}`
  }

  /** A random-looking but reproducible 6-digit code for a new verification. */
  code(sid: string, length = 6): string {
    return digitsOf(`${this.namespace}:code:${sid}`, length)
  }

  verify(): VerifySettings {
    return this.settings.get("verify") ?? { ...DEFAULT_VERIFY_SETTINGS, ...this.seed }
  }

  updateVerify(patch: Partial<VerifySettings>): VerifySettings {
    const next = { ...this.verify(), ...patch }
    if (this.settings.has("verify")) this.settings.update("verify", next)
    else this.settings.insert("verify", next)
    return next
  }

  /** Newest first. */
  verificationsTo(to: string, serviceSid?: string): VerificationRecord[] {
    return this.verifications
      .list({
        where: (v) => v.to === to && (serviceSid === undefined || v.serviceSid === serviceSid),
      })
      .map((row) => row.value)
  }
}
