/**
 * A minimal protobuf wire-format decoder for the two OTLP export requests the receiver accepts
 * as `application/x-protobuf` (`ExportTraceServiceRequest`, `ExportLogsServiceRequest`). It
 * decodes only the fields the store keeps and skips the rest, and produces the same shape as
 * OTLP/JSON (lowerCamelCase keys, hex ids, 64-bit integers as decimal strings), so one
 * normaliser handles both encodings. No dependencies.
 *
 * Field numbers follow opentelemetry-proto v1 (`common.proto`, `resource.proto`,
 * `trace.proto`, `logs.proto`).
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(`invalid protobuf: ${message}`)
    this.name = "ProtobufError"
  }
}

type Json = Record<string, unknown>

const utf8 = new TextDecoder("utf-8", { fatal: false })

class Reader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new ProtobufError("truncated varint")
      const byte = this.buf[this.pos++] as number
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
    throw new ProtobufError("varint longer than 10 bytes")
  }

  fixed64(): bigint {
    const bytes = this.take(8)
    let result = 0n
    for (let i = 7; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i] as number)
    return result
  }

  fixed32(): number {
    const bytes = this.take(4)
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  }

  double(): number {
    const bytes = this.take(8)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
  }

  bytes(): Uint8Array {
    return this.take(Number(this.varint()))
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.buf.length) {
      throw new ProtobufError("length-delimited field runs past the end")
    }
    const out = this.buf.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint()
    else if (wireType === 1) this.take(8)
    else if (wireType === 2) this.bytes()
    else if (wireType === 5) this.take(4)
    else throw new ProtobufError(`unsupported wire type ${wireType}`)
  }
}

type FieldHandler = (field: number, wireType: number, reader: Reader) => boolean

/** Walk a message's fields; the handler returns false for fields it does not read. */
const walk = (bytes: Uint8Array, handler: FieldHandler): void => {
  const reader = new Reader(bytes)
  while (!reader.done) {
    const key = Number(reader.varint())
    const field = key >>> 3
    const wireType = key & 7
    if (field === 0) throw new ProtobufError("field number 0")
    if (!handler(field, wireType, reader)) reader.skip(wireType)
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Two's-complement int64 from a varint. */
const int64 = (value: bigint): string => BigInt.asIntN(64, value).toString()

const decodeAnyValue = (bytes: Uint8Array): Json => {
  let out: Json = {}
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) out = { stringValue: utf8.decode(r.bytes()) }
    else if (field === 2 && wire === 0) out = { boolValue: r.varint() !== 0n }
    else if (field === 3 && wire === 0) out = { intValue: int64(r.varint()) }
    else if (field === 4 && wire === 1) out = { doubleValue: r.double() }
    else if (field === 5 && wire === 2) out = { arrayValue: { values: decodeValues(r.bytes()) } }
    else if (field === 6 && wire === 2) {
      out = { kvlistValue: { values: decodeKeyValues(r.bytes()) } }
    } else if (field === 7 && wire === 2) out = { bytesValue: base64(r.bytes()) }
    else return false
    return true
  })
  return out
}

/** `ArrayValue { repeated AnyValue values = 1 }`. */
const decodeValues = (bytes: Uint8Array): Json[] => {
  const values: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    values.push(decodeAnyValue(r.bytes()))
    return true
  })
  return values
}

/** `KeyValueList { repeated KeyValue values = 1 }`. */
const decodeKeyValues = (bytes: Uint8Array): Json[] => {
  const values: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    values.push(decodeKeyValue(r.bytes()))
    return true
  })
  return values
}

const decodeKeyValue = (bytes: Uint8Array): Json => {
  const kv: Json = { key: "" }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) kv.key = utf8.decode(r.bytes())
    else if (field === 2 && wire === 2) kv.value = decodeAnyValue(r.bytes())
    else return false
    return true
  })
  return kv
}

/** `Resource { repeated KeyValue attributes = 1 }`. */
const decodeResource = (bytes: Uint8Array): Json => {
  const attributes: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    attributes.push(decodeKeyValue(r.bytes()))
    return true
  })
  return { attributes }
}

/** `InstrumentationScope { string name = 1; string version = 2 }`. */
const decodeScope = (bytes: Uint8Array): Json => {
  const scope: Json = {}
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) scope.name = utf8.decode(r.bytes())
    else if (field === 2 && wire === 2) scope.version = utf8.decode(r.bytes())
    else return false
    return true
  })
  return scope
}

const decodeEvent = (bytes: Uint8Array): Json => {
  const event: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 1) event.timeUnixNano = r.fixed64().toString()
    else if (field === 2 && wire === 2) event.name = utf8.decode(r.bytes())
    else if (field === 3 && wire === 2) {
      ;(event.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    } else return false
    return true
  })
  return event
}

const decodeStatus = (bytes: Uint8Array): Json => {
  const status: Json = {}
  walk(bytes, (field, wire, r) => {
    if (field === 2 && wire === 2) status.message = utf8.decode(r.bytes())
    else if (field === 3 && wire === 0) status.code = Number(r.varint())
    else return false
    return true
  })
  return status
}

const decodeSpan = (bytes: Uint8Array): Json => {
  const span: Json = { attributes: [], events: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) span.traceId = hex(r.bytes())
    else if (field === 2 && wire === 2) span.spanId = hex(r.bytes())
    else if (field === 3 && wire === 2) span.traceState = utf8.decode(r.bytes())
    else if (field === 4 && wire === 2) span.parentSpanId = hex(r.bytes())
    else if (field === 5 && wire === 2) span.name = utf8.decode(r.bytes())
    else if (field === 6 && wire === 0) span.kind = Number(r.varint())
    else if (field === 7 && wire === 1) span.startTimeUnixNano = r.fixed64().toString()
    else if (field === 8 && wire === 1) span.endTimeUnixNano = r.fixed64().toString()
    else if (field === 9 && wire === 2) {
      ;(span.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    } else if (field === 11 && wire === 2) (span.events as Json[]).push(decodeEvent(r.bytes()))
    else if (field === 15 && wire === 2) span.status = decodeStatus(r.bytes())
    else if (field === 16 && wire === 5) span.flags = r.fixed32()
    else return false
    return true
  })
  return span
}

const decodeLogRecord = (bytes: Uint8Array): Json => {
  const log: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 1) log.timeUnixNano = r.fixed64().toString()
    else if (field === 2 && wire === 0) log.severityNumber = Number(r.varint())
    else if (field === 3 && wire === 2) log.severityText = utf8.decode(r.bytes())
    else if (field === 5 && wire === 2) log.body = decodeAnyValue(r.bytes())
    else if (field === 6 && wire === 2) {
      ;(log.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    } else if (field === 8 && wire === 5) log.flags = r.fixed32()
    else if (field === 9 && wire === 2) log.traceId = hex(r.bytes())
    else if (field === 10 && wire === 2) log.spanId = hex(r.bytes())
    else if (field === 11 && wire === 1) log.observedTimeUnixNano = r.fixed64().toString()
    else if (field === 12 && wire === 2) log.eventName = utf8.decode(r.bytes())
    else return false
    return true
  })
  return log
}

/**
 * `{resource, scope<Kind>s: [{scope, <items>}]}`: the one nesting shape traces and logs share
 * (`ResourceSpans`/`ScopeSpans`, `ResourceLogs`/`ScopeLogs`).
 */
const decodeResourceGroup = (
  bytes: Uint8Array,
  scopeKey: string,
  itemsKey: string,
  decodeItem: (bytes: Uint8Array) => Json,
): Json => {
  const group: Json = { [scopeKey]: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) group.resource = decodeResource(r.bytes())
    else if (field === 2 && wire === 2) {
      const scoped: Json = { [itemsKey]: [] }
      walk(r.bytes(), (f, w, inner) => {
        if (f === 1 && w === 2) scoped.scope = decodeScope(inner.bytes())
        else if (f === 2 && w === 2) (scoped[itemsKey] as Json[]).push(decodeItem(inner.bytes()))
        else return false
        return true
      })
      ;(group[scopeKey] as Json[]).push(scoped)
    } else return false
    return true
  })
  return group
}

/** `ExportTraceServiceRequest` → OTLP/JSON `{resourceSpans: [...]}`. */
export const decodeTraceRequest = (bytes: Uint8Array): { resourceSpans: Json[] } => {
  const resourceSpans: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    resourceSpans.push(decodeResourceGroup(r.bytes(), "scopeSpans", "spans", decodeSpan))
    return true
  })
  return { resourceSpans }
}

/** `ExportLogsServiceRequest` → OTLP/JSON `{resourceLogs: [...]}`. */
export const decodeLogsRequest = (bytes: Uint8Array): { resourceLogs: Json[] } => {
  const resourceLogs: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    resourceLogs.push(decodeResourceGroup(r.bytes(), "scopeLogs", "logRecords", decodeLogRecord))
    return true
  })
  return { resourceLogs }
}

/** Count `ResourceMetrics` entries in an `ExportMetricsServiceRequest` without decoding them. */
export const countMetricsRequest = (bytes: Uint8Array): number => {
  let count = 0
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    r.bytes()
    count++
    return true
  })
  return count
}
