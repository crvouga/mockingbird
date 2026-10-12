import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { TEMPO_NAMESPACE, TempoAPI, tempoCredential } from "./index.js"
import { OtlpError } from "./otlp.js"
import { DEFAULT_SETTINGS, type Settings, SINGLE_TENANT } from "./state.js"

const TEXT = { "content-type": "text/plain; charset=utf-8" }

/** An ingest fault: the handler answers it as `google.rpc.Status` in the request's encoding. */
const ingestError = (status: number, code: number, message: string) => ({
  operationId: "ExportTraces",
  effect: "ingest_error",
  params: { status, code, message },
})

/**
 * Every named Tempo failure a trace reader or an exporter has to survive, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `"count": 1` for a one-shot). OTLP exporters
 * retry 429, 502, 503 and 504 and drop everything else.
 */
export const TEMPO_PRESETS: Record<string, FaultPreset> = {
  ingest_unavailable: {
    description: "Exports answer 503 UNAVAILABLE (exporters retry)",
    rules: [ingestError(503, 14, "unavailable")],
  },
  ingest_rate_limited: {
    description: "Exports answer 429 RESOURCE_EXHAUSTED, Tempo's ingestion rate limit (retried)",
    rules: [
      ingestError(
        429,
        8,
        "RATE_LIMITED: ingestion rate limit (local: 15000000 bytes/s, global: 0 bytes/s, burst: 20000000 bytes) exceeded while adding 1024 bytes for user single-tenant. consider increasing the limit or reducing ingestion rate.",
      ),
    ],
  },
  ingest_server_error: {
    description: "Exports answer 500 INTERNAL (exporters drop the batch: not retryable)",
    rules: [ingestError(500, 13, "internal error")],
  },
  ingest_dropped: {
    description: "The connection drops while exporting: the outcome is unknown to the exporter",
    rules: [{ operationId: "ExportTraces", drop: true }],
  },
  query_unavailable: {
    description: "Search, trace lookup and tags answer 503",
    rules: [{ pathPrefix: "/api/", status: 503, body: "Service Unavailable", headers: TEXT }],
  },
  query_server_error: {
    description: "Search, trace lookup and tags answer 500 internal error",
    rules: [{ pathPrefix: "/api/", status: 500, body: "internal error", headers: TEXT }],
  },
  query_rate_limited: {
    description: "Search, trace lookup and tags answer 429: the query queue is full",
    rules: [
      {
        pathPrefix: "/api/",
        status: 429,
        body: "too many outstanding requests",
        headers: TEXT,
      },
    ],
  },
  query_timeout: {
    description: "Search, trace lookup and tags answer 504 context deadline exceeded",
    rules: [{ pathPrefix: "/api/", status: 504, body: "context deadline exceeded", headers: TEXT }],
  },
  query_dropped: {
    description: "The connection drops on search, trace lookup and tags",
    rules: [{ pathPrefix: "/api/", drop: true }],
  },
  unauthorized: {
    description: "Every route answers the configured 401, as if the credentials were revoked",
    rules: [{ effect: "unauthorized" }],
  },
}

export type TempoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type TempoRuntime = ServiceRuntime<TempoAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** A `PUT /__admin/settings` body as a settings patch, or the reason it is not one. */
const parseSettings = (body: Record<string, unknown>): Partial<Settings> | string => {
  const patch: Partial<Settings> = {}
  if (body.bearerTokens !== undefined) {
    if (!strings(body.bearerTokens)) return "bearerTokens: string[]"
    patch.bearerTokens = body.bearerTokens
  }
  if (body.basicUsers !== undefined) {
    const users = body.basicUsers
    if (
      !Array.isArray(users) ||
      !users.every(
        (user) =>
          isRecord(user) &&
          typeof user.username === "string" &&
          user.username !== "" &&
          (user.password === undefined || typeof user.password === "string"),
      )
    ) {
      return "basicUsers: [{username, password}]"
    }
    patch.basicUsers = (users as { username: string; password?: string }[]).map((user) => ({
      username: user.username,
      password: user.password ?? "",
    }))
  }
  if (body.unauthorized !== undefined) {
    const value = body.unauthorized
    if (!isRecord(value)) return "unauthorized: {status?, body?, contentType?}"
    const status = value.status ?? DEFAULT_SETTINGS.unauthorized.status
    if (status !== 401 && status !== 403) return "unauthorized.status: 401 or 403"
    patch.unauthorized = {
      status: status as number,
      body: String(value.body ?? DEFAULT_SETTINGS.unauthorized.body),
      contentType: String(value.contentType ?? DEFAULT_SETTINGS.unauthorized.contentType),
    }
  }
  for (const key of ["multitenancy", "leftPadTraceIds"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "boolean") return `${key}: boolean`
    patch[key] = body[key]
  }
  for (const key of ["defaultLimit", "maxLimit"] as const) {
    const value = body[key]
    if (value === undefined) continue
    const minimum = key === "defaultLimit" ? 1 : 0
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
      return `${key}: an integer >= ${minimum}`
    }
    patch[key] = value
  }
  return patch
}

const adminRoutes = (runtime: ServiceRuntime<TempoAPI>): AdminRoutes => ({
  "GET /traces": ({ url, namespace }) =>
    json(200, {
      traces: runtime.instance(namespace).traces(url.searchParams.get("tenant") ?? undefined),
    }),
  /**
   * `{resourceSpans: [...], tenant?}`: an OTLP/JSON export stored as-is, with no credentials,
   * faults or tenant header in the way. Spans without a start time start at the emulator clock.
   */
  "POST /traces": ({ body, namespace }) => {
    if (!isRecord(body) || !Array.isArray(body.resourceSpans)) {
      return adminError(400, 'expected {"resourceSpans": [...], "tenant"?: "<org id>"}')
    }
    if (body.tenant !== undefined && (typeof body.tenant !== "string" || body.tenant === "")) {
      return adminError(400, "tenant: a non-empty string")
    }
    const tenant = body.tenant ?? SINGLE_TENANT
    try {
      const spans = runtime
        .instance(namespace)
        .inject({ resourceSpans: body.resourceSpans }, tenant)
      return json(200, {
        accepted: spans.length,
        tenant,
        traceIds: [...new Set(spans.map((span) => span.traceId))],
      })
    } catch (error) {
      if (error instanceof OtlpError) return adminError(400, error.message)
      throw error
    }
  },
  "GET /spans": ({ url, namespace }) => {
    const tenant = url.searchParams.get("tenant")
    const traceId = url.searchParams.get("traceId")
    return json(200, {
      spans: runtime.instance(namespace).spans({
        ...(tenant === null ? {} : { tenant }),
        ...(traceId === null ? {} : { traceId: traceId.toLowerCase().padStart(32, "0") }),
      }),
    })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch = parseSettings(body)
    if (typeof patch === "string") return adminError(400, patch)
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Tempo emulator with Mockingbird's full service contract: `/__admin/health`, `/__admin/*`
 * (traces, spans, settings), namespaces by header, by `/__admin/ns/<name>` path prefix or by
 * credential (a bearer token or a Basic username), clock control, checkpoints and fault presets.
 */
export const createRuntime = (options: TempoRuntimeOptions = {}): TempoRuntime =>
  createServiceRuntime<TempoAPI>({
    name: TEMPO_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tempoCredential,
    presets: TEMPO_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new TempoAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    describe: () => ({
      auth:
        (options.settings?.bearerTokens?.length ?? 0) +
          (options.settings?.basicUsers?.length ?? 0) >
        0
          ? "on"
          : "off",
      multitenancy: options.settings?.multitenancy === true,
    }),
    admin: adminRoutes,
  })
