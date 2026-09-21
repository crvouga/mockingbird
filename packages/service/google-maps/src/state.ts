import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type CorpusAddress, DEFAULT_CORPUS } from "./corpus.js"

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these API keys are accepted; empty means any non-empty key is. */
  keys: string[]
  /**
   * Origin the Maps JavaScript shim calls back to, when the browser reaches the mock at a
   * different address than the request that loaded the script (a rewriting proxy).
   */
  publicUrl: string | null
}

export const DEFAULT_SETTINGS: Settings = { keys: [], publicUrl: null }

export class GoogleMapsState {
  /** Addresses a suite added to this namespace, on top of the built-in corpus. */
  readonly custom: Collection<CorpusAddress>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { corpus: readonly CorpusAddress[]; settings: Partial<Settings> },
  ) {
    this.custom = new Collection(sqlite, namespace, "addresses")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
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

  /** Custom rows first (a suite's own addresses win ties), then the built-in corpus. */
  corpus(): CorpusAddress[] {
    const custom = this.custom.list({ order: "oldest" }).map((row) => row.value)
    const ids = new Set(custom.map((row) => row.id))
    const base = this.seed.corpus.length > 0 ? this.seed.corpus : DEFAULT_CORPUS
    return [...custom, ...base.filter((row) => !ids.has(row.id))]
  }

  replaceCustom(rows: CorpusAddress[]): void {
    for (const { id } of this.custom.list()) this.custom.delete(id)
    for (const row of rows) this.custom.insert(row.id, row)
  }
}
