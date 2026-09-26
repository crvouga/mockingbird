import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { adminRow, OTEL_NAMESPACE, OtelAPI, otelCredential } from "./index.js"
import { formatKey, type Row } from "./otlp.js"
import type { Organization, Settings, StoredRow } from "./state.js"

const rpc = (code: number, message: string) => ({ code, message })

/**
 * Every named collector misbehaviour our exporters branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). The SDK retries 429,
 * 502, 503 and 504 (honouring `retry-after`) and drops everything else.
 */
export const OTEL_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Exports answer 429 with retry-after: 1 (the SDK retries)",
    rules: [
      {
        pathPrefix: "/v1/",
        status: 429,
        headers: { "retry-after": "1" },
        body: rpc(8, "rate limited"),
      },
    ],
  },
  bad_gateway: {
    description: "Exports answer 502 (the SDK retries)",
    rules: [{ pathPrefix: "/v1/", status: 502, body: rpc(14, "bad gateway") }],
  },
  unavailable: {
    description: "Exports answer 503 (the SDK retries)",
    rules: [{ pathPrefix: "/v1/", status: 503, body: rpc(14, "unavailable") }],
  },
  gateway_timeout: {
    description: "Exports answer 504 (the SDK retries)",
    rules: [{ pathPrefix: "/v1/", status: 504, body: rpc(4, "deadline exceeded") }],
  },
  server_error: {
    description: "Exports answer 500 (the SDK drops the batch: not retryable)",
    rules: [{ pathPrefix: "/v1/", status: 500, body: rpc(13, "internal error") }],
  },
  unauthorized: {
    description: "Exports answer 401 as if OTEL_AUTH_TOKEN were wrong (dropped, never retried)",
    rules: [{ pathPrefix: "/v1/", status: 401, body: rpc(16, "Unauthenticated") }],
  },
  partial_success: {
    description:
      "Exports answer 200 with partialSuccess rejecting every item (JSON only); nothing is stored",
    rules: [{ pathPrefix: "/v1/", effect: "partial_success" }],
  },
  search_unavailable: {
    description: "O2 search answers 503 (our clients degrade: empty hops, error result)",
    rules: [
      { operationId: "Search", status: 503, body: { code: 503, message: "Service Unavailable" } },
    ],
  },
}

export type OtelRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type OtelRuntime = ServiceRuntime<OtelAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Loose match of a `where` value against a stored column (numbers and strings compare as text). */
const same = (a: unknown, b: unknown): boolean =>
  a !== undefined && a !== null && String(a) === String(b)

/**
 * `where` keys are taken as the emitter wrote them (`clientUserId`, `service.name`) or as O2
 * stores them (`clientuserid`, `service_name`); both resolve to the stored column.
 */
const matchesWhere = (row: Row, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key in row) return same(row[key], value)
    const formatted = formatKey(key)
    if (formatted in row) return same(row[formatted], value)
    return same(row[`service_${formatted}`], value)
  })

const WAIT_POLL_MS = 20
const MAX_WAIT_MS = 60_000

const adminRoutes = (runtime: ServiceRuntime<OtelAPI>): AdminRoutes => {
  const select = (
    namespace: string,
    kind: "log" | "span",
    where: Record<string, unknown>,
    org?: string | null,
  ): StoredRow[] => {
    const api = runtime.instance(namespace)
    return (kind === "log" ? api.logs() : api.spans()).filter(
      (stored) =>
        (org === undefined || org === null || stored.org === org) &&
        matchesWhere(stored.row, where),
    )
  }
  return {
    "GET /logs": ({ url, namespace }) => {
      const where: Record<string, unknown> = {}
      const service = url.searchParams.get("service")
      const event = url.searchParams.get("event")
      const trace = url.searchParams.get("trace_id")
      if (service !== null) where.service_name = service
      if (event !== null) where.event = event
      if (trace !== null) where.trace_id = trace
      const severity = url.searchParams.get("severity")?.toLowerCase()
      const logs = select(namespace, "log", where, url.searchParams.get("org")).filter(
        (stored) =>
          severity === undefined ||
          String(stored.row.severity_text ?? "").toLowerCase() === severity,
      )
      return json(200, { logs: logs.map(adminRow) })
    },
    "GET /spans": ({ url, namespace }) => {
      const where: Record<string, unknown> = {}
      const service = url.searchParams.get("service")
      const name = url.searchParams.get("name")
      const trace = url.searchParams.get("trace_id")
      if (service !== null) where.service_name = service
      if (name !== null) where.operation_name = name
      if (trace !== null) where.trace_id = trace
      return json(200, {
        spans: select(namespace, "span", where, url.searchParams.get("org")).map(adminRow),
      })
    },
    /**
     * `{kind: "log"|"span", where: {event: "…"}, count?: 1, timeoutMs?: 5000, org?}`:
     * long-polls until `count` rows match, then answers them; 408 with what matched so far.
     */
    "POST /wait": async ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, 'expected {"kind": "log", "where": {...}}')
      const kind = body.kind ?? "log"
      if (kind !== "log" && kind !== "span") return adminError(400, 'kind must be "log" or "span"')
      const where = body.where ?? {}
      if (!isRecord(where)) return adminError(400, "where must be an object of column: value")
      const count = typeof body.count === "number" && body.count > 0 ? body.count : 1
      const timeoutMs = Math.min(
        typeof body.timeoutMs === "number" && body.timeoutMs >= 0 ? body.timeoutMs : 5_000,
        MAX_WAIT_MS,
      )
      const org = typeof body.org === "string" ? body.org : undefined
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const matched = select(namespace, kind, where, org)
        if (matched.length >= count) {
          return json(200, { matched: matched.map(adminRow), count: matched.length })
        }
        if (Date.now() >= deadline) {
          return json(408, {
            error: {
              type: "mockingbird_admin",
              message: `timed out after ${timeoutMs} ms: ${matched.length}/${count} ${kind}s matched`,
            },
            matched: matched.map(adminRow),
            count: matched.length,
          })
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
      }
    },
    "GET /otlp-metrics": ({ namespace }) => json(200, runtime.instance(namespace).state.metrics()),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.ingestTokens !== undefined) {
        if (!Array.isArray(body.ingestTokens)) return adminError(400, "ingestTokens: string[]")
        patch.ingestTokens = body.ingestTokens.map(String)
      }
      if (body.searchUsers !== undefined) {
        if (!Array.isArray(body.searchUsers) || !body.searchUsers.every(isRecord)) {
          return adminError(400, "searchUsers: [{username, password}]")
        }
        patch.searchUsers = body.searchUsers.map((u) => ({
          username: String(u.username),
          password: String(u.password ?? ""),
        }))
      }
      if (body.organizations !== undefined) {
        if (
          !Array.isArray(body.organizations) ||
          !body.organizations.every(
            (o) => isRecord(o) && typeof o.identifier === "string" && typeof o.name === "string",
          )
        ) {
          return adminError(400, "organizations: [{identifier, name}]")
        }
        patch.organizations = body.organizations as Organization[]
      }
      if (body.routing !== undefined) {
        const routing = body.routing
        if (
          !isRecord(routing) ||
          typeof routing.default !== "string" ||
          !isRecord(routing.byEnvironment)
        ) {
          return adminError(
            400,
            "routing: {byEnvironment: {<env>: <org name>}, default: <org name>}",
          )
        }
        patch.routing = {
          default: routing.default,
          byEnvironment: Object.fromEntries(
            Object.entries(routing.byEnvironment).map(([k, v]) => [k, String(v)]),
          ),
        }
      }
      if (body.keepBodies !== undefined) {
        if (typeof body.keepBodies !== "boolean") return adminError(400, "keepBodies: boolean")
        patch.keepBodies = body.keepBodies
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  }
}

/**
 * The OTLP collector + OpenObserve search mock with Mockingbird's full service contract:
 * `/health`, `/__admin/*` (logs, spans, wait), namespaces by header, by `/ns/<name>` path
 * prefix, or by credential (the OTLP bearer token or the O2 Basic username), clock control and
 * fault presets.
 */
export const createRuntime = (options: OtelRuntimeOptions = {}): OtelRuntime =>
  createServiceRuntime<OtelAPI>({
    name: OTEL_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: otelCredential,
    presets: OTEL_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new OtelAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    describe: () => ({ keepBodies: options.settings?.keepBodies === true }),
    admin: adminRoutes,
  })
