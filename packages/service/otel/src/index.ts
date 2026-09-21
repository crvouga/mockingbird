import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { logRows, metricCount, type Row, spanRows } from "./otlp.js"
import {
  countMetricsRequest,
  decodeLogsRequest,
  decodeTraceRequest,
  ProtobufError,
} from "./protobuf.js"
import { execute, parseSql, referencedColumns, SqlError } from "./sql.js"
import { OtelState, type Settings, type StoredRow, type StreamType } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { IngestedRow, Row, Scalar } from "./otlp.js"
export { formatKey, logRows, spanRows } from "./otlp.js"
export { decodeLogsRequest, decodeTraceRequest, ProtobufError } from "./protobuf.js"
export type { Expr, Query } from "./sql.js"
export { execute, parseSql, referencedColumns, SqlError } from "./sql.js"
export type {
  MetricCounters,
  Organization,
  SchemaFields,
  Settings,
  StoredRow,
  StreamType,
} from "./state.js"
export { DEFAULT_ORGANIZATIONS, DEFAULT_SETTINGS } from "./state.js"

export const OTEL_NAMESPACE = "otel"

export type OtelAPIOptions = APIOptions & {
  /** Initial per-namespace settings (tokens, users, orgs, routing, keepBodies). */
  settings?: Partial<Settings>
}

const PROTOBUF = "application/x-protobuf"

/**
 * The credential a request carries, for `PUT /__admin/credentials`: the OTLP bearer token
 * (`OTEL_AUTH_TOKEN`) or the O2 Basic-auth username (from `O2_BASIC_AUTH`). Map both to the
 * same namespace so a worker's exports and searches meet.
 */
export const otelCredential = (request: Request): string | undefined =>
  bearerToken(request) ?? basicAuth(request)?.username

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mediaType = (request: Request) =>
  request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""

/** google.rpc.Status, the OTLP error body (code 16 = UNAUTHENTICATED, 3 = INVALID_ARGUMENT). */
const rpcStatus = (status: number, code: number, message: string) =>
  jsonRes(status, { code, message })

const unauthorized = () =>
  new Response("Unauthorized Access", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })

const o2Error = (status: number, message: string) => jsonRes(status, { code: status, message })

/**
 * Stateful mock of an OTLP/HTTP collector and the OpenObserve search API over one store.
 *
 * Exports land as O2-shaped rows in the org their `deployment.environment.name` routes to;
 * `POST /api/{org}/_search` runs our clients' SQL over them, so a test can emit a structured
 * `event` log and read it back exactly as the ops feed and the investigation agent do.
 */
export class OtelAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: OtelState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: OtelAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? OTEL_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new OtelState(sqlite, namespace, { settings: options.settings ?? {} })
    const handlers = defineOperations<SupportedOperationId>({
      ExportTraces: (context) => this.export(context, "traces"),
      ExportLogs: (context) => this.export(context, "logs"),
      ExportMetrics: (context) => this.export(context, "metrics"),
      ListOrganizations: () => this.organizations(),
      ListStreams: (context) => this.streams(context),
      GetStreamSchema: (context) => this.schema(context),
      Search: (context) => this.search(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { code: 404, message: "Not Found" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.gate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  /** Inflate `content-encoding: gzip` bodies (the exporters' `compression: "gzip"`). */
  async fetch(request: Request): Promise<Response> {
    const encoding = request.headers.get("content-encoding")?.toLowerCase()
    if (encoding !== "gzip" || request.body === null) return this.service.fetch(request)
    let inflated: ArrayBuffer
    try {
      inflated = await new Response(
        request.body.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer()
    } catch {
      return rpcStatus(400, 3, "invalid gzip body")
    }
    const headers = new Headers(request.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return this.service.fetch(
      new Request(request.url, { method: request.method, headers, body: inflated }),
    )
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  /** Every stored log row (with its org and stream), oldest first. */
  logs(): StoredRow[] {
    return this.state.list((r) => r.type === "logs")
  }

  /** Every stored span row, oldest first. */
  spans(): StoredRow[] {
    return this.state.list((r) => r.type === "traces")
  }

  private settings(): Settings {
    return this.state.current()
  }

  private gate(context: OperationContext): Response | undefined {
    const operationId = context.operation.operationId
    if (operationId.startsWith("Export")) {
      const token = bearerToken(context.request)
      const accepted = this.settings().ingestTokens
      if (!token || (accepted.length > 0 && !accepted.includes(token))) {
        return rpcStatus(401, 16, "Unauthenticated")
      }
      return undefined
    }
    const credentials = basicAuth(context.request)
    if (!credentials) return unauthorized()
    const users = this.settings().searchUsers
    if (
      users.length > 0 &&
      !users.some((u) => u.username === credentials.username && u.password === credentials.password)
    ) {
      return unauthorized()
    }
    const org = context.params.org
    // Real O2 routes by identifier: a display name (or any unknown org) is a bare 401.
    if (org !== undefined && !this.settings().organizations.some((o) => o.identifier === org)) {
      return unauthorized()
    }
    return undefined
  }

  private decode(
    context: OperationContext,
    kind: "traces" | "logs" | "metrics",
  ): { payload: Record<string, unknown>; protobuf: boolean; bytes: number } | Response {
    const type = mediaType(context.request)
    const body = context.body
    if (type === PROTOBUF) {
      const bytes = body.kind === "bytes" ? body.value : new Uint8Array(0)
      try {
        const payload =
          kind === "traces"
            ? decodeTraceRequest(bytes)
            : kind === "logs"
              ? decodeLogsRequest(bytes)
              : { resourceMetrics: new Array(countMetricsRequest(bytes)).fill({}) }
        return { payload, protobuf: true, bytes: bytes.length }
      } catch (error) {
        if (error instanceof ProtobufError) return rpcStatus(400, 3, error.message)
        throw error
      }
    }
    if (type !== "application/json") {
      return rpcStatus(415, 3, `unsupported content type ${type || "(none)"}`)
    }
    if (body.kind === "empty") return { payload: {}, protobuf: false, bytes: 0 }
    if (body.kind !== "json" || !isRecord(body.value)) {
      return rpcStatus(400, 3, "request body is not an OTLP/JSON export request")
    }
    return { payload: body.value, protobuf: false, bytes: JSON.stringify(body.value).length }
  }

  private export(context: OperationContext, kind: "traces" | "logs" | "metrics"): Response {
    const decoded = this.decode(context, kind)
    if (decoded instanceof Response) return decoded
    const { payload, protobuf } = decoded
    const ok = (partial: Record<string, unknown> = {}) =>
      protobuf
        ? new Response(new Uint8Array(0), { status: 200, headers: { "content-type": PROTOBUF } })
        : jsonRes(200, { partialSuccess: partial })
    if (kind === "metrics") {
      const count =
        protobuf && Array.isArray(payload.resourceMetrics)
          ? payload.resourceMetrics.length
          : metricCount(payload)
      this.state.count(count, decoded.bytes)
      return ok()
    }
    const nowMs = this.now()
    const rows =
      kind === "traces"
        ? spanRows(payload, { nowMs })
        : logRows(payload, { keepBodies: this.settings().keepBodies, nowMs })
    const rejected = faultEffect(context.request, "partial_success")
    if (rejected !== undefined) {
      const key = kind === "traces" ? "rejectedSpans" : "rejectedLogRecords"
      return ok({
        [key]: String(rows.length),
        errorMessage: String(rejected.message ?? "rejected by Mockingbird partial_success"),
      })
    }
    const stream = context.request.headers.get("stream-name")?.trim() || "default"
    const type: StreamType = kind === "traces" ? "traces" : "logs"
    const orgs = new Set<string>()
    for (const ingested of rows) {
      const org = this.state.routeOrg(ingested.resource)
      orgs.add(org)
      this.state.ingest(
        { org, stream, type, row: ingested.row },
        ingested.hadBody ? { body: "Utf8" } : {},
      )
    }
    return annotateResponse(ok(), {
      ids: {
        accepted: String(rows.length),
        ...(orgs.size > 0 ? { org: [...orgs].join(",") } : {}),
      },
    })
  }

  private organizations(): Response {
    return jsonRes(200, {
      data: this.settings().organizations.map((org, index) => ({
        id: index + 1,
        identifier: org.identifier,
        name: org.name,
        type: org.identifier === "default" ? "default" : "custom",
      })),
    })
  }

  private streamType(context: OperationContext): StreamType {
    return context.url.searchParams.get("type") === "traces" ? "traces" : "logs"
  }

  private streams(context: OperationContext): Response {
    const org = context.params.org as string
    const type = this.streamType(context)
    return jsonRes(200, {
      list: this.state.streams(org, type).map((name) => ({
        name,
        stream_type: type,
        storage_type: "disk",
        stats: {
          doc_num: this.state.list((r) => r.org === org && r.stream === name && r.type === type)
            .length,
        },
      })),
    })
  }

  private schema(context: OperationContext): Response {
    const org = context.params.org as string
    const stream = context.params.stream as string
    const type = this.streamType(context)
    const fields = this.state.schema(org, stream, type)
    if (!fields) return o2Error(404, `stream ${stream} not found`)
    const names = Object.keys(fields).sort((a, b) =>
      a === "_timestamp" ? -1 : b === "_timestamp" ? 1 : a.localeCompare(b),
    )
    return jsonRes(200, {
      name: stream,
      stream_type: type,
      storage_type: "disk",
      stats: {
        doc_num: this.state.list((r) => r.org === org && r.stream === stream && r.type === type)
          .length,
      },
      schema: names.map((name) => ({ name, type: fields[name] })),
      settings: { partition_keys: {}, full_text_search_keys: [], data_retention: 30 },
    })
  }

  private search(context: OperationContext): Response {
    const org = context.params.org as string
    const body = context.body.kind === "json" ? context.body.value : undefined
    const query = isRecord(body) && isRecord(body.query) ? body.query : undefined
    if (!query || typeof query.sql !== "string") {
      return o2Error(400, "Search SQL not supported: query.sql is required")
    }
    let parsed: ReturnType<typeof parseSql>
    try {
      parsed = parseSql(query.sql)
    } catch (error) {
      if (error instanceof SqlError)
        return o2Error(400, `Search SQL not supported: ${error.message}`)
      throw error
    }
    const type = this.streamType(context)
    const from = typeof query.from === "number" && query.from > 0 ? query.from : 0
    const size = typeof query.size === "number" ? query.size : -1
    const empty = (hits: Row[], total: number, scanned: number) =>
      annotateResponse(
        jsonRes(200, {
          took: 1,
          hits,
          total,
          from,
          size,
          cached_ratio: 0,
          scan_size: 0,
          scan_records: scanned,
          is_partial: false,
        }),
        { ids: { org } },
      )
    const fields = this.state.schema(org, parsed.stream, type)
    if (!fields) return empty([], 0, 0)
    const unknown = referencedColumns(parsed).find((name) => !(name in fields))
    if (unknown !== undefined) {
      return o2Error(
        400,
        `Search SQL execute error: Schema error: No field named ${unknown}. Valid fields are ${Object.keys(fields).sort().join(", ")}.`,
      )
    }
    const start = typeof query.start_time === "number" ? query.start_time : 0
    const end = typeof query.end_time === "number" && query.end_time > 0 ? query.end_time : Infinity
    const rows = this.state
      .list((r) => r.org === org && r.stream === parsed.stream && r.type === type)
      .map((r) => r.row)
      .filter((row) => {
        const ts = Number(row._timestamp)
        return ts >= start && ts <= end
      })
    let hits: Row[]
    try {
      hits = execute(parsed, rows)
    } catch (error) {
      if (error instanceof SqlError)
        return o2Error(400, `Search SQL not supported: ${error.message}`)
      throw error
    }
    const page = size < 0 ? hits.slice(from) : hits.slice(from, from + size)
    return empty(page, hits.length, rows.length)
  }
}

/** A stored row as the admin routes show it: its org and stream beside its columns. */
export const adminRow = (stored: StoredRow): Row => ({
  _org: stored.org,
  _stream: stored.stream,
  ...stored.row,
})

export type { OtelRuntime, OtelRuntimeOptions } from "./runtime.js"
export { createRuntime, OTEL_PRESETS } from "./runtime.js"
