import type { FormValue } from "@crvouga/mockingbird-http-codec"
import {
  type OpenAPIDocument,
  resolveSchema,
  type SchemaObject,
  schemaTypes,
} from "@crvouga/mockingbird-openapi"

/**
 * Why a form value did not fit its schema. `path` uses bracket notation (`shipping[address][line1]`)
 * because that is how form-encoded APIs name parameters in their errors.
 */
export type FormIssue =
  | { kind: "unknown"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "empty"; path: string }
  | { kind: "invalid-integer" | "invalid-number" | "invalid-boolean"; path: string; raw: string }
  | { kind: "invalid-object" | "invalid-array"; path: string; raw: string }
  | { kind: "invalid-enum"; path: string; raw: string; allowed: string[] }
  | { kind: "too-long"; path: string; raw: string; limit: number }
  | { kind: "too-many-items"; path: string; count: number; limit: number }
  | { kind: "below-minimum"; path: string; raw: string; limit: number }
  | { kind: "above-maximum"; path: string; raw: string; limit: number }

export type ParsedForm = { value: unknown; issues: FormIssue[] }

/** Providers typically report one problem; unknown parameters win, then missing ones, then bad values. */
const PRIORITY: Record<FormIssue["kind"], number> = {
  unknown: 0,
  missing: 1,
  empty: 2,
  "invalid-integer": 2,
  "invalid-number": 2,
  "invalid-boolean": 2,
  "invalid-object": 2,
  "invalid-array": 2,
  "invalid-enum": 2,
  "too-long": 2,
  "too-many-items": 2,
  "below-minimum": 2,
  "above-maximum": 2,
}

export const sortIssues = (issues: FormIssue[]) =>
  issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => PRIORITY[a.issue.kind] - PRIORITY[b.issue.kind] || a.index - b.index)
    .map((entry) => entry.issue)

const join = (path: string, key: string | number) => (path === "" ? String(key) : `${path}[${key}]`)

const isObject = (value: unknown): value is Record<string, FormValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const allowsEmptyString = (document: OpenAPIDocument, schema: SchemaObject): boolean => {
  const resolved = resolveSchema(document, schema)
  if (Array.isArray(resolved.enum) && resolved.enum.includes("")) return true
  return (resolved.anyOf ?? resolved.oneOf ?? []).some((branch) =>
    allowsEmptyString(document, branch),
  )
}

const codePoints = (value: string) => [...value].length

/**
 * Coerce a bracket-decoded form value against an OpenAPI schema the way form-encoded APIs do:
 * every leaf arrives as a string, so integers/numbers/booleans are parsed, unknown keys are
 * rejected, required keys are enforced and constraints are checked. Empty strings stay `""`
 * for string-typed leaves (providers decide whether that means "unset"), become `[]` for arrays
 * when the schema permits it, and are reported as invalid for numeric/boolean leaves.
 *
 * `anyOf`/`oneOf` picks the branch matching the value's shape (object/array/scalar).
 */
export const parseForm = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  raw: FormValue | undefined,
  path = "",
): ParsedForm => {
  const issues: FormIssue[] = []
  const value = walk(document, schema, raw, path, issues)
  return { value, issues: sortIssues(issues) }
}

const walk = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  raw: FormValue | undefined,
  path: string,
  issues: FormIssue[],
): unknown => {
  const resolved = resolveSchema(document, schema)
  const union = resolved.anyOf ?? resolved.oneOf
  if (union && union.length > 0) {
    if (raw === "" && allowsEmptyString(document, resolved)) return ""
    const branches = union.map((branch) => resolveSchema(document, branch))
    const shape = isObject(raw) ? "object" : Array.isArray(raw) ? "array" : "scalar"
    const pick =
      branches.find((branch) => {
        const types = schemaTypes(branch)
        if (shape === "object") return types.includes("object") || branch.properties !== undefined
        if (shape === "array") return types.includes("array") || branch.items !== undefined
        return (
          !types.includes("object") &&
          !types.includes("array") &&
          !(types.length === 1 && types[0] === "null")
        )
      }) ?? undefined
    if (!pick) {
      const first = branches[0]
      const firstTypes = first ? schemaTypes(first) : []
      const kind = firstTypes.includes("array") ? "invalid-array" : "invalid-object"
      issues.push({ kind, path, raw: typeof raw === "string" ? raw : "" })
      return undefined
    }
    return walk(document, pick, raw, path, issues)
  }

  const types = schemaTypes(resolved).filter((type) => type !== "null")
  const type = types[0] ?? (resolved.properties ? "object" : resolved.items ? "array" : undefined)

  if (type === "object") {
    if (raw === "") {
      issues.push({ kind: "empty", path })
      return undefined
    }
    if (!isObject(raw)) {
      issues.push({ kind: "invalid-object", path, raw: typeof raw === "string" ? raw : "" })
      return undefined
    }
    const properties = resolved.properties ?? {}
    const additional = resolved.additionalProperties
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(raw)) {
      const property = properties[key]
      if (property) {
        out[key] = walk(document, property, item, join(path, key), issues)
      } else if (additional !== undefined && additional !== false) {
        out[key] =
          additional === true ? item : walk(document, additional, item, join(path, key), issues)
      } else {
        issues.push({ kind: "unknown", path: join(path, key) })
      }
    }
    for (const key of resolved.required ?? []) {
      if (!(key in raw)) issues.push({ kind: "missing", path: join(path, key) })
    }
    return out
  }

  if (type === "array") {
    if (raw === "") {
      issues.push({ kind: "empty", path })
      return undefined
    }
    if (!Array.isArray(raw)) {
      issues.push({ kind: "invalid-array", path, raw: typeof raw === "string" ? raw : "" })
      return undefined
    }
    if (resolved.maxItems !== undefined && raw.length > resolved.maxItems) {
      issues.push({ kind: "too-many-items", path, count: raw.length, limit: resolved.maxItems })
    }
    const items = resolved.items ?? {}
    return raw.map((item, index) => {
      if (item === "" && !allowsEmptyString(document, items)) {
        issues.push({ kind: "empty", path: join(path, index) })
        return undefined
      }
      return walk(document, items, item, join(path, index), issues)
    })
  }

  if (typeof raw !== "string") {
    const kind = isObject(raw) ? "invalid-object" : "invalid-array"
    issues.push({ kind, path, raw: "" })
    return undefined
  }

  if (type === "integer" || type === "number") {
    const pattern = type === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/
    if (!pattern.test(raw)) {
      issues.push({ kind: type === "integer" ? "invalid-integer" : "invalid-number", path, raw })
      return undefined
    }
    const parsed = Number(raw)
    if (resolved.minimum !== undefined && parsed < resolved.minimum) {
      issues.push({ kind: "below-minimum", path, raw, limit: resolved.minimum })
      return undefined
    }
    if (resolved.maximum !== undefined && parsed > resolved.maximum) {
      issues.push({ kind: "above-maximum", path, raw, limit: resolved.maximum })
      return undefined
    }
    return parsed
  }

  if (type === "boolean") {
    if (raw === "true") return true
    if (raw === "false") return false
    issues.push({ kind: "invalid-boolean", path, raw })
    return undefined
  }

  if (Array.isArray(resolved.enum)) {
    const allowed = resolved.enum.filter((item): item is string => typeof item === "string")
    if (!allowed.includes(raw)) {
      issues.push({
        kind: "invalid-enum",
        path,
        raw,
        allowed: allowed.filter((item) => item !== ""),
      })
      return undefined
    }
    return raw
  }

  if (resolved.maxLength !== undefined && codePoints(raw) > resolved.maxLength) {
    issues.push({ kind: "too-long", path, raw, limit: resolved.maxLength })
    return undefined
  }
  return raw
}
