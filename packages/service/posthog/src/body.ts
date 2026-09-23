import { fromBase64 } from "@crvouga/mockingbird-service"

/**
 * PostHog clients post the same JSON in several envelopes:
 *
 * - posthog-node / posthog-react-native: `Content-Encoding: gzip` over `application/json`;
 * - posthog-js: raw gzip bytes as `text/plain` (`?compression=gzip-js`, or no hint at all),
 *   or `data=<base64 JSON>` form bodies (`?compression=base64`, beacons), or plain JSON;
 * - our own raw fetches: plain JSON.
 *
 * {@link decodePostHogBody} undoes every envelope and returns the JSON value (or `undefined`).
 */

const utf8 = new TextDecoder("utf-8", { fatal: false })

const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array | undefined> => {
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return undefined
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const fromBase64Text = (text: string): string | undefined => {
  try {
    return utf8.decode(fromBase64(text.trim().replace(/-/g, "+").replace(/_/g, "/")))
  } catch {
    return undefined
  }
}

/** JSON from text that is JSON, base64 JSON, or a `data=` form carrying either. */
const fromText = (text: string, compression: string | null): unknown => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith("data=") || /(^|&)data=/.test(trimmed)) {
    const data = new URLSearchParams(trimmed).get("data")
    if (data !== null) return fromText(data, compression)
  }
  if (compression !== "base64") {
    const direct = parseJson(trimmed)
    if (direct !== undefined) return direct
  }
  const decoded = fromBase64Text(trimmed)
  return decoded === undefined ? undefined : parseJson(decoded)
}

/** Decode raw request bytes, given the request's headers and URL. */
export const decodeBytes = async (
  bytes: Uint8Array,
  headers: Headers,
  url: URL,
): Promise<unknown> => {
  if (bytes.byteLength === 0) return undefined
  const compression = url.searchParams.get("compression")
  let raw = bytes
  const encoding = headers.get("content-encoding")?.toLowerCase()
  if (encoding === "gzip" || isGzip(raw)) {
    const inflated = await gunzip(raw)
    if (inflated === undefined) return undefined
    raw = inflated
  }
  return fromText(utf8.decode(raw), compression)
}

const decoded = new WeakMap<Request, Promise<unknown>>()

/**
 * The JSON a PostHog request carries, whatever its envelope. Memoised per `Request`, and read
 * from a clone, so the namespace lookup and the handler can both call it.
 */
export const decodePostHogBody = (request: Request): Promise<unknown> => {
  const cached = decoded.get(request)
  if (cached) return cached
  const pending =
    request.method === "GET" || request.method === "HEAD" || request.body === null
      ? Promise.resolve(undefined)
      : request
          .clone()
          .arrayBuffer()
          .then((buffer) =>
            decodeBytes(new Uint8Array(buffer), request.headers, new URL(request.url)),
          )
          .catch(() => undefined)
  decoded.set(request, pending)
  return pending
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

/**
 * The project token a decoded body carries: `token` (flags), `api_key` (capture, raw fetches,
 * decide), or the first event's `properties.token` / `token` (posthog-js batches).
 */
export const tokenFromBody = (body: unknown): string | undefined => {
  if (Array.isArray(body)) return tokenFromBody(body[0])
  if (!isRecord(body)) return undefined
  const direct = nonEmpty(body.token) ?? nonEmpty(body.api_key)
  if (direct) return direct
  if (Array.isArray(body.batch)) return tokenFromBody(body.batch[0])
  if (isRecord(body.properties)) return nonEmpty(body.properties.token)
  return undefined
}

const ARRAY_PATH = /^\/array\/([^/]+)\/config(\.js)?\/?$/

/**
 * The project token a request carries anywhere: the `/array/{token}/config` path, `?token=` /
 * `?api_key=`, or the body. Used to map tokens to namespaces (`PUT /__admin/credentials`).
 */
export const requestToken = async (request: Request, path: string): Promise<string | undefined> => {
  const url = new URL(request.url)
  const fromPath = ARRAY_PATH.exec(path)?.[1]
  if (fromPath) return decodeURIComponent(fromPath)
  const fromQuery =
    nonEmpty(url.searchParams.get("token")) ?? nonEmpty(url.searchParams.get("api_key"))
  if (fromQuery) return fromQuery
  return tokenFromBody(await decodePostHogBody(request))
}
