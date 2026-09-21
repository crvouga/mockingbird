import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { FlagRecord, FlagSpec } from "./flags.js"

/**
 * One captured event, reduced to what a test asserts on. `$exception` events keep only their
 * name and ids, and free-text properties (messages, bodies, stacks) are dropped from every
 * event before it is stored.
 */
export type CapturedEvent = {
  uuid: string
  event: string
  distinct_id: string
  properties: Record<string, unknown>
  /** The client's timestamp, or the mock clock's when it sent none. */
  timestamp: string
  /** Mock-clock epoch ms the mock received it. */
  receivedAtMs: number
  /** `/batch/`, `/e/`, `/i/v0/e/`. */
  endpoint: string
}

/** A canned HogQL answer: the first whose `match` occurs in the query wins. */
export type QueryResult = {
  match?: string
  columns?: string[]
  results: unknown[][]
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Remote config `sessionRecording`: `false` (default) or `{endpoint: "/s/"}`. */
  sessionRecording: boolean
  /** Canned `POST /api/projects/{id}/query/` answers. */
  queryResults: QueryResult[]
  /** Times `POST /__admin/flags/bump` was called (a marker; nothing else changes). */
  generation: number
  /** Session-recording posts to `/s/`, counted and discarded. */
  recordings: number
}

export const DEFAULT_SETTINGS: Settings = {
  sessionRecording: false,
  queryResults: [],
  generation: 0,
  recordings: 0,
}

export class PostHogState {
  readonly flags: Collection<FlagRecord>
  readonly events: Collection<CapturedEvent>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { flags: Record<string, FlagSpec>; settings: Partial<Settings> },
    private readonly now: () => number,
  ) {
    this.flags = new Collection(sqlite, namespace, "flags")
    this.events = new Collection(sqlite, namespace, "events")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "posthog")
    this.ensureSeeded()
  }

  /** Re-apply the seed flags and settings after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
      for (const [key, spec] of Object.entries(this.seed.flags)) this.putFlag(key, spec)
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

  /** Flags in creation order (PostHog lists by id). */
  listFlags(): FlagRecord[] {
    return this.flags
      .list({ order: "oldest" })
      .map((row) => row.value)
      .sort((a, b) => a.id - b.id)
  }

  findFlag(idOrKey: string): FlagRecord | undefined {
    return (
      this.flags.get(idOrKey) ??
      this.listFlags().find((flag) => String(flag.id) === idOrKey && !flag.deleted)
    )
  }

  private nextFlagId(): number {
    return this.listFlags().reduce((max, flag) => Math.max(max, flag.id), 0) + 1
  }

  /** Create or replace a flag (keeping its id, bumping its version). */
  putFlag(key: string, spec: FlagSpec): FlagRecord {
    const existing = this.flags.get(key)
    const iso = new Date(this.now()).toISOString()
    const record: FlagRecord = {
      id: existing?.id ?? this.nextFlagId(),
      key,
      name: spec.name ?? existing?.name ?? "",
      active: spec.active ?? true,
      deleted: false,
      default: spec.default,
      payload: spec.payload,
      overrides: spec.overrides,
      version: (existing?.version ?? 0) + 1,
      created_at: existing?.created_at ?? iso,
      updated_at: iso,
    }
    this.flags.insert(key, record)
    return record
  }

  patchFlag(key: string, patch: Partial<FlagRecord>): FlagRecord | undefined {
    const existing = this.flags.get(key)
    if (!existing) return undefined
    const record: FlagRecord = {
      ...existing,
      ...patch,
      version: existing.version + 1,
      updated_at: new Date(this.now()).toISOString(),
    }
    this.flags.insert(key, record)
    return record
  }

  nextEventId(): string {
    return this.ids.next("evt_", 20)
  }
}
