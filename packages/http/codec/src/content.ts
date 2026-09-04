import { decodeForm, encodeForm } from "./form.js"

export const JSON_MEDIA_TYPE = "application/json"
export const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded"

/** The essence of a `Content-Type` header: lower-cased media type without parameters. */
export const mediaTypeOf = (contentType: string | null | undefined): string | undefined => {
  if (!contentType) return undefined
  const essence = contentType.split(";")[0]?.trim().toLowerCase()
  return essence ? essence : undefined
}

const isJsonMediaType = (mediaType: string) =>
  mediaType === JSON_MEDIA_TYPE || mediaType.endsWith("+json") || mediaType === "text/json"

export type DecodedBody =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; value: Record<string, unknown> }
  | { kind: "text"; value: string }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "invalid"; mediaType: string; text: string; error: string }

const utf8 = new TextDecoder("utf-8", { fatal: false })

/**
 * Decode raw bytes according to a `Content-Type`. Never throws: malformed payloads come back as
 * `{ kind: "invalid" }` so callers (mock servers, the differential runner) can respond like a real
 * server would instead of crashing.
 */
export const decodeBody = (
  contentType: string | null | undefined,
  bytes: Uint8Array,
): DecodedBody => {
  if (bytes.byteLength === 0) return { kind: "empty" }
  const mediaType = mediaTypeOf(contentType)
  if (mediaType === undefined) return { kind: "bytes", value: bytes }
  if (isJsonMediaType(mediaType)) {
    const text = utf8.decode(bytes)
    try {
      return { kind: "json", value: JSON.parse(text) }
    } catch (error) {
      return {
        kind: "invalid",
        mediaType,
        text,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (mediaType === FORM_MEDIA_TYPE) {
    return { kind: "form", value: decodeForm(utf8.decode(bytes)) }
  }
  if (mediaType.startsWith("text/")) return { kind: "text", value: utf8.decode(bytes) }
  return { kind: "bytes", value: bytes }
}

/** Read and decode a Request/Response body. */
export const readBody = async (message: Request | Response): Promise<DecodedBody> => {
  const bytes = new Uint8Array(await message.arrayBuffer())
  return decodeBody(message.headers.get("content-type"), bytes)
}

export type EncodedBody = {
  contentType: string
  body: string
}

/** Encode a JSON-like value for the given media type. Throws for unsupported media types. */
export const encodeBody = (mediaType: string, value: unknown): EncodedBody => {
  const essence = mediaTypeOf(mediaType) ?? mediaType
  if (isJsonMediaType(essence)) return { contentType: essence, body: JSON.stringify(value) }
  if (essence === FORM_MEDIA_TYPE) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`${FORM_MEDIA_TYPE} bodies must be objects`)
    }
    return { contentType: essence, body: encodeForm(value as Record<string, unknown>) }
  }
  if (essence.startsWith("text/")) return { contentType: essence, body: String(value) }
  throw new TypeError(`unsupported request media type: ${mediaType}`)
}
