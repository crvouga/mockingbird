// Copied verbatim from @crvouga/mockingbird-service-bedrock/src/eventstream.ts (published services cannot share
// source without a runtime dependency on each other). Keep the two copies identical.
/**
 * AWS event-stream framing (`application/vnd.amazon.eventstream`), both directions.
 *
 * Every frame is: a 12-byte prelude (total length, headers length, CRC32 of those 8 bytes),
 * the headers, the payload, and a CRC32 of everything before it. `@smithy/eventstream-codec`
 * (the AWS SDKs and the AI SDK) rejects a frame whose lengths or checksums are off by one
 * byte, so this module is exact: it is the only place a frame is built or parsed.
 *
 * The same codec reads what an SDK sends on a bidirectional stream. Those frames arrive
 * wrapped in a SigV4 envelope (`:date` + `:chunk-signature` headers around the encoded
 * inner frame); {@link unwrapSigned} opens it. The signature itself is never verified.
 */

/** A typed header value; plain strings encode as type 7 (string). */
export type HeaderValue =
  | { type: "boolean"; value: boolean }
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "integer"; value: number }
  | { type: "long"; value: bigint }
  | { type: "binary"; value: Uint8Array }
  | { type: "string"; value: string }
  | { type: "timestamp"; value: Date }
  | { type: "uuid"; value: string }

export type EventStreamMessage = {
  headers: Record<string, HeaderValue>
  body: Uint8Array
}

/** What {@link encodeMessage} accepts: header values may be bare strings. */
export type MessageInput = {
  headers: Record<string, HeaderValue | string>
  body?: Uint8Array | string
}

export class EventStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EventStreamError"
  }
}

const PRELUDE = 12
const TRAILER = 4
const utf8 = new TextEncoder()
const text = new TextDecoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3, the one event-stream uses) of `bytes`. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const toBytes = (body: Uint8Array | string | undefined): Uint8Array =>
  body === undefined ? new Uint8Array(0) : typeof body === "string" ? utf8.encode(body) : body

const encodeHeaders = (headers: Record<string, HeaderValue | string>): Uint8Array => {
  const parts: Uint8Array[] = []
  for (const [name, raw] of Object.entries(headers)) {
    const header: HeaderValue = typeof raw === "string" ? { type: "string", value: raw } : raw
    const nameBytes = utf8.encode(name)
    if (nameBytes.length > 255) throw new EventStreamError(`header name too long: ${name}`)
    let value: Uint8Array
    switch (header.type) {
      case "boolean":
        value = Uint8Array.of(header.value ? 0 : 1)
        break
      case "byte":
        value = Uint8Array.of(2, header.value & 0xff)
        break
      case "short": {
        value = new Uint8Array(3)
        value[0] = 3
        new DataView(value.buffer).setInt16(1, header.value, false)
        break
      }
      case "integer": {
        value = new Uint8Array(5)
        value[0] = 4
        new DataView(value.buffer).setInt32(1, header.value, false)
        break
      }
      case "long": {
        value = new Uint8Array(9)
        value[0] = 5
        new DataView(value.buffer).setBigInt64(1, header.value, false)
        break
      }
      case "binary":
      case "string": {
        const bytes = header.type === "binary" ? header.value : utf8.encode(header.value)
        if (bytes.length > 0xffff) throw new EventStreamError(`header ${name} value too long`)
        value = new Uint8Array(3 + bytes.length)
        value[0] = header.type === "binary" ? 6 : 7
        new DataView(value.buffer).setUint16(1, bytes.length, false)
        value.set(bytes, 3)
        break
      }
      case "timestamp": {
        value = new Uint8Array(9)
        value[0] = 8
        new DataView(value.buffer).setBigInt64(1, BigInt(header.value.getTime()), false)
        break
      }
      case "uuid": {
        const hex = header.value.replace(/-/g, "")
        if (!/^[0-9a-f]{32}$/i.test(hex)) throw new EventStreamError(`bad uuid header ${name}`)
        value = new Uint8Array(17)
        value[0] = 9
        for (let i = 0; i < 16; i++) value[i + 1] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        break
      }
    }
    const entry = new Uint8Array(1 + nameBytes.length + value.length)
    entry[0] = nameBytes.length
    entry.set(nameBytes, 1)
    entry.set(value, 1 + nameBytes.length)
    parts.push(entry)
  }
  return concat(parts)
}

/** Concatenate byte arrays. */
export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** One complete frame: prelude, prelude CRC, headers, payload, message CRC. */
export const encodeMessage = (message: MessageInput): Uint8Array => {
  const headers = encodeHeaders(message.headers)
  const body = toBytes(message.body)
  const total = PRELUDE + headers.length + body.length + TRAILER
  const frame = new Uint8Array(total)
  const view = new DataView(frame.buffer)
  view.setUint32(0, total, false)
  view.setUint32(4, headers.length, false)
  view.setUint32(8, crc32(frame.subarray(0, 8)), false)
  frame.set(headers, PRELUDE)
  frame.set(body, PRELUDE + headers.length)
  view.setUint32(total - TRAILER, crc32(frame.subarray(0, total - TRAILER)), false)
  return frame
}

const decodeHeaders = (bytes: Uint8Array): Record<string, HeaderValue> => {
  const headers: Record<string, HeaderValue> = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at < bytes.length) {
    const nameLength = bytes[at] as number
    const name = text.decode(bytes.subarray(at + 1, at + 1 + nameLength))
    at += 1 + nameLength
    const type = bytes[at] as number
    at += 1
    switch (type) {
      case 0:
      case 1:
        headers[name] = { type: "boolean", value: type === 0 }
        break
      case 2:
        headers[name] = { type: "byte", value: view.getInt8(at) }
        at += 1
        break
      case 3:
        headers[name] = { type: "short", value: view.getInt16(at, false) }
        at += 2
        break
      case 4:
        headers[name] = { type: "integer", value: view.getInt32(at, false) }
        at += 4
        break
      case 5:
        headers[name] = { type: "long", value: view.getBigInt64(at, false) }
        at += 8
        break
      case 6:
      case 7: {
        const length = view.getUint16(at, false)
        const value = bytes.slice(at + 2, at + 2 + length)
        headers[name] =
          type === 6 ? { type: "binary", value } : { type: "string", value: text.decode(value) }
        at += 2 + length
        break
      }
      case 8:
        headers[name] = { type: "timestamp", value: new Date(Number(view.getBigInt64(at, false))) }
        at += 8
        break
      case 9: {
        const hex = [...bytes.subarray(at, at + 16)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
        headers[name] = {
          type: "uuid",
          value: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        }
        at += 16
        break
      }
      default:
        throw new EventStreamError(`unknown header type ${type} for ${name}`)
    }
  }
  return headers
}

/** Parse exactly one frame, checking both lengths and both checksums. */
export const decodeMessage = (frame: Uint8Array): EventStreamMessage => {
  if (frame.length < PRELUDE + TRAILER) throw new EventStreamError("frame shorter than a prelude")
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const total = view.getUint32(0, false)
  const headersLength = view.getUint32(4, false)
  if (total !== frame.length) throw new EventStreamError(`frame length ${frame.length} ≠ ${total}`)
  if (view.getUint32(8, false) !== crc32(frame.subarray(0, 8))) {
    throw new EventStreamError("prelude checksum mismatch")
  }
  if (view.getUint32(total - TRAILER, false) !== crc32(frame.subarray(0, total - TRAILER))) {
    throw new EventStreamError("message checksum mismatch")
  }
  return {
    headers: decodeHeaders(frame.subarray(PRELUDE, PRELUDE + headersLength)),
    body: frame.slice(PRELUDE + headersLength, total - TRAILER),
  }
}

/** Splits a byte stream into frames as they complete. */
export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0)

  /** Add bytes; returns every frame they complete. */
  push(chunk: Uint8Array): EventStreamMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk.slice() : concat([this.buffer, chunk])
    const out: EventStreamMessage[] = []
    while (this.buffer.length >= 4) {
      const total = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      ).getUint32(0, false)
      if (total < PRELUDE + TRAILER) throw new EventStreamError(`impossible frame length ${total}`)
      if (this.buffer.length < total) break
      out.push(decodeMessage(this.buffer.subarray(0, total)))
      this.buffer = this.buffer.slice(total)
    }
    return out
  }

  /** Bytes of an incomplete frame still waiting for the rest. */
  get pending(): number {
    return this.buffer.length
  }
}

/** A header's value as a string, when it is one. */
export const headerString = (message: EventStreamMessage, name: string): string | undefined => {
  const header = message.headers[name]
  return header?.type === "string" ? header.value : undefined
}

/**
 * The frame inside a SigV4 event envelope (`:chunk-signature`), `null` for the empty
 * end-of-stream envelope, or the frame itself when it is not signed.
 */
export const unwrapSigned = (message: EventStreamMessage): EventStreamMessage | null => {
  if (message.headers[":chunk-signature"] === undefined) return message
  if (message.body.length === 0) return null
  return decodeMessage(message.body)
}

/** An `event` frame whose payload is JSON (or raw bytes, for blob event payloads). */
export const eventFrame = (
  eventType: string,
  payload: unknown,
  contentType: string = payload instanceof Uint8Array
    ? "application/octet-stream"
    : "application/json",
): Uint8Array =>
  encodeMessage({
    headers: {
      ":event-type": eventType,
      ":content-type": contentType,
      ":message-type": "event",
    },
    body: payload instanceof Uint8Array ? payload : JSON.stringify(payload),
  })

/** An `exception` frame, as a service raises one mid-stream. */
export const exceptionFrame = (exceptionType: string, body: Record<string, unknown>): Uint8Array =>
  encodeMessage({
    headers: {
      ":exception-type": exceptionType,
      ":content-type": "application/json",
      ":message-type": "exception",
    },
    body: JSON.stringify(body),
  })

/** Decode a frame's payload as JSON (or `undefined` when it is not JSON). */
export const payloadJson = (message: EventStreamMessage): unknown => {
  try {
    return JSON.parse(text.decode(message.body)) as unknown
  } catch {
    return undefined
  }
}

/** An async iterator over the frames of a byte stream (a request or response body). */
export async function* readFrames(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<EventStreamMessage> {
  if (!body) return
  const reader = new FrameReader()
  const stream = body.getReader()
  try {
    for (;;) {
      const { done, value } = await stream.read()
      if (done) break
      for (const frame of reader.push(value)) yield frame
    }
  } finally {
    stream.releaseLock()
  }
  if (reader.pending > 0) throw new EventStreamError("stream ended inside a frame")
}
