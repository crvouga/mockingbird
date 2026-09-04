import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { jsonTypeOf, resolveSchema, schemaTypes, validateValue } from "@crvouga/mockingbird-openapi"
import { schemaMetadata } from "./read.js"
import type { VolatileKind } from "./types.js"

export type JsonPath = Array<string | number>

export type Annotation =
  | { kind: "identity"; path: JsonPath; type: string }
  | { kind: "volatile"; path: JsonPath; volatile: VolatileKind }

const typeMatches = (schema: SchemaObject, value: unknown) => {
  const types = schemaTypes(schema)
  if (types.length === 0) return true
  const actual = jsonTypeOf(value)
  return types.some((t) => t === actual || (t === "number" && actual === "integer"))
}

/**
 * Pick the branch of a union that describes `value`: first a fully valid branch, then the first
 * whose declared type matches. Returns `undefined` when nothing plausibly applies.
 */
const selectBranch = (
  document: OpenAPIDocument,
  branches: SchemaObject[],
  value: unknown,
): SchemaObject | undefined => {
  const resolved = branches.map((b) => resolveSchema(document, b))
  const valid = resolved.find((b) => validateValue(document, b, value).length === 0)
  if (valid) return valid
  return resolved.find((b) => typeMatches(b, value))
}

/**
 * Walk `value` guided by `schema` and report every identity / volatile location.
 * Values with no schema coverage (unknown properties, unmatched union branches) yield nothing,
 * which means they are compared strictly by the canonicalizer.
 */
export const annotateValue = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  value: unknown,
  path: JsonPath = [],
): Annotation[] => {
  const out: Annotation[] = []
  const go = (node: SchemaObject, current: unknown, at: JsonPath, depth: number) => {
    if (depth > 64) return
    const resolved = resolveSchema(document, node)
    const meta = schemaMetadata(resolved)
    if (meta.resource && typeof current === "string")
      out.push({ kind: "identity", path: at, type: meta.resource.type })
    else if (meta.volatile && current !== null && current !== undefined) {
      out.push({ kind: "volatile", path: at, volatile: meta.volatile.kind })
    }
    if (resolved.allOf) for (const branch of resolved.allOf) go(branch, current, at, depth + 1)
    const union = resolved.oneOf ?? resolved.anyOf
    if (union) {
      const branch = selectBranch(document, union, current)
      if (branch) go(branch, current, at, depth + 1)
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        const itemSchema = resolved.prefixItems?.[index] ?? resolved.items
        if (itemSchema) go(itemSchema, item, [...at, index], depth + 1)
      })
      return
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, item] of Object.entries(current)) {
        const property = resolved.properties?.[key]
        if (property) go(property, item, [...at, key], depth + 1)
        else if (typeof resolved.additionalProperties === "object") {
          go(resolved.additionalProperties, item, [...at, key], depth + 1)
        }
      }
    }
  }
  go(schema, value, path, 0)
  return out
}

export const pathKey = (path: JsonPath) => path.map((segment) => JSON.stringify(segment)).join(".")
