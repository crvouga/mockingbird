/**
 * OTLP export requests (JSON, or protobuf decoded to the same shape) → the flat rows
 * OpenObserve stores. O2 lowercases every field name and flattens it (`http.status_code` →
 * `http_status_code`); resource attributes get a `service_` prefix (`service.version` →
 * `service_service_version`, `deployment.environment.name` →
 * `service_deployment_environment_name`) except `service.name`, which is `service_name`.
 * Null-valued fields are dropped.
 */

export type Scalar = string | number | boolean
export type Row = Record<string, Scalar>

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** OTLP/JSON is lowerCamelCase; accept the proto snake_case spelling too. */
const pick = (object: Json, camel: string): unknown => {
  if (object[camel] !== undefined) return object[camel]
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return object[snake]
}

const list = (object: Json, camel: string): Json[] => {
  const value = pick(object, camel)
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** O2's field-name normalisation: lowercase, every other character becomes `_`. */
export const formatKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9_]/g, "_")

/** Nanoseconds from a decimal string, a number, or protobufjs `{low, high}` long bits. */
const nanos = (value: unknown): bigint => {
  try {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
    if (isRecord(value) && typeof value.low === "number" && typeof value.high === "number") {
      return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0)
    }
  } catch {
    // Fall through: not a timestamp.
  }
  return 0n
}

/** Ids are hex in OTLP/JSON; older encoders sent base64, which is converted. */
const id = (value: unknown, bytes: number): string | undefined => {
  if (typeof value !== "string" || value === "") return undefined
  let hex = value.toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(hex)) {
    try {
      hex = Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    } catch {
      return undefined
    }
  }
  return /^0+$/.test(hex) ? undefined : hex
}

type Value = Scalar | null | { [key: string]: Value }

const anyValue = (value: unknown): Value => {
  if (!isRecord(value)) return null
  const string = pick(value, "stringValue")
  if (typeof string === "string") return string
  const bool = pick(value, "boolValue")
  if (typeof bool === "boolean") return bool
  const int = pick(value, "intValue")
  if (typeof int === "string" || typeof int === "number") return Number(int)
  const double = pick(value, "doubleValue")
  if (typeof double === "number") return double
  const bytes = pick(value, "bytesValue")
  if (typeof bytes === "string") return bytes
  const array = pick(value, "arrayValue")
  if (isRecord(array)) {
    return JSON.stringify(list(array, "values").map((v) => plain(anyValue(v))))
  }
  const kvlist = pick(value, "kvlistValue")
  if (isRecord(kvlist)) {
    const out: { [key: string]: Value } = {}
    for (const kv of list(kvlist, "values")) {
      if (typeof kv.key === "string") out[kv.key] = anyValue(kv.value)
    }
    return out
  }
  return null
}

const plain = (value: Value): unknown =>
  value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
    : value

/** Flatten `KeyValue[]` into `row` under O2's names; nested kvlists join with `_`. */
const flattenInto = (row: Row, attributes: Json[], prefix = ""): void => {
  const put = (key: string, value: Value) => {
    if (value === null) return
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) put(`${key}_${formatKey(k)}`, v)
      return
    }
    row[key] = value
  }
  for (const kv of attributes) {
    if (typeof kv.key !== "string" || kv.key === "") continue
    put(`${prefix}${formatKey(kv.key)}`, anyValue(kv.value))
  }
}

/** The raw resource attributes (for routing) and their O2 columns. */
const resourceColumns = (group: Json): { attributes: Record<string, Scalar>; columns: Row } => {
  const resource = pick(group, "resource")
  const kvs = isRecord(resource) ? list(resource, "attributes") : []
  const attributes: Record<string, Scalar> = {}
  const columns: Row = {}
  for (const kv of kvs) {
    if (typeof kv.key !== "string") continue
    const value = anyValue(kv.value)
    if (value !== null && typeof value !== "object") attributes[kv.key] = value
    if (kv.key === "service.name") {
      if (value !== null && typeof value !== "object") columns.service_name = value
    } else flattenInto(columns, [kv], "service_")
  }
  return { attributes, columns }
}

export type IngestedRow = {
  /** Raw resource attributes, used to route the row to an org. */
  resource: Record<string, Scalar>
  row: Row
  /** The log had a non-empty body (stored only with `keepBodies`). */
  hadBody: boolean
}

const bodyText = (value: Value): string | null => {
  if (value === null) return null
  if (typeof value === "string") return value
  if (typeof value === "object") return JSON.stringify(plain(value))
  return String(value)
}

/**
 * `ExportLogsServiceRequest` → one row per log record. The body is dropped unless
 * `keepBodies` (our logging policy: a body can hold a prompt or PHI; attributes and `event`
 * are what tests assert on).
 */
export const logRows = (
  request: Json,
  options: { keepBodies: boolean; nowMs: number },
): IngestedRow[] => {
  const out: IngestedRow[] = []
  for (const group of list(request, "resourceLogs")) {
    const { attributes, columns } = resourceColumns(group)
    for (const scoped of list(group, "scopeLogs")) {
      for (const record of list(scoped, "logRecords")) {
        const row: Row = { ...columns }
        flattenInto(row, list(record, "attributes"))
        const time =
          nanos(pick(record, "timeUnixNano")) || nanos(pick(record, "observedTimeUnixNano"))
        row._timestamp = time > 0n ? Number(time / 1000n) : options.nowMs * 1000
        const severityText = pick(record, "severityText")
        if (typeof severityText === "string" && severityText !== "") {
          row.severity_text = severityText
        }
        const severityNumber = Number(pick(record, "severityNumber") ?? 0)
        if (Number.isFinite(severityNumber) && severityNumber > 0) {
          row.severity_number = severityNumber
        }
        const traceId = id(pick(record, "traceId"), 16)
        if (traceId) row.trace_id = traceId
        const spanId = id(pick(record, "spanId"), 8)
        if (spanId) row.span_id = spanId
        const eventName = pick(record, "eventName")
        if (typeof eventName === "string" && eventName !== "") row.event_name = eventName
        const body = bodyText(anyValue(pick(record, "body")))
        const hadBody = body !== null && body !== ""
        if (hadBody && options.keepBodies) row.body = body as string
        out.push({ resource: attributes, row, hadBody })
      }
    }
  }
  return out
}

const STATUS = ["UNSET", "OK", "ERROR"] as const

/** `ExportTraceServiceRequest` → one row per span, in O2's traces-stream columns. */
export const spanRows = (request: Json, options: { nowMs: number }): IngestedRow[] => {
  const out: IngestedRow[] = []
  for (const group of list(request, "resourceSpans")) {
    const { attributes, columns } = resourceColumns(group)
    for (const scoped of list(group, "scopeSpans")) {
      for (const span of list(scoped, "spans")) {
        const row: Row = { ...columns }
        flattenInto(row, list(span, "attributes"))
        const start = nanos(pick(span, "startTimeUnixNano"))
        const end = nanos(pick(span, "endTimeUnixNano"))
        const startNs = start > 0n ? start : BigInt(options.nowMs) * 1_000_000n
        const endNs = end > 0n ? end : startNs
        row.start_time = Number(startNs)
        row.end_time = Number(endNs)
        row.duration = Number((endNs - startNs) / 1000n)
        row._timestamp = Number(startNs / 1000n)
        const traceId = id(pick(span, "traceId"), 16)
        if (traceId) row.trace_id = traceId
        const spanId = id(pick(span, "spanId"), 8)
        if (spanId) row.span_id = spanId
        const parent = id(pick(span, "parentSpanId"), 8)
        if (parent) {
          row.reference_parent_span_id = parent
          row.reference_ref_type = "ChildOf"
        }
        const name = pick(span, "name")
        if (typeof name === "string") row.operation_name = name
        row.span_kind = String(Number(pick(span, "kind") ?? 0))
        const status = pick(span, "status")
        const code = isRecord(status) ? Number(pick(status, "code") ?? 0) : 0
        row.span_status = STATUS[code] ?? "UNSET"
        const events = list(span, "events").map((event) => {
          const flat: Row = {}
          flattenInto(flat, list(event, "attributes"))
          return {
            name: typeof event.name === "string" ? event.name : "",
            _timestamp: Number(nanos(pick(event, "timeUnixNano")) / 1000n),
            ...flat,
          }
        })
        row.events = JSON.stringify(events)
        const scope = pick(scoped, "scope")
        if (isRecord(scope) && typeof scope.name === "string" && scope.name !== "") {
          row.instrumentation_library_name = scope.name
        }
        out.push({ resource: attributes, row, hadBody: false })
      }
    }
  }
  return out
}

/** How many metric streams an OTLP/JSON metrics export carries (counted, never stored). */
export const metricCount = (request: Json): number =>
  list(request, "resourceMetrics").reduce(
    (total, group) =>
      total +
      list(group, "scopeMetrics").reduce((sum, scoped) => sum + list(scoped, "metrics").length, 0),
    0,
  )
