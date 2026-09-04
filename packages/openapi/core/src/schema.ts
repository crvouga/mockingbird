import { resolveRef } from "./refs.js"
import type { JsonValue, OpenAPIDocument, SchemaObject, SchemaType } from "./types.js"

/**
 * Resolve a schema's `$ref` (merging sibling keywords, as JSON Schema 2020-12 allows) and
 * normalise OpenAPI 3.0 `nullable` into a 3.1 type array.
 */
export const resolveSchema = (document: OpenAPIDocument, schema: SchemaObject): SchemaObject => {
  let current = schema
  const seen = new Set<string>()
  while (typeof current.$ref === "string") {
    const ref = current.$ref
    if (seen.has(ref)) break
    seen.add(ref)
    const { $ref: _ignored, ...siblings } = current
    const target = resolveRef(document, ref) as SchemaObject
    current = { ...target, ...siblings }
  }
  if (current.nullable === true) {
    const { nullable: _nullable, ...rest } = current
    const types = schemaTypes(rest)
    if (types.length > 0 && !types.includes("null")) current = { ...rest, type: [...types, "null"] }
    else current = rest
  }
  return current
}

/** Declared JSON types of a schema (empty when unconstrained). */
export const schemaTypes = (schema: SchemaObject): SchemaType[] => {
  if (Array.isArray(schema.type)) return schema.type
  if (schema.type !== undefined) return [schema.type]
  const inferred: SchemaType[] = []
  if (schema.properties || schema.required || schema.additionalProperties !== undefined)
    inferred.push("object")
  if (
    schema.items ||
    schema.prefixItems ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined
  )
    inferred.push("array")
  if (
    schema.minLength !== undefined ||
    schema.maxLength !== undefined ||
    schema.pattern !== undefined
  )
    inferred.push("string")
  if (
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.multipleOf !== undefined
  )
    inferred.push("number")
  return inferred
}

/** The JSON type name of a runtime value. */
export const jsonTypeOf = (value: unknown): SchemaType | "undefined" => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "boolean":
      return "boolean"
    case "number":
      return Number.isInteger(value) ? "integer" : "number"
    case "object":
      return "object"
    default:
      return "undefined"
  }
}

export type SchemaVisitor = (schema: SchemaObject, path: string[]) => void

/**
 * Depth-first walk over a schema tree, resolving `$ref`s. Each schema is visited once per
 * distinct path, cycles are cut by reference identity.
 */
export const walkSchema = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  visit: SchemaVisitor,
  path: string[] = [],
) => {
  const seen = new Set<SchemaObject>()
  const go = (node: SchemaObject, at: string[]) => {
    const resolved = resolveSchema(document, node)
    if (seen.has(resolved)) return
    seen.add(resolved)
    visit(resolved, at)
    for (const [name, child] of Object.entries(resolved.properties ?? {}))
      go(child, [...at, "properties", name])
    if (typeof resolved.additionalProperties === "object")
      go(resolved.additionalProperties, [...at, "additionalProperties"])
    if (resolved.items) go(resolved.items, [...at, "items"])
    resolved.prefixItems?.forEach((child, i) => {
      go(child, [...at, "prefixItems", String(i)])
    })
    resolved.propertyNames && go(resolved.propertyNames, [...at, "propertyNames"])
    for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
      resolved[keyword]?.forEach((child, i) => {
        go(child, [...at, keyword, String(i)])
      })
    }
    resolved.not && go(resolved.not, [...at, "not"])
    seen.delete(resolved)
  }
  go(schema, path)
}

export type ValidationError = { path: Array<string | number>; message: string }

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(b)) {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    )
  }
  return false
}

const FORMAT_PATTERNS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/,
  ipv4: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
}

const graphemeLength = (value: string) => [...value].length

/**
 * Validate `value` against `schema`. Supports the JSON Schema subset Mockingbird generates from
 * (see `@crvouga/mockingbird-openapi-arbitrary`). Returns an empty array when valid.
 */
export const validateValue = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  value: unknown,
  path: Array<string | number> = [],
): ValidationError[] => {
  const errors: ValidationError[] = []
  const s = resolveSchema(document, schema)
  const fail = (message: string) => errors.push({ path, message })
  const actual = jsonTypeOf(value)
  if (actual === "undefined") {
    fail("value is undefined")
    return errors
  }
  const types = schemaTypes(s)
  if (types.length > 0) {
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"))
    if (!ok) {
      fail(`expected type ${types.join("|")}, got ${actual}`)
      return errors
    }
  }
  // OpenAPI commonly pairs `type: ["string","null"]` with an enum of the non-null values;
  // null is admitted by the type union and must not fail the enum check.
  if (
    s.enum &&
    !(value === null && types.includes("null")) &&
    !s.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    fail("value not in enum")
  }
  if (s.const !== undefined && !deepEqual(s.const, value)) fail("value does not equal const")
  if (typeof value === "string") {
    const length = graphemeLength(value)
    if (s.minLength !== undefined && length < s.minLength)
      fail(`length ${length} < minLength ${s.minLength}`)
    if (s.maxLength !== undefined && length > s.maxLength)
      fail(`length ${length} > maxLength ${s.maxLength}`)
    if (s.pattern !== undefined) {
      try {
        if (!new RegExp(s.pattern, "u").test(value)) fail(`does not match pattern ${s.pattern}`)
      } catch {
        // unsupported pattern syntax: skip, matching lenient validators
      }
    }
    if (s.format !== undefined) {
      const pattern = FORMAT_PATTERNS[s.format]
      if (pattern && !pattern.test(value)) fail(`does not match format ${s.format}`)
    }
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) fail(`${value} < minimum ${s.minimum}`)
    if (s.maximum !== undefined && value > s.maximum) fail(`${value} > maximum ${s.maximum}`)
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum)
      fail(`${value} <= exclusiveMinimum ${s.exclusiveMinimum}`)
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)
      fail(`${value} >= exclusiveMaximum ${s.exclusiveMaximum}`)
    if (
      s.multipleOf !== undefined &&
      Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-9
    ) {
      fail(`${value} is not a multiple of ${s.multipleOf}`)
    }
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems)
      fail(`${value.length} items < minItems ${s.minItems}`)
    if (s.maxItems !== undefined && value.length > s.maxItems)
      fail(`${value.length} items > maxItems ${s.maxItems}`)
    if (
      s.uniqueItems &&
      value.some((item, i) => value.slice(0, i).some((prev) => deepEqual(prev, item)))
    )
      fail("items are not unique")
    value.forEach((item, i) => {
      const itemSchema = s.prefixItems?.[i] ?? s.items
      if (itemSchema) errors.push(...validateValue(document, itemSchema, item, [...path, i]))
    })
  }
  if (actual === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    for (const name of s.required ?? [])
      if (!(name in record)) fail(`missing required property ${name}`)
    if (s.minProperties !== undefined && keys.length < s.minProperties)
      fail(`${keys.length} properties < minProperties ${s.minProperties}`)
    if (s.maxProperties !== undefined && keys.length > s.maxProperties)
      fail(`${keys.length} properties > maxProperties ${s.maxProperties}`)
    for (const key of keys) {
      const property = s.properties?.[key]
      if (property) {
        errors.push(...validateValue(document, property, record[key], [...path, key]))
        continue
      }
      if (s.additionalProperties === false) fail(`unexpected property ${key}`)
      else if (typeof s.additionalProperties === "object") {
        errors.push(...validateValue(document, s.additionalProperties, record[key], [...path, key]))
      }
      if (s.propertyNames) {
        const nameErrors = validateValue(document, s.propertyNames, key, [...path, key])
        if (nameErrors.length > 0)
          fail(`property name ${key} is invalid: ${nameErrors[0]?.message}`)
      }
    }
  }
  if (s.allOf)
    for (const branch of s.allOf) errors.push(...validateValue(document, branch, value, path))
  if (s.anyOf && !s.anyOf.some((branch) => validateValue(document, branch, value).length === 0))
    fail("matches no anyOf branch")
  if (s.oneOf) {
    const matches = s.oneOf.filter(
      (branch) => validateValue(document, branch, value).length === 0,
    ).length
    if (matches !== 1) fail(`matches ${matches} oneOf branches, expected exactly 1`)
  }
  if (s.not && validateValue(document, s.not, value).length === 0)
    fail("matches forbidden `not` schema")
  return errors
}

export const isValid = (document: OpenAPIDocument, schema: SchemaObject, value: unknown) =>
  validateValue(document, schema, value).length === 0

export type { JsonValue }
