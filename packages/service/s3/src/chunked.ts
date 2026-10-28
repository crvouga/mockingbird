/**
 * `aws-chunked` bodies (https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html and
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming-trailers.html):
 * `<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n` repeated, a zero-size chunk, then optional
 * trailers. `readChunks` is a byte-for-byte port of MinIO's `s3ChunkedReader`
 * (`streaming-signature-v4.go`) and `s3UnsignedChunkedReader` (`streaming-v4-unsigned.go`), chunk
 * signatures included; `decodeAwsChunked` is the forgiving decoder lenient mode uses.
 */
import { EMPTY_SHA256, hex, hmac256, sha256Hex } from "./auth.js"
import { S3Error } from "./errors.js"

export type ChunkedBody = { payload: Uint8Array; trailers: Record<string, string> }

export const isAwsChunked = (headers: Headers) =>
  (headers.get("x-amz-content-sha256") ?? "").startsWith("STREAMING-") ||
  (headers.get("content-encoding") ?? "")
    .split(",")
    .some((coding) => coding.trim().toLowerCase() === "aws-chunked")

const CR = 13
const LF = 10
const HEX_SIZE = /^[0-9a-fA-F]{1,15}$/

/** `undefined` when the framing is malformed or the body ends before the zero-size chunk. */
export const decodeAwsChunked = (input: Uint8Array): ChunkedBody | undefined => {
  const line = (from: number) => {
    for (let index = from; index + 1 < input.length; index++)
      if (input[index] === CR && input[index + 1] === LF)
        return {
          text: new TextDecoder("latin1").decode(input.subarray(from, index)),
          next: index + 2,
        }
    return undefined
  }
  const chunks: Uint8Array[] = []
  let position = 0
  for (;;) {
    const header = line(position)
    if (!header) return undefined
    const size = header.text.split(";")[0] as string
    if (!HEX_SIZE.test(size)) return undefined
    position = header.next
    const length = Number.parseInt(size, 16)
    if (length === 0) break
    if (position + length + 2 > input.length) return undefined
    if (input[position + length] !== CR || input[position + length + 1] !== LF) return undefined
    chunks.push(input.subarray(position, position + length))
    position += length + 2
  }
  const trailers: Record<string, string> = {}
  for (;;) {
    const trailer = line(position)
    if (!trailer) return undefined
    position = trailer.next
    if (trailer.text === "") break
    const colon = trailer.text.indexOf(":")
    if (colon < 1) return undefined
    trailers[trailer.text.slice(0, colon).trim().toLowerCase()] = trailer.text
      .slice(colon + 1)
      .trim()
  }
  const payload = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.length
  }
  return { payload, trailers }
}

/** MinIO's `errMalformedEncoding` / `errChunkTooBig`, which surface as a bare `BadRequest`. */
const malformed = () => new S3Error("BadRequest", { message: "malformed chunked encoding" })
const tooBig = () =>
  new S3Error("BadRequest", { message: "chunk too big: choose chunk size <= 16MiB" })
const MAX_CHUNK_SIZE = 16 << 20

/** Go's `io.ErrUnexpectedEOF`: the stream ended early, which MinIO's writers take as its end. */
class UnexpectedEOF extends Error {}

class ByteReader {
  position = 0
  constructor(private readonly input: Uint8Array) {}
  /** The next byte, or `undefined` at the end. */
  byte() {
    if (this.position >= this.input.length) return undefined
    return this.input[this.position++] as number
  }
  /** Go's `io.ReadFull`: exactly `length` bytes, or what is left and whether it fell short. */
  full(length: number) {
    const out = this.input.subarray(this.position, this.position + length)
    this.position += out.length
    return out
  }
}

export type ChunkSeed = { signature: string; key: Uint8Array; scope: string; stamp: string }

export type ChunkOptions = {
  /** Verify chunk signatures from this seed (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD*`). */
  seed?: ChunkSeed
  /** Trailer names the request declared (`x-amz-trailer`), or undefined for no trailer section. */
  trailers?: string[]
  /** Called with each chunk's data once it has been read (and verified). */
  onData(data: Uint8Array): void
}

export type ChunkResult = {
  /** `eof`: the stream ended properly; `unexpected-eof`: it was cut short. */
  end: "eof" | "unexpected-eof"
  trailers: Record<string, string>
}

const latin1 = new TextDecoder("latin1")

const chunkSignature = async (seed: ChunkSeed, previous: string, data: Uint8Array) =>
  hex(
    await hmac256(
      seed.key,
      [
        "AWS4-HMAC-SHA256-PAYLOAD",
        seed.stamp,
        seed.scope,
        previous,
        EMPTY_SHA256,
        await sha256Hex(data),
      ].join("\n"),
    ),
  )

/** `bufio.Scanner` lines of a trailer block, as `key:value` pairs checked against the wanted set. */
const parseTrailerLines = (text: string, wanted: string[], lowercase: boolean) => {
  const want = new Set(wanted.map((name) => name.toLowerCase()))
  const trailers: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim()
    if (!line) continue
    const index = line.indexOf(":")
    if (index <= 0) throw malformed()
    const key = lowercase ? line.slice(0, index).toLowerCase() : line.slice(0, index)
    if (!want.has(key)) throw malformed()
    trailers[key] = line.slice(index + 1)
    want.delete(key)
  }
  if (want.size) throw new UnexpectedEOF()
  return trailers
}

const readSignedTrailers = async (
  reader: ByteReader,
  seed: ChunkSeed,
  previous: string,
  wanted: string[],
) => {
  let value = ""
  for (;;) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte !== CR) {
      value += String.fromCharCode(byte)
      continue
    }
    const next = reader.byte()
    if (next === undefined) throw new UnexpectedEOF()
    if (next !== LF) throw malformed()
    break
  }
  let signature = ""
  for (;;) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte !== CR) {
      signature += String.fromCharCode(byte)
      continue
    }
    const end = reader.full(3)
    if (end.length === 0) throw new UnexpectedEOF()
    if (latin1.decode(end) !== "\n\r\n") throw malformed()
    break
  }
  const prefix = "x-amz-trailer-signature:"
  if (!signature.startsWith(prefix)) throw malformed()
  if (value.length > 0 && !value.endsWith("\n")) value += "\n"
  const expected = hex(
    await hmac256(
      seed.key,
      [
        "AWS4-HMAC-SHA256-TRAILER",
        seed.stamp,
        seed.scope,
        previous,
        await sha256Hex(new Uint8Array([...value].map((char) => char.charCodeAt(0)))),
      ].join("\n"),
    ),
  )
  if (signature.slice(prefix.length).trim() !== expected) throw new S3Error("SignatureDoesNotMatch")
  return parseTrailerLines(value, wanted, false)
}

const readUnsignedTrailers = (reader: ByteReader, wanted: string[]) => {
  let value = ""
  for (;;) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte !== CR) {
      value += String.fromCharCode(byte)
      continue
    }
    const end = reader.full(3)
    if (end.length === 0) throw new UnexpectedEOF()
    if (latin1.decode(end) !== "\n\r\n") throw malformed()
    break
  }
  return parseTrailerLines(value, wanted, true)
}

/** One signed chunk (`s3ChunkedReader.Read`); `undefined` data marks the final chunk. */
const signedChunk = async (reader: ByteReader, seed: ChunkSeed, previous: string) => {
  let size = 0
  for (;;) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte === 0x3b) break
    const digit = Number.parseInt(String.fromCharCode(byte), 16)
    if (Number.isNaN(digit)) throw malformed()
    size = size * 16 + digit
    if (size > MAX_CHUNK_SIZE) throw tooBig()
  }
  const header = reader.full(80)
  if (header.length < 80) throw new UnexpectedEOF()
  const text = latin1.decode(header)
  if (!text.startsWith("chunk-signature=")) throw malformed()
  for (const want of [CR, LF]) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte !== want) throw malformed()
  }
  const data = reader.full(size)
  if (data.length < size) throw new UnexpectedEOF()
  const signature = await chunkSignature(seed, previous, data)
  if (text.slice(16) !== signature) throw new S3Error("SignatureDoesNotMatch")
  if (size === 0) return { data: undefined, signature }
  if (reader.byte() !== CR) throw malformed()
  const lf = reader.byte()
  if (lf === undefined) throw new UnexpectedEOF()
  if (lf !== LF) throw malformed()
  return { data, signature }
}

/** One unsigned chunk (`s3UnsignedChunkedReader.Read`). */
const unsignedChunk = (reader: ByteReader) => {
  let size = 0
  for (;;) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte === CR) {
      const next = reader.byte()
      if (next === undefined) throw new UnexpectedEOF()
      if (next !== LF) throw malformed()
      break
    }
    const digit = Number.parseInt(String.fromCharCode(byte), 16)
    if (Number.isNaN(digit)) throw malformed()
    size = size * 16 + digit
    if (size > MAX_CHUNK_SIZE) throw tooBig()
  }
  const data = reader.full(size)
  if (data.length < size) throw new UnexpectedEOF()
  if (size === 0) return undefined
  for (const want of [CR, LF]) {
    const byte = reader.byte()
    if (byte === undefined) throw new UnexpectedEOF()
    if (byte !== want) throw malformed()
  }
  return data
}

/**
 * Read an `aws-chunked` body the way MinIO's PutObject consumes it: chunk by chunk, each handed
 * to `onData` once read, until the final chunk (and its trailers) or the input runs out. A body
 * cut short ends the stream (`unexpected-eof`) rather than failing, as MinIO's erasure writer
 * treats `io.ErrUnexpectedEOF` as the last block.
 */
export const readChunks = async (
  input: Uint8Array,
  options: ChunkOptions,
): Promise<ChunkResult> => {
  const reader = new ByteReader(input)
  let previous = options.seed?.signature ?? ""
  try {
    for (;;) {
      if (options.seed) {
        const chunk = await signedChunk(reader, options.seed, previous)
        previous = chunk.signature
        if (chunk.data) {
          options.onData(chunk.data)
          continue
        }
        const trailers = options.trailers
          ? await readSignedTrailers(reader, options.seed, previous, options.trailers)
          : {}
        return { end: "eof", trailers }
      }
      const data = unsignedChunk(reader)
      if (data) {
        options.onData(data)
        continue
      }
      const trailers = options.trailers ? readUnsignedTrailers(reader, options.trailers) : {}
      return { end: "eof", trailers }
    }
  } catch (error) {
    if (!(error instanceof UnexpectedEOF)) throw error
    return { end: "unexpected-eof", trailers: {} }
  }
}
