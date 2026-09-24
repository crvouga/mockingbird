import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ROOT_CONTEXT, type Span, trace } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { DEFAULT_ORGANIZATIONS } from "./src/index.js"
import { createServer, type OtelServer } from "./src/server.js"
import { createO2Client, O2_RECIPES, OpenObserveBloodworkClient } from "./test/consumer.js"

/**
 * The OpenTelemetry JS SDK at our pins (`@opentelemetry/exporter-*-otlp-http@0.201.1`,
 * `sdk-trace-base@2.0.1`, `sdk-logs@0.201.1`), plus the protobuf exporters the Python services'
 * wire format matches, exporting to the served mock the way the consumer app's `@acme/telemetry`
 * package does (`Authorization: Bearer <OTEL_AUTH_TOKEN>`), then read back through our O2 clients.
 */
const TOKEN = "otel-sdk-token"
const O2_AUTH = btoa("agent@acme.example:pw")
const DEV_ORG = DEFAULT_ORGANIZATIONS.find((o) => o.name === "development")?.identifier as string

let server: OtelServer

beforeAll(async () => {
  server = await createServer({ settings: { ingestTokens: [TOKEN] } })
})

afterAll(async () => {
  await server.close()
})

const resource = (serviceName: string) =>
  resourceFromAttributes({
    "service.name": serviceName,
    "service.version": "3f2c9ab",
    "deployment.environment.name": "local",
  })

type Encoding = "json" | "protobuf"

const pipeline = (
  serviceName: string,
  encoding: Encoding,
  headers = { Authorization: `Bearer ${TOKEN}` },
) => {
  const traceExporter =
    encoding === "json"
      ? new OTLPTraceExporter({ url: `${server.url}/v1/traces`, headers })
      : new OTLPProtoTraceExporter({ url: `${server.url}/v1/traces`, headers })
  const logExporter =
    encoding === "json"
      ? new OTLPLogExporter({ url: `${server.url}/v1/logs`, headers })
      : new OTLPProtoLogExporter({ url: `${server.url}/v1/logs`, headers })
  const tracerProvider = new BasicTracerProvider({
    resource: resource(serviceName),
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  })
  const loggerProvider = new LoggerProvider({
    resource: resource(serviceName),
    processors: [new SimpleLogRecordProcessor(logExporter)],
  })
  const tracer = tracerProvider.getTracer("@acme/telemetry")
  const logger = loggerProvider.getLogger("@acme/telemetry/pino")
  const emit = (span: Span, event: string, attributes: Record<string, string | number>) =>
    logger.emit({
      context: trace.setSpan(ROOT_CONTEXT, span),
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: `prompt text that must not be stored (${event})`,
      attributes: { event, ...attributes },
    })
  const flush = async () => {
    await tracerProvider.forceFlush()
    await loggerProvider.forceFlush()
  }
  const shutdown = async () => {
    await tracerProvider.shutdown()
    await loggerProvider.shutdown()
  }
  return { tracer, emit, flush, shutdown }
}

const wait = async (where: Record<string, unknown>, kind: "log" | "span" = "log") => {
  const response = await fetch(`${server.url}/__admin/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, where, count: 1, timeoutMs: 10_000 }),
  })
  return (await response.json()) as { matched: Record<string, unknown>[] }
}

describe.each(["json", "protobuf"] as const)("OpenTelemetry SDK over OTLP/HTTP %s", (encoding) => {
  test(
    "a span and an event log export, then come back through the O2 search clients",
    async () => {
      const service = `backend-${encoding}`
      const otel = pipeline(service, encoding)
      const root = otel.tracer.startSpan("reconcile.run", {
        attributes: { "acme.reconcile_run_id": `run-${encoding}` },
      })
      const traceId = root.spanContext().traceId
      otel.emit(root, "junction_order_failed", {
        clientUserId: 9,
        vitalOrderId: `ord-${encoding}`,
        code: "vendor_rejected",
      })
      root.end()
      await otel.flush()
      await otel.shutdown()

      const [span] = (await wait({ trace_id: traceId }, "span")).matched
      expect(span).toMatchObject({
        _org: DEV_ORG,
        service_name: service,
        service_service_version: "3f2c9ab",
        service_deployment_environment_name: "local",
        operation_name: "reconcile.run",
        acme_reconcile_run_id: `run-${encoding}`,
        span_status: "UNSET",
      })
      const [log] = (await wait({ trace_id: traceId })).matched
      expect(log).toMatchObject({
        service_name: service,
        event: "junction_order_failed",
        clientuserid: 9,
        vitalorderid: `ord-${encoding}`,
        severity_text: "ERROR",
        severity_number: 17,
        span_id: root.spanContext().spanId,
      })
      // The body is a prompt: never stored.
      expect(JSON.stringify(log)).not.toContain("prompt text")

      const bloodwork = new OpenObserveBloodworkClient({
        baseUrl: server.url,
        auth: O2_AUTH,
        fetchImpl: (input, init) => fetch(input, init),
      })
      const hits = await bloodwork.searchSql({
        org: "development",
        sql: `SELECT * FROM "default" WHERE event IS NOT NULL AND (vitalorderid IN ('ord-${encoding}')) ORDER BY _timestamp DESC`,
        startMs: Date.now() - 3_600_000,
        endMs: Date.now() + 60_000,
      })
      expect(hits.map((hit) => [hit.event, hit.trace_id])).toEqual([
        ["junction_order_failed", traceId],
      ])

      const agent = createO2Client({
        basicAuth: O2_AUTH,
        baseUrl: server.url,
        fetchImpl: (input, init) => fetch(input, init),
      })
      const byTrace = await agent.search({
        org: "development",
        sql: O2_RECIPES["logs-for-trace"]({ traceId }),
        sinceMs: 3_600_000,
      })
      expect(byTrace.ok && byTrace.rows.map((row) => row.span_id)).toEqual([
        root.spanContext().spanId,
      ])
    },
    { timeout: 30_000 },
  )
})

describe("the exporter's retry and drop paths", () => {
  const journal = async (operationId: string) =>
    (
      (await (await fetch(`${server.url}/__admin/requests?operationId=${operationId}`)).json()) as {
        requests: { status: number }[]
      }
    ).requests.map((r) => r.status)

  test(
    "429 with retry-after is retried until the export lands",
    async () => {
      await fetch(`${server.url}/__admin/reset`, { method: "POST" })
      // The journal outlives resets: compare only what this test adds.
      const before = {
        traces: (await journal("ExportTraces")).length,
        logs: (await journal("ExportLogs")).length,
      }
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: "rate_limited", count: 1 }),
      })
      const otel = pipeline("backend-retry", "json")
      const span = otel.tracer.startSpan("retry.me")
      otel.emit(span, "retried_event", {})
      span.end()
      await otel.flush()
      await otel.shutdown()
      expect((await wait({ event: "retried_event" })).matched).toHaveLength(1)
      const statuses = [
        ...(await journal("ExportTraces")).slice(before.traces),
        ...(await journal("ExportLogs")).slice(before.logs),
      ]
      expect(statuses.filter((s) => s === 429)).toHaveLength(1)
      expect(statuses.filter((s) => s === 200)).toHaveLength(2)
    },
    { timeout: 30_000 },
  )

  test(
    "500 is dropped without a retry; a missing token is a 401 the SDK drops",
    async () => {
      await fetch(`${server.url}/__admin/reset`, { method: "POST" })
      const before = (await journal("ExportLogs")).length
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: "server_error", count: 1 }),
      })
      const broken = pipeline("backend-500", "json")
      broken.emit(broken.tracer.startSpan("x"), "dropped_event", {})
      await broken.flush()
      await broken.shutdown()
      expect((await journal("ExportLogs")).slice(before)).toEqual([500])

      const anonymous = pipeline("backend-401", "json", { Authorization: "Bearer wrong-token" })
      anonymous.emit(anonymous.tracer.startSpan("x"), "unauthenticated_event", {})
      await anonymous.flush()
      await anonymous.shutdown()
      expect((await journal("ExportLogs")).slice(before)).toEqual([500, 401])
      const logs = (await (await fetch(`${server.url}/__admin/logs`)).json()) as { logs: unknown[] }
      expect(logs.logs).toEqual([])
    },
    { timeout: 30_000 },
  )
})
