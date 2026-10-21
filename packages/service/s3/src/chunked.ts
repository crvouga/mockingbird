/**
 * Decodes an `aws-chunked` body, the framing SDK v3 uses for uploads of a known length
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html and
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming-trailers.html):
 * `<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n` repeated, a zero-size chunk, then optional
 * `name:value\r\n` trailers and a final `\r\n`. Chunk signatures are not verified, as header
 * signatures are not on any other request.
 */
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
        return { text: new TextDecoder("latin1").decode(input.subarray(from, index)), next: index + 2 }
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
    trailers[trailer.text.slice(0, colon).trim().toLowerCase()] = trailer.text.slice(colon + 1).trim()
  }
  const payload = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.length
  }
  return { payload, trailers }
}
