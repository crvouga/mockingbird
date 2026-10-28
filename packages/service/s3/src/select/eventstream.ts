/**
 * The AWS event-stream framing S3 Select answers with, byte for byte as MinIO's
 * `internal/s3select/message.go` writes it: `Records` messages of at most 128 KiB, then `Stats`
 * and `End` (or a single `error` message).
 */
const encoder = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE). */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const header = (name: string, value: string) => {
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  const out = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length)
  out[0] = nameBytes.length
  out.set(nameBytes, 1)
  let offset = 1 + nameBytes.length
  out[offset] = 7
  out[offset + 1] = (valueBytes.length >> 8) & 0xff
  out[offset + 2] = valueBytes.length & 0xff
  offset += 3
  out.set(valueBytes, offset)
  return out
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const message = (headers: [string, string][], payload: Uint8Array = new Uint8Array()) => {
  const head = concat(headers.map(([name, value]) => header(name, value)))
  const total = 12 + head.length + payload.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, head.length)
  view.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(head, 12)
  out.set(payload, 12 + head.length)
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}

const RECORDS_HEADERS: [string, string][] = [
  [":message-type", "event"],
  [":content-type", "application/octet-stream"],
  [":event-type", "Records"],
]
const RECORDS_HEADER_LENGTH = 85
/** The largest `Records` payload MinIO puts in one message. */
export const MAX_RECORDS_PAYLOAD = (128 << 10) - 256 - 12 - RECORDS_HEADER_LENGTH - 4

export const recordsMessage = (payload: Uint8Array) => message(RECORDS_HEADERS, payload)

export const statsMessage = (scanned: number, processed: number, returned: number) =>
  message(
    [
      [":message-type", "event"],
      [":content-type", "text/xml"],
      [":event-type", "Stats"],
    ],
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Stats><BytesScanned>${scanned}</BytesScanned><BytesProcessed>${processed}</BytesProcessed><BytesReturned>${returned}</BytesReturned></Stats>`,
    ),
  )

export const endMessage = () =>
  message([
    [":message-type", "event"],
    [":event-type", "End"],
  ])

export const errorMessage = (code: string, text: string) =>
  message([
    [":message-type", "error"],
    [":error-message", text],
    [":error-code", code],
  ])

/** Accumulates record payloads and cuts them into `Records` messages like MinIO's writer. */
export class EventStream {
  private readonly parts: Uint8Array[] = []
  private pending: Uint8Array[] = []
  private pendingLength = 0
  returned = 0
  /** Queue serialized records (one `SendRecord` batch). */
  send(bytes: Uint8Array) {
    let rest = bytes
    while (rest.length) {
      const room = MAX_RECORDS_PAYLOAD - this.pendingLength
      const piece = rest.subarray(0, room)
      this.pending.push(piece)
      this.pendingLength += piece.length
      rest = rest.subarray(piece.length)
      if (this.pendingLength === MAX_RECORDS_PAYLOAD) this.flush()
    }
  }
  flush() {
    if (!this.pendingLength) return
    this.parts.push(recordsMessage(concat(this.pending)))
    this.returned += this.pendingLength
    this.pending = []
    this.pendingLength = 0
  }
  finish(scanned: number, processed: number) {
    this.flush()
    this.parts.push(statsMessage(scanned, processed, this.returned), endMessage())
    return concat(this.parts)
  }
  fail(code: string, text: string) {
    this.flush()
    this.parts.push(errorMessage(code, text))
    return concat(this.parts)
  }
}
