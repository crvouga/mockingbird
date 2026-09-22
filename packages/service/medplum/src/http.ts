/**
 * The self-hosted server's HTTP conventions (packages/server/src/app.ts, fhir/outcomes.ts,
 * fhir/response.ts): standard security headers, OperationOutcome responses with the tracing
 * extension, Express's JSON/form body parsers and its 404 page.
 */
import {
  badRequest,
  ContentType,
  getOutcomeRedirectUrl,
  getStatus,
  isAccepted,
  isRedirect,
  stringify,
} from "@medplum/core"
import type { Extension, OperationOutcome } from "@medplum/fhirtypes"

export const FHIR_JSON = "application/fhir+json; charset=utf-8"
export const JSON_UTF8 = "application/json; charset=utf-8"

/** Headers `standardHeaders` puts on every response. */
export const standardHeaders = (): Headers =>
  new Headers({
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
    "permissions-policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-xss-protection": "1; mode=block",
  })

export type RequestIds = { requestId: string; traceId: string }

/** `buildTracingExtension`: request and trace ids on every sent OperationOutcome. */
export const tracingExtension = (ids: RequestIds): Extension => ({
  url: "https://medplum.com/fhir/StructureDefinition/tracing",
  extension: [
    { url: "requestId", valueId: ids.requestId },
    { url: "traceId", valueId: ids.traceId },
  ],
})

/** `res.type(t)` (mime-types `contentType`): text and JSON types gain `; charset=utf-8`. */
export const expressContentType = (type: string): string => {
  if (type.includes(";")) return type
  const lowered = type.toLowerCase()
  const utf8 =
    lowered.startsWith("text/") ||
    lowered === "application/json" ||
    lowered.endsWith("+json") ||
    lowered === "application/javascript"
  return utf8 ? `${type}; charset=utf-8` : type
}

export const respond = (
  status: number,
  body: string | Uint8Array | null,
  contentType?: string,
  extra?: Record<string, string>,
): Response => {
  const headers = standardHeaders()
  if (contentType) headers.set("content-type", expressContentType(contentType))
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value)
  return new Response(status === 204 || status === 304 ? null : (body as BodyInit | null), {
    status,
    headers,
  })
}

/** `res.status(n).json(value)`: plain JSON (`JSON.stringify`, undefined keys dropped). */
export const json = (status: number, value: unknown, extra?: Record<string, string>): Response =>
  respond(status, JSON.stringify(value), JSON_UTF8, extra)

/** `sendOutcome`: status from the outcome, FHIR JSON, tracing extension appended. */
export const sendOutcome = (
  outcome: OperationOutcome,
  ids: RequestIds,
  extra?: Record<string, string>,
): Response => {
  const headers: Record<string, string> = { ...extra }
  if (isAccepted(outcome) && outcome.issue?.[0]?.diagnostics)
    headers["content-location"] = outcome.issue[0].diagnostics
  if (isRedirect(outcome)) {
    const uri = getOutcomeRedirectUrl(outcome)
    if (uri) headers.location = uri
  }
  const extension = [tracingExtension(ids), ...(outcome.extension ?? [])]
  return respond(getStatus(outcome), stringify({ ...outcome, extension }), FHIR_JSON, headers)
}

/** Express's `Cannot <METHOD> <path>` 404 page. */
export const expressNotFound = (method: string, path: string): Response => {
  const escaped = path
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
  const body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${method} ${escaped}</pre>\n</body>\n</html>\n`
  // Express's final handler replaces the CSP header on its error pages.
  return respond(404, body, "text/html; charset=utf-8", {
    "content-security-policy": "default-src 'none'",
  })
}

/** A parsed request body, the way Express's parsers leave `req.body`. */
export type ParsedBody =
  | { kind: "none" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; value: Record<string, string | string[]> }
  | { kind: "text"; value: string }
  | { kind: "raw"; bytes: Uint8Array; contentType: string }

export class BodyParseError extends Error {
  constructor() {
    super("Content could not be parsed")
  }
}

const mediaType = (contentType: string | null): string =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""

/** `application/json` or `application/*+json`, the server's `JSON_TYPE`. */
export const isJsonType = (contentType: string | null): boolean => {
  const type = mediaType(contentType)
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))
}

/**
 * Read a request body as the server's body parsers would: JSON (strict: objects and arrays
 * only) for JSON media types, flat `urlencoded` forms, `text/plain`; anything else is left
 * unparsed. Throws {@link BodyParseError} for malformed JSON.
 */
export const parseBody = async (request: Request): Promise<ParsedBody> => {
  if (request.method === "GET" || request.method === "HEAD") return { kind: "none" }
  const contentType = request.headers.get("content-type")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0 && !contentType) return { kind: "none" }
  if (isJsonType(contentType)) {
    if (bytes.length === 0) return { kind: "none" }
    const text = new TextDecoder().decode(bytes)
    const trimmed = text.trimStart()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) throw new BodyParseError()
    try {
      return { kind: "json", value: JSON.parse(text) }
    } catch {
      throw new BodyParseError()
    }
  }
  const type = mediaType(contentType)
  if (type === ContentType.FORM_URL_ENCODED) {
    const form: Record<string, string | string[]> = {}
    for (const [key, value] of new URLSearchParams(new TextDecoder().decode(bytes))) {
      const existing = form[key]
      if (existing === undefined) form[key] = value
      else form[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
    }
    return { kind: "form", value: form }
  }
  if (type === ContentType.TEXT || type === ContentType.HL7_V2) {
    return { kind: "text", value: new TextDecoder().decode(bytes) }
  }
  return { kind: "raw", bytes, contentType: contentType ?? "" }
}

export const contentCouldNotBeParsed = () => badRequest("Content could not be parsed")
