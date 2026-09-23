import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Script } from "./scripts.js"

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** What an unscripted chat call answers. Default `"OK."`. */
  defaultText: string
  /** Characters per streamed text delta when a turn gives no `chunkSize`. Default 16. */
  chunkSize: number
  /** Mock-clock delay before each streamed delta when a turn gives none. Default 0. */
  delayMsPerChunk: number
  /** Nova Sonic: USER audio frames that end a spoken turn without a contentEnd (0 = off). */
  audioTurnChunks: number
}

export const DEFAULT_SETTINGS: Settings = {
  defaultText: "OK.",
  chunkSize: 16,
  delayMsPerChunk: 0,
  audioTurnChunks: 0,
}

/** Counts for `GET /__admin/scripts` (and `/health`): metadata only. */
export type ModelStats = {
  calls: number
  scripted: number
  /** Calls no script answered (the defaults). */
  unscripted: number
  byScript: Record<string, number>
  /** Unscripted calls by which default answered them. */
  byFallback: Record<string, number>
  byOperation: Record<string, number>
}

const EMPTY_STATS: ModelStats = {
  calls: 0,
  scripted: 0,
  unscripted: 0,
  byScript: {},
  byFallback: {},
  byOperation: {},
}

export class BedrockState {
  readonly scripts: Collection<Script>
  readonly uses: Collection<number>
  readonly settings: Collection<Settings>
  readonly stats: Collection<ModelStats>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings>; scripts: readonly Script[] },
  ) {
    this.scripts = new Collection(sqlite, namespace, "scripts")
    this.uses = new Collection(sqlite, namespace, "script_uses")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.stats = new Collection(sqlite, namespace, "stats")
    this.ids = new IdSequence(sqlite, namespace, "bedrock")
    this.ensureSeeded()
  }

  /** Re-apply the configured settings and scripts after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
      for (const script of this.seed.scripts) this.scripts.insert(script.id, script)
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

  list(): Script[] {
    return this.scripts.list({ order: "oldest" }).map((row) => row.value)
  }

  /** Replace every script (`PUT`) or add/overwrite by id (`POST`). */
  put(scripts: readonly Script[], replace: boolean): Script[] {
    if (replace) {
      for (const row of this.scripts.list()) this.scripts.delete(row.id)
      for (const row of this.uses.list()) this.uses.delete(row.id)
    }
    for (const script of scripts) this.scripts.insert(script.id, script)
    return this.list()
  }

  remove(id?: string): number {
    const targets = id === undefined ? this.scripts.list().map((row) => row.id) : [id]
    let removed = 0
    for (const each of targets) {
      if (this.scripts.delete(each)) removed++
      this.uses.delete(each)
    }
    return removed
  }

  usesOf(id: string): number {
    return this.uses.get(id) ?? 0
  }

  use(id: string): void {
    this.uses.insert(id, this.usesOf(id) + 1)
  }

  /** The 0-based index of this model call in the namespace, then count it. */
  nextCallIndex(): number {
    const stats = this.currentStats()
    this.stats.insert("stats", { ...stats, calls: stats.calls + 1 })
    return stats.calls
  }

  record(operation: string, scriptId: string | undefined, fallback: string | undefined): void {
    const stats = this.currentStats()
    const bump = (map: Record<string, number>, key: string) => ({
      ...map,
      [key]: (map[key] ?? 0) + 1,
    })
    this.stats.insert("stats", {
      ...stats,
      scripted: stats.scripted + (scriptId !== undefined ? 1 : 0),
      unscripted: stats.unscripted + (scriptId === undefined ? 1 : 0),
      byScript: scriptId !== undefined ? bump(stats.byScript, scriptId) : stats.byScript,
      byFallback:
        scriptId === undefined ? bump(stats.byFallback, fallback ?? "chat") : stats.byFallback,
      byOperation: bump(stats.byOperation, operation),
    })
  }

  currentStats(): ModelStats {
    return this.stats.get("stats") ?? EMPTY_STATS
  }
}
