import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type PresenceRecord = {
  /** Daily's participant session id. */
  id: string
  userId: string
  userName: string
  /** Mock-clock epoch ms the participant joined. */
  joinedAtMs: number
}

export type SessionRecord = {
  sessionId: string
  durationSec: number
  participants: number
  /** `s3://bucket/key` of the transcript, when S3 is configured. */
  transcript: string | null
  endedAt: string
}

/** One room as Daily tracks it: the properties it was given, echoed back as `config`. */
export type RoomRecord = {
  id: string
  name: string
  privacy: "public" | "private"
  url: string
  created_at: string
  config: Record<string, unknown>
  presence: PresenceRecord[]
  sessions: SessionRecord[]
}

/** Something odd a caller sent that the mock tolerated (Daily would too, or would misread it). */
export type WarningRecord = {
  at: string
  operationId: string
  subject: string
  field: string
  value: unknown
  message: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Accepted `DAILY_API_KEY`s. Empty: any bearer key is accepted. */
  apiKeys: string[]
  /** `DAILY_API_DOMAIN_ID`, stamped as `d` in minted tokens and checked in decoded ones. */
  domainId: string
  /** Room URLs are `<roomUrlBase><name>` (`https://<domain>.daily.co/`). */
  roomUrlBase: string
}

export const DEFAULT_SETTINGS: Settings = {
  apiKeys: [],
  domainId: "00000000-0000-4000-8000-00000000da11",
  roomUrlBase: "https://mockingbird.daily.co/",
}

export class DailyState {
  readonly rooms: Collection<RoomRecord>
  readonly warnings: Collection<WarningRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.rooms = new Collection(sqlite, namespace, "rooms")
    this.warnings = new Collection(sqlite, namespace, "warnings")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "daily")
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

  warn(warning: WarningRecord): void {
    this.warnings.insert(this.ids.next("warn_", 12), warning)
  }

  /** A Daily-style random room name (20 alphanumerics), deterministic per sequence. */
  nextRoomName(): string {
    return this.ids.next("", 20)
  }

  /** A UUID-shaped id, deterministic per sequence. */
  nextUuid(kind: string): string {
    const raw = this.ids
      .next(kind, 32)
      .slice(kind.length)
      .split("")
      .map((c) => (c.charCodeAt(0) % 16).toString(16))
      .join("")
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`
  }
}
