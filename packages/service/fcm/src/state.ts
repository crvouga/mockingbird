import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export const FCM_FIXTURE_PROJECT = "demo-project"
export const FCM_FIXTURE_TOKEN = "fixture-device-token"
export const FCM_FIXTURE_BEARER = "fixture-token"

const SETTINGS_ID = "config"

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type TokenState = "active" | "expired" | "unregistered" | "sender_mismatch"
export type Platform = "ios" | "android"
export type MessageState = "accepted" | "delivered" | "dropped" | "expired" | "collapsed"

export type NotificationFields = {
  title?: string
  body?: string
  image?: string
}

export type InboxItem = {
  id: string
  messageId: string
  title: string | null
  body: string | null
  image: string | null
  data: Record<string, string> | null
  android: Record<string, unknown> | null
  apns: Record<string, unknown> | null
  platform: string
}

export type TokenRecord = {
  token: string
  project: string
  platform: Platform
  appId?: string
  state: TokenState
  replacement?: string
  inbox: InboxItem[]
}

export type MessageRecord = {
  upstream?: boolean
  sentForReal?: boolean
  id: string
  name: string
  project: string
  token: string
  platform: string
  acceptedAt: number
  notification: NotificationFields | null
  data: Record<string, string> | null
  android: Record<string, unknown> | null
  apns: Record<string, unknown> | null
  collapseKey: string | null
  ttl: string | null
  apnsExpiration: string | null
  expiresAtMs: number | null
  state: MessageState
  wire: unknown
}

export type CredentialRecord = {
  project: string
  expired?: boolean
}

export type Settings = {
  strict: boolean
  automaticDelivery: boolean
  collapse: boolean
  credentials: Record<string, CredentialRecord>
  /** Added to the process-wide runtime clock. Each namespace has its own offset. */
  clockOffsetMs: number
}

export type ScriptRecord = {
  errorCode: string
  count: number
  httpStatus?: number
}

export const DEFAULT_SETTINGS: Settings = {
  strict: false,
  automaticDelivery: true,
  collapse: false,
  credentials: {},
  clockOffsetMs: 0,
}

const TOKEN_STATES = new Set<TokenState>(["active", "expired", "unregistered", "sender_mismatch"])
const PLATFORMS = new Set<Platform>(["ios", "android"])

export const isTokenState = (value: string): value is TokenState =>
  TOKEN_STATES.has(value as TokenState)
export const isPlatform = (value: string): value is Platform => PLATFORMS.has(value as Platform)

export class FcmState {
  readonly tokens: Collection<TokenRecord>
  readonly messages: Collection<MessageRecord>
  readonly scripts: Collection<ScriptRecord>
  readonly ids: IdSequence
  private readonly settings: Collection<Settings>
  private readonly initial: Partial<Settings>

  constructor(sqlite: SqliteClient, namespace: string, initial: Partial<Settings> = {}) {
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.messages = new Collection(sqlite, namespace, "messages")
    this.scripts = new Collection(sqlite, namespace, "scripts")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, namespace)
    this.initial = initial
    this.ensure()
  }

  ensure(): Settings {
    const existing = this.settings.get(SETTINGS_ID)
    if (existing) return existing
    const created: Settings = {
      strict: this.initial.strict ?? DEFAULT_SETTINGS.strict,
      automaticDelivery: this.initial.automaticDelivery ?? DEFAULT_SETTINGS.automaticDelivery,
      collapse: this.initial.collapse ?? DEFAULT_SETTINGS.collapse,
      credentials: this.initial.credentials ?? DEFAULT_SETTINGS.credentials,
      clockOffsetMs: this.initial.clockOffsetMs ?? DEFAULT_SETTINGS.clockOffsetMs,
    }
    this.settings.insert(SETTINGS_ID, created)
    if (!this.tokens.has(FCM_FIXTURE_TOKEN)) {
      this.tokens.insert(FCM_FIXTURE_TOKEN, {
        token: FCM_FIXTURE_TOKEN,
        project: FCM_FIXTURE_PROJECT,
        platform: "android",
        state: "active",
        inbox: [],
      })
    }
    return created
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const current = this.ensure()
    const next: Settings = {
      strict: patch.strict ?? current.strict,
      automaticDelivery: patch.automaticDelivery ?? current.automaticDelivery,
      collapse: patch.collapse ?? current.collapse,
      credentials: patch.credentials ?? current.credentials,
      clockOffsetMs: patch.clockOffsetMs ?? current.clockOffsetMs,
    }
    this.settings.update(SETTINGS_ID, next)
    return next
  }
}
