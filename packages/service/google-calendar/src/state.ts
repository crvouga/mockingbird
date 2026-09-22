import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** A Google account as userinfo describes it. */
export type UserRecord = {
  sub: string
  email: string
  name: string
  given_name: string
  family_name: string
  picture: string
  email_verified: boolean
}

export type CalendarRecord = {
  id: string
  owner: string
  summary: string
  description?: string
  timeZone: string
  primary: boolean
  /** The opaque id push channels on this calendar's events report. */
  resourceId: string
}

/** An event exactly as the API returns it, plus bookkeeping. */
export type EventRecord = Record<string, unknown> & {
  kind: "calendar#event"
  etag: string
  id: string
  status: string
  created: string
  updated: string
  sequence: number
}

export type StoredEvent = {
  calendarId: string
  event: EventRecord
  /** Change sequence of the last write (incremental sync reads everything after a token's). */
  changeSeq: number
}

export type ChannelRecord = {
  id: string
  resourceId: string
  calendarId: string
  owner: string
  address: string
  token: string | null
  expirationMs: number
  messageNumber: number
  stopped: boolean
  resourceUri: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these OAuth clients get tokens; empty means any client id does. */
  clients: { clientId: string; clientSecret: string }[]
  /** Access-token lifetime on the mock clock. Default 3599 s, as Google issues. */
  tokenTtlSeconds: number
  /** Reject non-https watch addresses, as Google does. Default off, for local receivers. */
  requireHttpsWebhooks: boolean
  /** Longest channel lifetime; longer requested expirations are capped. Default 30 days. */
  maxChannelTtlSeconds: number
  /** Scope reported by the token endpoint. */
  scope: string
  /** Sync tokens issued before this change sequence answer 410. */
  syncTokensValidFrom: number
}

export const DEFAULT_SCOPE =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar"

export const DEFAULT_SETTINGS: Settings = {
  clients: [],
  tokenTtlSeconds: 3599,
  requireHttpsWebhooks: false,
  maxChannelTtlSeconds: 30 * 86_400,
  scope: DEFAULT_SCOPE,
  syncTokensValidFrom: 0,
}

type Counters = { change: number }

export class GoogleCalendarState {
  readonly users: Collection<UserRecord>
  readonly calendars: Collection<CalendarRecord>
  readonly events: Collection<StoredEvent>
  readonly channels: Collection<ChannelRecord>
  /** Used authorization codes and revoked tokens (by value). */
  readonly spent: Collection<{ kind: "code" | "revoked" }>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  private readonly counters: Collection<Counters>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.users = new Collection(sqlite, namespace, "users")
    this.calendars = new Collection(sqlite, namespace, "calendars")
    this.events = new Collection(sqlite, namespace, "events")
    this.channels = new Collection(sqlite, namespace, "channels")
    this.spent = new Collection(sqlite, namespace, "spent")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ids = new IdSequence(sqlite, namespace, "gcal")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
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

  /** The current change sequence, without advancing it. */
  changeSeq(): number {
    return this.counters.get("counters")?.change ?? 0
  }

  nextChange(): number {
    const next = this.changeSeq() + 1
    this.counters.insert("counters", { change: next })
    return next
  }

  eventKey(calendarId: string, eventId: string): string {
    return `${calendarId}/${eventId}`
  }
}
