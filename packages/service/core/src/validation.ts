import { mediaTypeOf } from "@crvouga/mockingbird-http-codec"
import {
  deref,
  resolveSchema,
  type SchemaObject,
  validateValue,
} from "@crvouga/mockingbird-openapi"
import type { OperationContext } from "./service.js"

/**
 * One problem with a request body, at a dotted path (`patient.address.city`, `items.0.sku`).
 * `kind` is `media_type` when the body is present but its media type is not one the operation
 * accepts (a `415` on most vendors), `syntax` when it could not be decoded, `required` when
 * the operation needs a body and none arrived, and `schema` for a contract violation.
 */
export type BodyIssue = {
  path: string
  message: string
  kind?: "media_type" | "syntax" | "required" | "schema"
}

/** What the runtime records about a request the mock rejected: never the body itself. */
export type UnsupportedMediaType = {
  /** The request's media type (`text/plain`), or `null` when it sent no `content-type`. */
  mediaType: string | null
  /** The media types the operation's contract accepts, as written (`application/*+json`). */
  accepted: string[]
}

type ResolvedRequestBody = {
  required?: boolean
  content?: Record<string, { schema?: SchemaObject }>
}

const requestBodyOf = (context: OperationContext): ResolvedRequestBody | undefined => {
  const requestBody = context.operation.operation.requestBody
  return requestBody ? (deref(context.document, requestBody) as ResolvedRequestBody) : undefined
}

/** `application/*+json` accepts `application/vnd.api+json`; a star on both sides accepts anything. */
const mediaTypeMatches = (accepted: string, actual: string): boolean => {
  const pattern = mediaTypeOf(accepted) ?? accepted.toLowerCase()
  if (pattern === actual || pattern === "*/*") return true
  const [type, subtype] = pattern.split("/")
  const [actualType, actualSubtype] = actual.split("/")
  if (type !== actualType && type !== "*") return false
  if (subtype === undefined || subtype === "*") return true
  if (subtype.startsWith("*+")) return actualSubtype?.endsWith(subtype.slice(1)) === true
  return false
}

/**
 * Which key of the operation's `requestBody.content` the request's `content-type` selects,
 * or undefined when none matches (or the operation declares no body).
 */
const acceptedKeyFor = (
  content: Record<string, unknown> | undefined,
  mediaType: string | undefined,
): string | undefined => {
  if (!content || mediaType === undefined) return undefined
  const keys = Object.keys(content)
  return (
    keys.find((key) => mediaTypeOf(key) === mediaType) ??
    keys.find((key) => mediaTypeMatches(key, mediaType))
  )
}

/**
 * The reason a request body cannot be read by this operation: its `content-type` is missing
 * or names a media type the contract does not list. Undefined when the operation declares no
 * body, the media type is accepted, or the body is empty (unless `includeEmpty`: ASP.NET
 * Core picks the input formatter from the header before looking at the body, so even an
 * empty body with no `content-type` is 415 there). A JSON body sent as `text/plain` or with
 * no header is the common case: ASP.NET Core, Spring and Rails answer it `415`, and it must
 * never read as "request body is required".
 */
export const unsupportedMediaType = (
  context: OperationContext,
  options: { includeEmpty?: boolean } = {},
): UnsupportedMediaType | undefined => {
  if (context.body.kind === "empty" && options.includeEmpty !== true) return undefined
  const content = requestBodyOf(context)?.content
  if (!content || Object.keys(content).length === 0) return undefined
  const mediaType = mediaTypeOf(context.request.headers.get("content-type"))
  if (acceptedKeyFor(content, mediaType) !== undefined) return undefined
  return { mediaType: mediaType ?? null, accepted: Object.keys(content) }
}

/** Issues recorded per request, for the runtime's log entry of a rejected request. */
const recorded = new WeakMap<Request, BodyIssue[]>()

/** The issues `bodyIssues` last found for a request, if any. */
export const recordedIssues = (request: Request): BodyIssue[] | undefined => recorded.get(request)

/**
 * Validate the decoded body against the operation's `requestBody` schema in the vendor
 * contract, for the media type the request sent (or `contentType` when it sent none that the
 * contract lists). Returns `[]` when valid, or when the operation declares no such body.
 * Services turn the issues into the vendor's own validation error shape; a `media_type`
 * issue is a body the operation cannot read at all (see `unsupportedMediaType`).
 */
export const bodyIssues = (
  context: OperationContext,
  contentType = "application/json",
): BodyIssue[] => {
  const issues = findBodyIssues(context, contentType)
  if (issues.length > 0) recorded.set(context.request, issues)
  return issues
}

const findBodyIssues = (context: OperationContext, contentType: string): BodyIssue[] => {
  const resolved = requestBodyOf(context)
  if (!resolved) return []
  const unsupported = unsupportedMediaType(context)
  if (unsupported) {
    return [
      {
        path: "",
        kind: "media_type",
        message:
          unsupported.mediaType === null
            ? "request body has no content-type"
            : `request body media type ${unsupported.mediaType} is not supported`,
      },
    ]
  }
  const key =
    acceptedKeyFor(resolved.content, mediaTypeOf(context.request.headers.get("content-type"))) ??
    contentType
  const schema = resolved.content?.[key]?.schema
  if (!schema) return []
  if (context.body.kind === "invalid") {
    return [
      {
        path: "",
        kind: "syntax",
        message: `request body is not valid ${context.body.mediaType}`,
      },
    ]
  }
  const value =
    context.body.kind === "json" || context.body.kind === "form" || context.body.kind === "text"
      ? context.body.value
      : undefined
  if (value === undefined) {
    return resolved.required && context.body.kind === "empty"
      ? [{ path: "", kind: "required", message: "request body is required" }]
      : []
  }
  return validateValue(context.document, resolveSchema(context.document, schema), value).map(
    (issue) => ({ path: issue.path.join("."), kind: "schema", message: issue.message }),
  )
}

/** Issues grouped Laravel-style: `{ "patient.email": ["…"] }`. */
export const issuesByField = (issues: BodyIssue[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const issue of issues) {
    const missing = /^missing required property (.+)$/.exec(issue.message)
    const field = missing
      ? [issue.path, missing[1]].filter(Boolean).join(".")
      : issue.path || "body"
    const message = missing
      ? `The ${field} field is required.`
      : `The ${field} field ${issue.message}.`
    out[field] = [...(out[field] ?? []), message]
  }
  return out
}
