import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"

export type Attributes = Record<string, string | number | boolean | undefined>

export type Telemetry = {
  /** Run `work` inside a span that is a child of the current one. Thrown errors mark it failed. */
  span<T>(
    name: string,
    attributes: Attributes,
    work: (span: { set(attributes: Attributes): void }) => Promise<T>,
    options?: { kind?: "server" | "client" | "internal"; traceparent?: string | null },
  ): Promise<T>
  /** Add to a monotonic counter. */
  count(name: string, attributes?: Attributes, by?: number): void
  /** Record one observation of a millisecond histogram. */
  record(name: string, value: number, attributes?: Attributes): void
  log(level: "info" | "warn" | "error", message: string, attributes?: Attributes): void
  /** Send everything buffered. Called on an interval and before shutdown. */
  flush(): Promise<void>
  close(): Promise<void>
}

export type TelemetryOptions = {
  /** OTLP/HTTP base, e.g. `https://collector.example/otlp`. Omit to keep telemetry in-process. */
  endpoint?: string | undefined
  headers?: Record<string, string>
  serviceName: string
  serviceVersion?: string
  fetch?: typeof fetch
  /** Structured log sink. Default: one JSON object per line on stdout/stderr. */
  write?: (line: string, level: string) => void
  intervalMs?: number
}

type Span = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  start: bigint
  end: bigint
  attributes: Attributes
  error?: string
}

const KIND = { internal: 1, server: 2, client: 3 }
const BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000]
const SEVERITY = { info: 9, warn: 13, error: 17 }
const MAX_BUFFER = 2048

const now = () => BigInt(Date.now()) * 1_000_000n

const encode = (attributes: Attributes) =>
  Object.entries(attributes)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "boolean"
            ? { boolValue: value }
            : Number.isInteger(value)
              ? { intValue: String(value) }
              : { doubleValue: value },
    }))

const seriesKey = (name: string, attributes: Attributes) =>
  `${name}\u0000${JSON.stringify(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)))}`

/**
 * Traces, metrics and logs over OTLP/HTTP JSON, with no SDK dependency. With no endpoint it still
 * tracks trace context and writes structured logs, so local runs and tests behave the same.
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const send = options.fetch ?? fetch
  const context = new AsyncLocalStorage<{ traceId: string; spanId: string }>()
  const write =
    options.write ??
    ((line: string, level: string) => (level === "error" ? console.error(line) : console.log(line)))
  const resource = {
    attributes: encode({
      "service.name": options.serviceName,
      "service.version": options.serviceVersion,
    }),
  }
  const scope = { name: "mockingbird-fleet" }
  const started = now()

  let spans: Span[] = []
  let logs: object[] = []
  const counters = new Map<string, { name: string; attributes: Attributes; value: number }>()
  const histograms = new Map<
    string,
    { name: string; attributes: Attributes; count: number; sum: number; buckets: number[] }
  >()

  const post = async (path: string, body: unknown) => {
    if (!options.endpoint) return
    try {
      const response = await send(`${options.endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      await response.body?.cancel()
    } catch {
      // Telemetry never fails a request. A collector outage drops that batch.
    }
  }

  const flush = async () => {
    const batch = spans
    const records = logs
    spans = []
    logs = []
    const time = String(now())
    const work: Promise<void>[] = []
    if (batch.length > 0)
      work.push(
        post("/v1/traces", {
          resourceSpans: [
            {
              resource,
              scopeSpans: [
                {
                  scope,
                  spans: batch.map((span) => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                    name: span.name,
                    kind: span.kind,
                    startTimeUnixNano: String(span.start),
                    endTimeUnixNano: String(span.end),
                    attributes: encode(span.attributes),
                    status: span.error ? { code: 2, message: span.error } : { code: 1 },
                  })),
                },
              ],
            },
          ],
        }),
      )
    if (records.length > 0)
      work.push(
        post("/v1/logs", {
          resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: records }] }],
        }),
      )
    if (counters.size + histograms.size > 0)
      work.push(
        post("/v1/metrics", {
          resourceMetrics: [
            {
              resource,
              scopeMetrics: [
                {
                  scope,
                  metrics: [
                    ...[...counters.values()].map((counter) => ({
                      name: counter.name,
                      sum: {
                        aggregationTemporality: 2,
                        isMonotonic: true,
                        dataPoints: [
                          {
                            attributes: encode(counter.attributes),
                            startTimeUnixNano: String(started),
                            timeUnixNano: time,
                            asInt: String(counter.value),
                          },
                        ],
                      },
                    })),
                    ...[...histograms.values()].map((histogram) => ({
                      name: histogram.name,
                      unit: "ms",
                      histogram: {
                        aggregationTemporality: 2,
                        dataPoints: [
                          {
                            attributes: encode(histogram.attributes),
                            startTimeUnixNano: String(started),
                            timeUnixNano: time,
                            count: String(histogram.count),
                            sum: histogram.sum,
                            bucketCounts: histogram.buckets.map(String),
                            explicitBounds: BOUNDS,
                          },
                        ],
                      },
                    })),
                  ],
                },
              ],
            },
          ],
        }),
      )
    await Promise.all(work)
  }

  const timer = options.endpoint
    ? setInterval(() => void flush(), options.intervalMs ?? 5000)
    : undefined
  timer?.unref?.()

  return {
    async span(name, attributes, work, spanOptions = {}) {
      const parent = context.getStore()
      // W3C trace context: 00-<32 hex trace id>-<16 hex parent id>-<flags>
      const incoming = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(
        spanOptions.traceparent ?? "",
      )
      const span: Span = {
        traceId: parent?.traceId ?? incoming?.[1] ?? randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name,
        kind: KIND[spanOptions.kind ?? "internal"],
        start: now(),
        end: 0n,
        attributes: { ...attributes },
      }
      const parentSpanId = parent?.spanId ?? incoming?.[2]
      if (parentSpanId) span.parentSpanId = parentSpanId
      try {
        return await context.run({ traceId: span.traceId, spanId: span.spanId }, () =>
          work({ set: (more) => Object.assign(span.attributes, more) }),
        )
      } catch (error) {
        span.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        span.end = now()
        if (options.endpoint && spans.length < MAX_BUFFER) spans.push(span)
      }
    },
    count(name, attributes = {}, by = 1) {
      const key = seriesKey(name, attributes)
      const counter = counters.get(key)
      if (counter) counter.value += by
      else counters.set(key, { name, attributes, value: by })
    },
    record(name, value, attributes = {}) {
      const key = seriesKey(name, attributes)
      let histogram = histograms.get(key)
      if (!histogram) {
        histogram = {
          name,
          attributes,
          count: 0,
          sum: 0,
          buckets: new Array(BOUNDS.length + 1).fill(0),
        }
        histograms.set(key, histogram)
      }
      histogram.count++
      histogram.sum += value
      const bucket = BOUNDS.findIndex((bound) => value <= bound)
      const index = bucket === -1 ? BOUNDS.length : bucket
      histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1
    },
    log(level, message, attributes = {}) {
      const current = context.getStore()
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          message,
          ...attributes,
          ...(current ? { trace_id: current.traceId, span_id: current.spanId } : {}),
        }),
        level,
      )
      if (options.endpoint && logs.length < MAX_BUFFER)
        logs.push({
          timeUnixNano: String(now()),
          severityNumber: SEVERITY[level],
          severityText: level.toUpperCase(),
          body: { stringValue: message },
          attributes: encode(attributes),
          ...(current ? { traceId: current.traceId, spanId: current.spanId } : {}),
        })
    },
    flush,
    async close() {
      if (timer) clearInterval(timer)
      await flush()
    },
  }
}
