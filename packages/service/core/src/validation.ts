import {
  deref,
  resolveSchema,
  type SchemaObject,
  validateValue,
} from "@crvouga/mockingbird-openapi"
import type { OperationContext } from "./service.js"

/** One problem with a request body, at a dotted path (`patient.address.city`, `items.0.sku`). */
export type BodyIssue = { path: string; message: string }

/**
 * Validate the decoded JSON body against the operation's `requestBody` schema in the vendor
 * contract. Returns `[]` when valid, or when the operation declares no JSON body. Services
 * turn the issues into the vendor's own validation error shape.
 */
export const bodyIssues = (
  context: OperationContext,
  contentType = "application/json",
): BodyIssue[] => {
  const requestBody = context.operation.operation.requestBody
  if (!requestBody) return []
  const resolved = deref(context.document, requestBody) as {
    required?: boolean
    content?: Record<string, { schema?: SchemaObject }>
  }
  const schema = resolved.content?.[contentType]?.schema
  if (!schema) return []
  const value =
    context.body.kind === "json" || context.body.kind === "form" ? context.body.value : undefined
  if (context.body.kind === "invalid") {
    return [{ path: "", message: `request body is not valid ${context.body.mediaType}` }]
  }
  if (value === undefined) {
    return resolved.required ? [{ path: "", message: "request body is required" }] : []
  }
  return validateValue(context.document, resolveSchema(context.document, schema), value).map(
    (issue) => ({ path: issue.path.join("."), message: issue.message }),
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
