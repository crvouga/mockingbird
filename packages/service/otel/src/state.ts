import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Row, Scalar } from "./otlp.js"

export type StreamType = "logs" | "traces"

/** One ingested log record or span, as O2 stores it, in one org's stream. */
export type StoredRow = {
  /** Org identifier (not display name). */
  org: string
  stream: string
  type: StreamType
  row: Row
}

/** An O2 organization: queries route by `identifier`; `name` is what the UI shows. */
export type Organization = { identifier: string; name: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Bearer tokens the OTLP receiver accepts. Empty: any bearer token (none is a 401). */
  ingestTokens: string[]
  /** Basic-auth users the search API accepts. Empty: any Basic credentials (none is a 401). */
  searchUsers: { username: string; password: string }[]
  organizations: Organization[]
  /**
   * Where exports land, by display name: `deployment.environment.name` (or
   * `deployment.environment`) equal to a key here picks that org; anything else goes to
   * `default`. Mirrors the collector's production/dev-org split.
   */
  routing: { byEnvironment: Record<string, string>; default: string }
  /** Keep log bodies (local debugging only; they can hold prompts or PHI). */
  keepBodies: boolean
}

export const DEFAULT_ORGANIZATIONS: readonly Organization[] = [
  { identifier: "default", name: "default" },
  { identifier: "30rBqcDevOrg7Hn2KmQ4xW9sLtY", name: "development" },
  { identifier: "3HSzeProdOrg5Jd8VpN1cR6gTfB", name: "production" },
]

export const DEFAULT_SETTINGS: Settings = {
  ingestTokens: [],
  searchUsers: [],
  organizations: [...DEFAULT_ORGANIZATIONS],
  routing: { byEnvironment: { production: "production" }, default: "development" },
  keepBodies: false,
}

/** Column name → O2 (Arrow) type name, as `…/schema` reports it. */
export type SchemaFields = Record<string, "Utf8" | "Int64" | "Float64" | "Boolean">

export type MetricCounters = { requests: number; bytes: number; metrics: number }

export const typeOf = (value: Scalar): SchemaFields[string] =>
  typeof value === "boolean"
    ? "Boolean"
    : typeof value === "number"
      ? Number.isInteger(value)
        ? "Int64"
        : "Float64"
      : "Utf8"

export class OtelState {
  readonly rows: Collection<StoredRow>
  readonly schemas: Collection<SchemaFields>
  readonly counters: Collection<MetricCounters>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.rows = new Collection(sqlite, namespace, "rows")
    this.schemas = new Collection(sqlite, namespace, "schemas")
    this.counters = new Collection(sqlite, namespace, "counters")
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

  /** The org an export lands in, from its resource attributes. */
  routeOrg(resource: Record<string, Scalar>): string {
    const settings = this.current()
    const environment = String(
      resource["deployment.environment.name"] ?? resource["deployment.environment"] ?? "",
    )
    const name = settings.routing.byEnvironment[environment] ?? settings.routing.default
    const org = settings.organizations.find((o) => o.name === name || o.identifier === name)
    return org?.identifier ?? name
  }

  private schemaKey(org: string, stream: string, type: StreamType): string {
    return `${org}|${stream}|${type}`
  }

  schema(org: string, stream: string, type: StreamType): SchemaFields | undefined {
    return this.schemas.get(this.schemaKey(org, stream, type))
  }

  streams(org: string, type: StreamType): string[] {
    return this.schemas
      .list({ order: "oldest" })
      .map((r) => r.id.split("|"))
      .filter(([o, , t]) => o === org && t === type)
      .map(([, stream]) => stream as string)
  }

  /** Store a row and widen its stream's schema (null-valued fields never appear). */
  ingest(row: StoredRow, extraFields: SchemaFields = {}): void {
    this.rows.insert(`${row.type}:${this.rows.nextSequence()}`, row)
    const key = this.schemaKey(row.org, row.stream, row.type)
    const fields: SchemaFields = { ...(this.schemas.get(key) ?? { _timestamp: "Int64" }) }
    let changed = !this.schemas.has(key)
    for (const [name, value] of Object.entries({ ...row.row })) {
      if (!(name in fields)) {
        fields[name] = typeOf(value)
        changed = true
      }
    }
    for (const [name, type] of Object.entries(extraFields)) {
      if (!(name in fields)) {
        fields[name] = type
        changed = true
      }
    }
    if (changed) this.schemas.insert(key, fields)
  }

  list(filter: (row: StoredRow) => boolean): StoredRow[] {
    return this.rows
      .list({ order: "oldest", where: (value) => filter(value) })
      .map((stored) => stored.value)
  }

  count(metrics: number, bytes: number): MetricCounters {
    const current = this.counters.get("metrics") ?? { requests: 0, bytes: 0, metrics: 0 }
    const next = {
      requests: current.requests + 1,
      bytes: current.bytes + bytes,
      metrics: current.metrics + metrics,
    }
    this.counters.insert("metrics", next)
    return next
  }

  metrics(): MetricCounters {
    return this.counters.get("metrics") ?? { requests: 0, bytes: 0, metrics: 0 }
  }
}
