/**
 * Ports of our OpenObserve clients (geviti-monorepo, `crvouga/makor-voice-chat`):
 *
 * - backend `OpenObserveBloodworkClient` (`B/bloodwork/ops/openobserve-bloodwork.client.ts`):
 *   org identifier lookup with display-name fallback, schema-field cache, `searchSql`.
 * - the ops feed's hop query (`bloodwork-ops.join.ts` `buildBloodworkOpsO2Sql`,
 *   `hopFromOpenObserveHit`) and paging (`bloodwork-ops.service.ts` `searchAllHopHits`).
 * - `packages/agent-investigate/src/o2/client.ts` `createO2Client` and its recipes
 *   (`o2/recipes.ts`).
 * - release-conductor `countErrors` (`tooling/release-conductor/src/clients/openobserve.ts`),
 *   which puts the org display name in the path.
 *
 * The same requests, headers, field fallbacks and error handling; only `fetch` is injected.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type OpenObserveBloodworkHit = Record<string, unknown>
export type OpenObserveBloodworkOrg = "development" | "production"

const SCHEMA_CACHE_TTL_MS = 5 * 60_000

/** Backend `OpenObserveBloodworkClient`. */
export class OpenObserveBloodworkClient {
  private readonly orgIdentifiers = new Map<OpenObserveBloodworkOrg, Promise<string>>()
  private readonly schemaCache = new Map<
    OpenObserveBloodworkOrg,
    { fetchedAt: number; fields: ReadonlySet<string> }
  >()

  constructor(private readonly deps: { baseUrl: string; auth: string; fetchImpl: Fetch }) {}

  async resolveOrgIdentifier(org: OpenObserveBloodworkOrg): Promise<string> {
    const cached = this.orgIdentifiers.get(org)
    if (cached) return cached
    const pending = this.lookupOrgIdentifier(org).then((identifier) => {
      if (identifier === null) {
        this.orgIdentifiers.delete(org)
        return org
      }
      return identifier
    })
    this.orgIdentifiers.set(org, pending)
    return pending
  }

  private async lookupOrgIdentifier(org: OpenObserveBloodworkOrg): Promise<string | null> {
    try {
      const res = await this.deps.fetchImpl(`${this.deps.baseUrl}/api/organizations`, {
        method: "GET",
        headers: { authorization: `Basic ${this.deps.auth}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return null
      const json: unknown = await res.json()
      const data =
        typeof json === "object" && json !== null
          ? (json as Record<string, unknown>).data
          : undefined
      if (!Array.isArray(data)) return null
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue
        const record = entry as Record<string, unknown>
        const identifier = record.identifier
        if (typeof identifier === "string" && (record.name === org || identifier === org)) {
          return identifier
        }
      }
      return null
    } catch {
      return null
    }
  }

  async streamFields(org: OpenObserveBloodworkOrg): Promise<ReadonlySet<string> | undefined> {
    const cached = this.schemaCache.get(org)
    if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_MS) return cached.fields
    try {
      const orgIdentifier = await this.resolveOrgIdentifier(org)
      const res = await this.deps.fetchImpl(
        `${this.deps.baseUrl}/api/${orgIdentifier}/streams/default/schema?type=logs`,
        {
          method: "GET",
          headers: { authorization: `Basic ${this.deps.auth}`, accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        },
      )
      if (!res.ok) return undefined
      const json: unknown = await res.json()
      const schema =
        typeof json === "object" && json !== null
          ? (json as Record<string, unknown>).schema
          : undefined
      if (!Array.isArray(schema)) return undefined
      const fields = new Set<string>()
      for (const entry of schema) {
        if (typeof entry !== "object" || entry === null) continue
        const name = (entry as Record<string, unknown>).name
        if (typeof name === "string") fields.add(name)
      }
      if (fields.size === 0) return undefined
      this.schemaCache.set(org, { fetchedAt: Date.now(), fields })
      return fields
    } catch {
      return undefined
    }
  }

  async searchSql(input: {
    org: OpenObserveBloodworkOrg
    sql: string
    startMs: number
    endMs: number
    from?: number
    size?: number
  }): Promise<OpenObserveBloodworkHit[]> {
    const orgIdentifier = await this.resolveOrgIdentifier(input.org)
    const res = await this.deps.fetchImpl(`${this.deps.baseUrl}/api/${orgIdentifier}/_search`, {
      method: "POST",
      headers: { authorization: `Basic ${this.deps.auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          sql: input.sql,
          start_time: input.startMs * 1000,
          end_time: input.endMs * 1000,
          from: input.from ?? 0,
          size: input.size ?? 500,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`openobserve HTTP ${res.status}`)
    const json: unknown = await res.json()
    const hits =
      typeof json === "object" && json !== null ? (json as Record<string, unknown>).hits : undefined
    if (!Array.isArray(hits)) return []
    return hits.filter(
      (hit): hit is OpenObserveBloodworkHit => typeof hit === "object" && hit !== null,
    )
  }
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`

/** `buildBloodworkOpsO2Sql`: lowercase columns, clauses dropped for fields the schema lacks. */
export function buildBloodworkOpsO2Sql(
  ids: {
    vitalOrderIds: string[]
    labResultIds: string[]
    entitlementIds: string[]
    orderIds: string[]
    clientUserIds?: string[]
  },
  availableFields?: ReadonlySet<string>,
): string | undefined {
  const clauses: string[] = []
  const clause = (column: string, values: string[]) => {
    if (values.length === 0) return
    if (availableFields && !availableFields.has(column)) return
    clauses.push(`${column} IN (${values.map(sqlString).join(",")})`)
  }
  clause("vitalorderid", ids.vitalOrderIds)
  clause("labresultid", ids.labResultIds)
  clause("entitlementid", ids.entitlementIds)
  clause("orderid", ids.orderIds)
  clause("clientuserid", ids.clientUserIds ?? [])
  if (clauses.length === 0) return undefined
  return `SELECT * FROM "default" WHERE event IS NOT NULL AND (${clauses.join(" OR ")}) ORDER BY _timestamp DESC`
}

export const HOP_PAGE_SIZE = 1000
export const HOP_MAX_PAGES = 10

/** `searchAllHopHits`: pages of 1000 until a short page, at most 10, de-duplicated. */
export async function searchAllHopHits(
  client: OpenObserveBloodworkClient,
  input: { org: OpenObserveBloodworkOrg; sql: string; startMs: number; endMs: number },
  pageSize = HOP_PAGE_SIZE,
): Promise<{ hits: OpenObserveBloodworkHit[]; truncated: boolean; pages: number }> {
  const seen = new Set<string>()
  const hits: OpenObserveBloodworkHit[] = []
  for (let page = 0; page < HOP_MAX_PAGES; page += 1) {
    const batch = await client.searchSql({ ...input, from: page * pageSize, size: pageSize })
    for (const hit of batch) {
      const key = JSON.stringify(hit)
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(hit)
    }
    if (batch.length < pageSize) return { hits, truncated: false, pages: page + 1 }
  }
  return { hits, truncated: true, pages: HOP_MAX_PAGES }
}

export const CORRELATION_KEYS = [
  "entitlementId",
  "orderId",
  "labResultId",
  "vitalOrderId",
  "providerPatientId",
  "clientUserId",
  "clientReferenceId",
  "labSlug",
  "labAccountId",
  "path",
  "trigger",
  "attempt",
  "reconcileRunId",
  "reason",
  "code",
  "statusCode",
  "vendorCategory",
] as const

const CORRELATION_KEY_BY_LOWER = new Map<string, string>(
  CORRELATION_KEYS.map((key) => [key.toLowerCase(), key]),
)
const NON_DETAIL_KEYS = new Set(["event", "env", "_timestamp", "timestamp", "occurredat"])

const lowerIndex = (hit: OpenObserveBloodworkHit) => {
  const index = new Map<string, unknown>()
  for (const [key, value] of Object.entries(hit)) {
    if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), value)
  }
  return index
}

const hopSeverity = (event: string) =>
  event.includes("failed") || event.endsWith("_error")
    ? "error"
    : event.includes("skipped") || event.includes("warn")
      ? "warn"
      : "info"

const hopOccurredAt = (index: Map<string, unknown>) => {
  const raw = index.get("_timestamp")
  if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) {
    return new Date(raw).toISOString()
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw) {
    return new Date(Math.floor(raw / 1000)).toISOString()
  }
  return new Date().toISOString()
}

export type BloodworkOpsHop = {
  event: string
  occurredAt: string
  severity: "error" | "warn" | "info"
  correlation: Record<string, unknown>
  detail: Record<string, unknown>
}

/** `hopFromOpenObserveHit` (env derivation omitted): lowercased hits back to camelCase keys. */
export function hopFromOpenObserveHit(hit: OpenObserveBloodworkHit): BloodworkOpsHop | undefined {
  const index = lowerIndex(hit)
  const event = index.get("event")
  if (typeof event !== "string" || event.length === 0) return undefined
  const correlation: Record<string, unknown> = {}
  const detail: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hit)) {
    if (value === undefined || value === null) continue
    const lower = key.toLowerCase()
    const canonical = CORRELATION_KEY_BY_LOWER.get(lower)
    if (canonical) correlation[canonical] = value
    else if (!NON_DETAIL_KEYS.has(lower) && !lower.startsWith("_") && !lower.startsWith("env_")) {
      detail[key] = value
    }
  }
  return {
    event,
    occurredAt: hopOccurredAt(index),
    severity: hopSeverity(event),
    correlation,
    detail,
  }
}

// ── packages/agent-investigate/src/o2 ─────────────────────────────────────────────────────

export const DEFAULT_SEARCH_SIZE = 50
export const MAX_SEARCH_SIZE = 1_000
export type O2Org = "development" | "production"
export type O2SearchResult =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; status: number | null; error: string }

const DEV_TOOL_NOISE = `('opencode', 'claude-code', 'cursor', 'codex')`

/** `createO2Client`: identifier lookup, `streamFields`, `search` with `sinceMs`. */
export function createO2Client(options: { basicAuth: string; baseUrl: string; fetchImpl: Fetch }) {
  const baseUrl = options.baseUrl.trim().replace(/\/$/, "")
  const fetchImpl = options.fetchImpl
  const auth = options.basicAuth.trim()
  if (!auth) throw new Error("O2_BASIC_AUTH is required")
  const orgIdentifiers = new Map<O2Org, Promise<string>>()

  async function lookupOrgIdentifier(org: O2Org): Promise<string | null> {
    try {
      const res = await fetchImpl(`${baseUrl}/api/organizations`, {
        method: "GET",
        headers: { authorization: `Basic ${auth}`, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return null
      const json: unknown = await res.json()
      const data =
        typeof json === "object" && json !== null
          ? (json as Record<string, unknown>).data
          : undefined
      if (!Array.isArray(data)) return null
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue
        const record = entry as Record<string, unknown>
        const identifier = record.identifier
        if (typeof identifier === "string" && (record.name === org || identifier === org)) {
          return identifier
        }
      }
      return null
    } catch {
      return null
    }
  }

  function resolveOrgIdentifier(org: O2Org): Promise<string> {
    const cached = orgIdentifiers.get(org)
    if (cached) return cached
    const pending = lookupOrgIdentifier(org).then((identifier) => {
      if (identifier === null) {
        orgIdentifiers.delete(org)
        return org
      }
      return identifier
    })
    orgIdentifiers.set(org, pending)
    return pending
  }

  async function streamFields(input: {
    org: O2Org
    stream?: string
  }): Promise<
    { ok: true; fields: Set<string> } | { ok: false; status: number | null; error: string }
  > {
    const stream = input.stream ?? "default"
    try {
      const orgIdentifier = await resolveOrgIdentifier(input.org)
      const res = await fetchImpl(
        `${baseUrl}/api/${orgIdentifier}/streams/${stream}/schema?type=logs`,
        {
          method: "GET",
          headers: { authorization: `Basic ${auth}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
      )
      const text = await res.text()
      if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 600) }
      const json: unknown = text ? JSON.parse(text) : {}
      const schema =
        typeof json === "object" && json !== null
          ? (json as Record<string, unknown>).schema
          : undefined
      if (!Array.isArray(schema)) {
        return {
          ok: false,
          status: res.status,
          error: "Malformed stream schema response: `schema` is missing or not an array",
        }
      }
      const fields = new Set<string>()
      for (const entry of schema) {
        if (typeof entry !== "object" || entry === null) continue
        const name = (entry as Record<string, unknown>).name
        if (typeof name === "string") fields.add(name)
      }
      return { ok: true, fields }
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function search(input: {
    org: O2Org
    sql: string
    sinceMs: number
    size?: number
  }): Promise<O2SearchResult> {
    const size = input.size ?? DEFAULT_SEARCH_SIZE
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SEARCH_SIZE) {
      return {
        ok: false,
        status: null,
        error: `size must be a positive integer up to ${String(MAX_SEARCH_SIZE)}, got ${String(input.size)}`,
      }
    }
    const endMs = Date.now()
    const startMs = endMs - input.sinceMs
    try {
      const orgIdentifier = await resolveOrgIdentifier(input.org)
      const res = await fetchImpl(`${baseUrl}/api/${orgIdentifier}/_search`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            sql: input.sql,
            start_time: startMs * 1000,
            end_time: endMs * 1000,
            from: 0,
            size,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 600) }
      const json: unknown = text ? JSON.parse(text) : {}
      if (typeof json !== "object" || json === null) {
        return {
          ok: false,
          status: res.status,
          error: "Malformed _search response (not an object)",
        }
      }
      const hits = (json as Record<string, unknown>).hits
      if (!Array.isArray(hits)) {
        return {
          ok: false,
          status: res.status,
          error: "Malformed _search response: `hits` is missing or not an array",
        }
      }
      const rows: Record<string, unknown>[] = []
      for (const hit of hits) {
        if (typeof hit !== "object" || hit === null) {
          return {
            ok: false,
            status: res.status,
            error: "Malformed _search response: `hits` contains a non-object entry",
          }
        }
        rows.push(hit as Record<string, unknown>)
      }
      return { ok: true, rowCount: rows.length, rows }
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { baseUrl, search, streamFields, resolveOrgIdentifier }
}

const escapeLiteral = (value: string) => value.replace(/'/g, "''")

export const BLOODWORK_STRUCTURED_EVENTS = [
  "bloodwork_entitlement_granted",
  "bloodwork_entitlement_claimed",
  "bloodwork_reconcile_decision",
  "junction_order_placed",
  "junction_order_failed",
  "bloodwork_webhook_received",
] as const

const BLOODWORK_EVENT_LIST = `(${BLOODWORK_STRUCTURED_EVENTS.map((event) => `'${event}'`).join(", ")})`

/** The agent-investigate recipes, verbatim SQL. */
export const O2_RECIPES = {
  "errors-recent": () =>
    `SELECT service_name, severity_text, body, trace_id, _timestamp
FROM "default"
WHERE severity_text IN ('ERROR', 'FATAL')
  AND service_name NOT IN ${DEV_TOOL_NOISE}
ORDER BY _timestamp DESC`,
  "errors-by-user": (p: { userId: string }) => {
    const id = escapeLiteral(p.userId)
    return `SELECT service_name, severity_text, body, trace_id, _timestamp
FROM "default"
WHERE severity_text IN ('ERROR', 'FATAL')
  AND (
    str_match(body, '${id}')
    OR str_match(tostring(clientuserid), '${id}')
    OR str_match(tostring(userid), '${id}')
  )
ORDER BY _timestamp DESC`
  },
  "errors-after-version": (p: { version: string }) =>
    `SELECT service_name, service_service_version, severity_text, body, trace_id, _timestamp
FROM "default"
WHERE severity_text IN ('ERROR', 'FATAL')
  AND service_service_version = '${escapeLiteral(p.version)}'
  AND service_name NOT IN ${DEV_TOOL_NOISE}
ORDER BY _timestamp DESC`,
  "logs-for-trace": (p: { traceId: string }) =>
    `SELECT service_name, severity_text, body, trace_id, span_id, _timestamp
FROM "default"
WHERE trace_id = '${escapeLiteral(p.traceId)}'
ORDER BY _timestamp ASC`,
  "bloodwork-errors": () =>
    `SELECT service_name, severity_text, event, code, reason, body, trace_id, _timestamp
FROM "default"
WHERE severity_text IN ('ERROR', 'FATAL')
  AND (
    event IN ${BLOODWORK_EVENT_LIST}
    OR str_match(lower(body), 'bloodwork')
    OR str_match(lower(body), 'lab.account')
    OR str_match(lower(body), 'junction')
  )
ORDER BY _timestamp DESC`,
  "junction-order-failures": () =>
    `SELECT code, statuscode, vendorcategory, clientuserid, COUNT(*) AS n
FROM "default"
WHERE event = 'junction_order_failed'
GROUP BY code, statuscode, vendorcategory, clientuserid
ORDER BY n DESC`,
  "junction-member-timeline": (p: { clientUserId: string }) =>
    `SELECT _timestamp, event, path, reason, code, statuscode, vendorcategory, attempt, trigger, reconcilerunid, vitalorderid, labresultid, orderid
FROM "default"
WHERE event IN ${BLOODWORK_EVENT_LIST}
  AND tostring(clientuserid) = '${escapeLiteral(p.clientUserId)}'
ORDER BY _timestamp ASC`,
} as const

// ── tooling/release-conductor ─────────────────────────────────────────────────────────────

/**
 * release-conductor `countErrors`: puts the display name `production` in the path. Real O2
 * answers 401 (routes are by identifier), so this throws `openobserve HTTP 401`.
 */
export const countErrors = async (
  cfg: { baseUrl: string; auth: string },
  startMs: number,
  endMs: number,
  fetchImpl: Fetch,
): Promise<number> => {
  const sql = `SELECT service_name, count(*) AS n FROM "default" WHERE severity_text IN ('ERROR','FATAL') AND service_name NOT IN ('opencode','claude-code-desktop','buildx','claude-code') GROUP BY service_name`
  const res = await fetchImpl(`${cfg.baseUrl}/api/production/_search`, {
    method: "POST",
    headers: { authorization: `Basic ${cfg.auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: { sql, start_time: startMs * 1000, end_time: endMs * 1000, from: 0, size: 100 },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`openobserve HTTP ${res.status}`)
  const json: unknown = await res.json()
  const hits =
    typeof json === "object" && json !== null ? (json as Record<string, unknown>).hits : undefined
  if (!Array.isArray(hits)) throw new Error("openobserve: malformed search response")
  let total = 0
  for (const hit of hits) {
    const n =
      typeof hit === "object" && hit !== null ? (hit as Record<string, unknown>).n : undefined
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new Error("openobserve: malformed search response")
    }
    total += n
  }
  return total
}

// ── emitting: OTLP/JSON exports as our winston/pino bridges produce them ──────────────────

export type LogInput = {
  event?: string
  severityText?: string
  severityNumber?: number
  body?: string
  timeMs?: number
  traceId?: string
  spanId?: string
  attributes?: Record<string, string | number | boolean>
}

const anyValue = (value: string | number | boolean) =>
  typeof value === "string"
    ? { stringValue: value }
    : typeof value === "boolean"
      ? { boolValue: value }
      : Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }

/** An `ExportLogsServiceRequest` as `@opentelemetry/exporter-logs-otlp-http` serialises it. */
export const logsExport = (
  resource: Record<string, string>,
  logs: LogInput[],
): Record<string, unknown> => ({
  resourceLogs: [
    {
      resource: {
        attributes: Object.entries(resource).map(([key, value]) => ({
          key,
          value: anyValue(value),
        })),
      },
      scopeLogs: [
        {
          scope: { name: "@geviti/telemetry/pino" },
          logRecords: logs.map((log) => ({
            timeUnixNano: `${BigInt(log.timeMs ?? Date.now()) * 1_000_000n}`,
            severityNumber: log.severityNumber ?? 9,
            severityText: log.severityText ?? "info",
            // Our bridges always send the log message as the body.
            body: { stringValue: log.body ?? `${log.event ?? "log"} message` },
            attributes: Object.entries({
              ...(log.event ? { event: log.event } : {}),
              ...log.attributes,
            }).map(([key, value]) => ({ key, value: anyValue(value) })),
            ...(log.traceId ? { traceId: log.traceId } : {}),
            ...(log.spanId ? { spanId: log.spanId } : {}),
          })),
        },
      ],
    },
  ],
})
