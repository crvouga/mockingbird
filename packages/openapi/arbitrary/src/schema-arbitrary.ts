import type {
  JsonValue,
  OpenAPIDocument,
  SchemaObject,
  SchemaType,
} from "@crvouga/mockingbird-openapi"
import { resolveSchema, schemaTypes, validateValue } from "@crvouga/mockingbird-openapi"
import fc from "fast-check"

/** Where a schema node sits inside the root schema, e.g. `["properties", "address", "properties", "city"]`. */
export type SchemaPath = string[]

/**
 * Result of the override hook:
 * - an arbitrary replaces generation for that node
 * - `"omit"` removes an (optional) property entirely
 * - `undefined` falls through to schema-driven generation
 */
export type Override = fc.Arbitrary<unknown> | "omit" | undefined

export type SchemaArbitraryOptions = {
  document: OpenAPIDocument
  /** `request` skips `readOnly` properties, `response` skips `writeOnly`. Default `request`. */
  mode?: "request" | "response"
  /** Inspect each (resolved) schema node before generation. */
  override?: (schema: SchemaObject, path: SchemaPath) => Override
  /** Chance an optional property is present. Default 0.5. */
  optionalProbability?: number
  /** Recursion guard for self-referential schemas. Default 6. */
  maxDepth?: number
}

const DEFAULT_MAX_LENGTH = 24
const DEFAULT_MAX_ITEMS = 4
const DEFAULT_MAX_PROPERTIES = 4
const DEFAULT_INTEGER_BOUND = 1_000_000
const SAFE_INTEGER_BOUND = Number.MAX_SAFE_INTEGER

const uniq = <T>(items: T[]) => [...new Set(items)]

/** Weighted mix of a schema's exact boundaries and values just inside them. */
const boundaryIntegers = (min: number, max: number) =>
  uniq(
    [min, min + 1, max - 1, max, 0, 1, -1].filter(
      (n) => n >= min && n <= max && Number.isSafeInteger(n),
    ),
  )

const integerArbitrary = (schema: SchemaObject): fc.Arbitrary<number> => {
  let min =
    schema.minimum ??
    (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : -DEFAULT_INTEGER_BOUND)
  let max =
    schema.maximum ??
    (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : DEFAULT_INTEGER_BOUND)
  min = Math.max(Math.ceil(min), -SAFE_INTEGER_BOUND)
  max = Math.min(Math.floor(max), SAFE_INTEGER_BOUND)
  if (min > max) return fc.constant(min)
  const random = fc.integer({ min, max })
  const boundaries = boundaryIntegers(min, max)
  const multiple = schema.multipleOf
  const base =
    boundaries.length > 0
      ? fc.oneof(
          { arbitrary: random, weight: 3 },
          { arbitrary: fc.constantFrom(...boundaries), weight: 2 },
        )
      : random
  if (multiple !== undefined && multiple > 0 && Number.isInteger(multiple)) {
    return base.map((n) => Math.round(n / multiple) * multiple).filter((n) => n >= min && n <= max)
  }
  return base
}

const numberArbitrary = (schema: SchemaObject): fc.Arbitrary<number> => {
  const min =
    schema.minimum ??
    (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum : -DEFAULT_INTEGER_BOUND)
  const max =
    schema.maximum ??
    (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum : DEFAULT_INTEGER_BOUND)
  const minExcluded = schema.minimum === undefined && schema.exclusiveMinimum !== undefined
  const maxExcluded = schema.maximum === undefined && schema.exclusiveMaximum !== undefined
  const doubles = fc.double({
    min,
    max,
    minExcluded,
    maxExcluded,
    noNaN: true,
    noDefaultInfinity: true,
  })
  const edges = uniq(
    [schema.minimum, schema.maximum, 0].filter(
      (n): n is number => n !== undefined && n >= min && n <= max,
    ),
  )
  const arbitrary =
    edges.length > 0
      ? fc.oneof(
          { arbitrary: doubles, weight: 3 },
          { arbitrary: fc.constantFrom(...edges), weight: 1 },
        )
      : doubles
  return arbitrary.map((n) => (Number.isInteger(n) ? n : Number(n.toPrecision(12))))
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

const dateArbitrary = fc
  .date({
    min: new Date("1970-01-02T00:00:00.000Z"),
    max: new Date("2099-12-31T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`)

const dateTimeArbitrary = fc
  .date({
    min: new Date("1970-01-02T00:00:00.000Z"),
    max: new Date("2099-12-31T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

const formatArbitrary = (format: string | undefined): fc.Arbitrary<string> | undefined => {
  switch (format) {
    case "uuid":
      return fc.uuid({ version: 4 })
    case "date":
      return dateArbitrary
    case "date-time":
      return dateTimeArbitrary
    case "email":
      return fc.emailAddress()
    case "uri":
    case "url":
      return fc.webUrl()
    case "ipv4":
      return fc.ipV4()
    case "ipv6":
      return fc.ipV6()
    default:
      return undefined
  }
}

/** Mostly printable ASCII, sometimes full unicode, so encodings and length rules get exercised. */
const stringUnits = fc.oneof(
  {
    arbitrary: fc.string({
      unit: fc.constantFrom(
        ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.@".split(""),
      ),
    }),
    weight: 5,
  },
  { arbitrary: fc.string({ unit: "grapheme-ascii" }), weight: 2 },
  { arbitrary: fc.string({ unit: "grapheme" }), weight: 1 },
)

const stringOfLength = (length: number) =>
  fc.oneof(
    {
      arbitrary: fc.string({
        unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
        minLength: length,
        maxLength: length,
      }),
      weight: 3,
    },
    {
      arbitrary: fc.string({ unit: "grapheme-composite", minLength: length, maxLength: length }),
      weight: 1,
    },
  )

/**
 * Boundaries are exercised often when the limit is small; huge limits (Stripe's ubiquitous
 * `maxLength: 5000`) would otherwise dominate generation with enormous values.
 */
const LARGE_LIMIT = 64
const boundaryWeights = (max: number) =>
  max <= LARGE_LIMIT ? { random: 3, boundary: 2 } : { random: 15, boundary: 1 }

const withinDeclaredLength = (schema: SchemaObject) => (s: string) => {
  const length = [...s].length
  if (schema.minLength !== undefined && length < schema.minLength) return false
  if (schema.maxLength !== undefined && length > schema.maxLength) return false
  return true
}

const stringArbitrary = (schema: SchemaObject): fc.Arbitrary<string> => {
  const min = schema.minLength ?? 0
  const max = schema.maxLength ?? Math.max(min, DEFAULT_MAX_LENGTH)
  if (schema.pattern !== undefined) {
    try {
      const regex = new RegExp(schema.pattern, "u")
      return fc.stringMatching(regex).filter(withinDeclaredLength(schema))
    } catch {
      // unsupported pattern syntax: fall back to unconstrained strings
    }
  }
  const byFormat = formatArbitrary(schema.format)
  if (byFormat) return byFormat.filter(withinDeclaredLength(schema))
  const lengths = uniq([min, min + 1, max - 1, max].filter((n) => n >= min && n <= max))
  const random = stringUnits
    .map((s) => [...s].slice(0, max).join(""))
    .filter((s) => [...s].length >= min)
  return fc.oneof(
    { arbitrary: random, weight: boundaryWeights(max).random },
    {
      arbitrary: fc.constantFrom(...lengths).chain((length) => stringOfLength(length)),
      weight: boundaryWeights(max).boundary,
    },
  )
}

const mergeAllOf = (document: OpenAPIDocument, branches: SchemaObject[]): SchemaObject => {
  const merged: SchemaObject = {}
  for (const raw of branches) {
    const branch = resolveSchema(document, raw)
    for (const [key, value] of Object.entries(branch)) {
      if (key === "properties")
        merged.properties = { ...(merged.properties ?? {}), ...(branch.properties ?? {}) }
      else if (key === "required")
        merged.required = uniq([...(merged.required ?? []), ...(branch.required ?? [])])
      else if (key === "allOf") Object.assign(merged, mergeAllOf(document, branch.allOf ?? []))
      else (merged as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

const literalWeighted = (schema: SchemaObject): fc.Arbitrary<JsonValue> | undefined => {
  const candidates: JsonValue[] = []
  if (schema.default !== undefined) candidates.push(schema.default)
  if (schema.example !== undefined) candidates.push(schema.example)
  for (const example of schema.examples ?? []) candidates.push(example)
  return candidates.length === 0 ? undefined : fc.constantFrom(...candidates)
}

/**
 * Build a fast-check arbitrary producing values that satisfy `schema`.
 *
 * Boundaries (min/max, min+1/max-1, empty, minLength/maxLength, minItems/maxItems) are weighted
 * heavily; examples and defaults are mixed in lightly and never replace genuine generation.
 */
export const schemaArbitrary = (
  schema: SchemaObject,
  options: SchemaArbitraryOptions,
): fc.Arbitrary<unknown> => {
  const { document } = options
  const mode = options.mode ?? "request"
  const optionalProbability = options.optionalProbability ?? 0.5
  const maxDepth = options.maxDepth ?? 6

  const build = (node: SchemaObject, path: SchemaPath, depth: number): fc.Arbitrary<unknown> => {
    const resolved = resolveSchema(document, node)
    const override = options.override?.(resolved, path)
    if (override !== undefined && override !== "omit") return override
    if (resolved.const !== undefined) return fc.constant(resolved.const)
    if (resolved.enum && resolved.enum.length > 0) return fc.constantFrom(...resolved.enum)
    if (resolved.allOf && resolved.allOf.length > 0) {
      const { allOf: _allOf, ...rest } = resolved
      return build(mergeAllOf(document, [rest, ...resolved.allOf]), path, depth)
    }
    const union = resolved.oneOf ?? resolved.anyOf
    if (union && union.length > 0) {
      const keyword = resolved.oneOf ? "oneOf" : "anyOf"
      return fc.oneof(
        ...union.map((branch, i) => build(branch, [...path, keyword, String(i)], depth + 1)),
      )
    }
    const types = schemaTypes(resolved)
    const literal = literalWeighted(resolved)
    const byType = (type: SchemaType): fc.Arbitrary<unknown> => {
      switch (type) {
        case "null":
          return fc.constant(null)
        case "boolean":
          return fc.boolean()
        case "integer":
          return integerArbitrary(resolved)
        case "number":
          return resolved.format === "int32" ||
            resolved.format === "int64" ||
            resolved.format === "unix-time"
            ? integerArbitrary(resolved)
            : numberArbitrary(resolved)
        case "string":
          return stringArbitrary(resolved)
        case "array":
          return arrayArbitrary(resolved, path, depth)
        case "object":
          return objectArbitrary(resolved, path, depth)
        default:
          return fc.jsonValue({ maxDepth: 2 })
      }
    }
    let arbitrary: fc.Arbitrary<unknown>
    if (types.length === 0) {
      arbitrary =
        depth >= maxDepth
          ? fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
          : fc.jsonValue({ maxDepth: 2 })
    } else if (types.length === 1) {
      arbitrary = byType(types[0] as SchemaType)
    } else {
      arbitrary = fc.oneof(...types.map(byType))
    }
    return literal
      ? fc.oneof({ arbitrary, weight: 9 }, { arbitrary: literal, weight: 1 })
      : arbitrary
  }

  const arrayArbitrary = (
    node: SchemaObject,
    path: SchemaPath,
    depth: number,
  ): fc.Arbitrary<unknown> => {
    const min = node.minItems ?? 0
    const max = depth >= maxDepth ? min : (node.maxItems ?? Math.max(min, DEFAULT_MAX_ITEMS))
    const items = node.items
      ? build(node.items, [...path, "items"], depth + 1)
      : fc.jsonValue({ maxDepth: 1 })
    if (node.prefixItems) {
      return fc.tuple(
        ...node.prefixItems.map((item, i) =>
          build(item, [...path, "prefixItems", String(i)], depth + 1),
        ),
      )
    }
    const lengths = uniq([min, min + 1, max - 1, max].filter((n) => n >= min && n <= max))
    const sized = (length: number) =>
      node.uniqueItems
        ? fc.uniqueArray(items, {
            minLength: length,
            maxLength: length,
            comparator: "SameValueZero",
          })
        : fc.array(items, { minLength: length, maxLength: length })
    return fc.oneof(
      {
        arbitrary: node.uniqueItems
          ? fc.uniqueArray(items, { minLength: min, maxLength: max, comparator: "SameValueZero" })
          : fc.array(items, { minLength: min, maxLength: max }),
        weight: boundaryWeights(max).random,
      },
      {
        arbitrary: fc.constantFrom(...lengths).chain(sized),
        weight: boundaryWeights(max).boundary,
      },
    )
  }

  const objectArbitrary = (
    node: SchemaObject,
    path: SchemaPath,
    depth: number,
  ): fc.Arbitrary<unknown> => {
    const required = new Set(node.required ?? [])
    const properties = Object.entries(node.properties ?? {}).filter(([, raw]) => {
      const property = resolveSchema(document, raw)
      if (mode === "request" && property.readOnly) return false
      if (mode === "response" && property.writeOnly) return false
      return true
    })
    const fields: Record<string, fc.Arbitrary<unknown>> = {}
    const requiredKeys: string[] = []
    for (const [name, raw] of properties) {
      const property = resolveSchema(document, raw)
      const propertyPath = [...path, "properties", name]
      const override = options.override?.(property, propertyPath)
      if (override === "omit") continue
      const arbitrary = build(raw, propertyPath, depth + 1)
      if (required.has(name) || override !== undefined) {
        fields[name] = arbitrary
        requiredKeys.push(name)
      } else if (depth < maxDepth) {
        fields[name] = fc.option(arbitrary, {
          nil: undefined,
          freq: Math.max(1, Math.round(1 / Math.max(optionalProbability, 0.01))),
        })
      }
    }
    const declared = fc.record(fields).map((record) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
      return out
    })
    const additional = node.additionalProperties
    if (additional === undefined || additional === false || depth >= maxDepth) return declared
    const valueSchema: SchemaObject = additional === true ? {} : additional
    const nameSchema = node.propertyNames ? resolveSchema(document, node.propertyNames) : undefined
    const keyArbitrary = nameSchema
      ? stringArbitrary({ ...nameSchema, type: "string" }).filter(
          (k) => validateValue(document, nameSchema, k).length === 0,
        )
      : fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/)
    const knownKeys = new Set(properties.map(([name]) => name))
    const minKeys = Math.max(0, (node.minProperties ?? 0) - requiredKeys.length)
    const maxKeys = Math.max(
      minKeys,
      Math.min(node.maxProperties ?? DEFAULT_MAX_PROPERTIES, DEFAULT_MAX_PROPERTIES),
    )
    const extra = fc.dictionary(
      keyArbitrary.filter((k) => !knownKeys.has(k)),
      build(valueSchema, [...path, "additionalProperties"], depth + 1),
      { minKeys, maxKeys },
    )
    return fc.tuple(declared, extra).map(([base, more]) => ({ ...more, ...base }))
  }

  return build(schema, [], 0)
}
