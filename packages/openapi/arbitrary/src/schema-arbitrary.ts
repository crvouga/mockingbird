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

/** `fc.option` takes the frequency of the *nil* value: present with probability `p` ⇒ nil once in `1/(1-p)`. */
const nilFrequency = (presentProbability: number) =>
  Math.max(1, Math.round(1 / Math.max(1 - presentProbability, 0.01)))

/** Weighted mix of a schema's exact boundaries and values just inside them. */
const boundaryIntegers = (min: number, max: number) =>
  uniq(
    [min, min + 1, max - 1, max, 0, 1, -1].filter(
      (n) => n >= min && n <= max && Number.isSafeInteger(n),
    ),
  )

/**
 * Smallest positive integer that is a multiple of `multipleOf` (2.5 → 5, 0.1 → 1), or
 * `undefined` when there is none in a sane range, leaving 0 as the only integer multiple.
 */
const integerStep = (multipleOf: number): number | undefined => {
  for (let q = 1; q <= 1_000_000; q++) {
    const step = Math.round(multipleOf * q)
    if (step > 0 && Math.abs(multipleOf * q - step) <= 1e-9 * step) return step
  }
  return undefined
}

const integerArbitrary = (schema: SchemaObject): fc.Arbitrary<number> => {
  // Every declared bound applies; the tightest one wins.
  const lower = [
    schema.minimum === undefined ? undefined : Math.ceil(schema.minimum),
    schema.exclusiveMinimum === undefined ? undefined : Math.floor(schema.exclusiveMinimum) + 1,
  ].filter((n): n is number => n !== undefined)
  const upper = [
    schema.maximum === undefined ? undefined : Math.floor(schema.maximum),
    schema.exclusiveMaximum === undefined ? undefined : Math.ceil(schema.exclusiveMaximum) - 1,
  ].filter((n): n is number => n !== undefined)
  const min = Math.max(
    lower.length > 0 ? Math.max(...lower) : -DEFAULT_INTEGER_BOUND,
    -SAFE_INTEGER_BOUND,
  )
  const max = Math.min(
    upper.length > 0 ? Math.min(...upper) : DEFAULT_INTEGER_BOUND,
    SAFE_INTEGER_BOUND,
  )
  const unsatisfiable = () =>
    new Error(`unsatisfiable schema: no integer satisfies ${JSON.stringify(schema)}`)
  const multiple = schema.multipleOf
  // Generate the multiplier k and emit k * step, so every value is a multiple by construction.
  const step = multiple !== undefined && multiple > 0 ? integerStep(multiple) : 1
  if (step === undefined) {
    if (min <= 0 && max >= 0) return fc.constant(0)
    throw unsatisfiable()
  }
  // `|| 0` turns `Math.ceil(-0.4)`'s -0 into 0 so it never leaks out as a boundary value.
  const low = Math.ceil(min / step) || 0
  const high = Math.floor(max / step) || 0
  if (low > high) throw unsatisfiable()
  const random = fc.integer({ min: low, max: high })
  const boundaries = boundaryIntegers(low, high)
  const base =
    boundaries.length > 0
      ? fc.oneof(
          { arbitrary: random, weight: 3 },
          { arbitrary: fc.constantFrom(...boundaries), weight: 2 },
        )
      : random
  return step === 1 ? base : base.map((k) => k * step)
}

/** Strip float noise (`3 * 0.1` → `0.3`) so generated decimals look like the ones people write. */
const tidy = (n: number, digits: number) =>
  Number.isInteger(n) ? n : Number(n.toPrecision(digits))

const numberArbitrary = (schema: SchemaObject): fc.Arbitrary<number> => {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema
  // Both keywords apply when both are present; the tighter one wins.
  const minExcluded =
    exclusiveMinimum !== undefined && (minimum === undefined || exclusiveMinimum >= minimum)
  const maxExcluded =
    exclusiveMaximum !== undefined && (maximum === undefined || exclusiveMaximum <= maximum)
  const min = minExcluded ? (exclusiveMinimum as number) : (minimum ?? -DEFAULT_INTEGER_BOUND)
  const max = maxExcluded ? (exclusiveMaximum as number) : (maximum ?? DEFAULT_INTEGER_BOUND)
  const hasMin = minimum !== undefined || exclusiveMinimum !== undefined
  const hasMax = maximum !== undefined || exclusiveMaximum !== undefined
  /** Against the declared bounds only; the default ±1e6 range is a generation choice. */
  const inRange = (n: number) =>
    (!hasMin || (minExcluded ? n > min : n >= min)) &&
    (!hasMax || (maxExcluded ? n < max : n <= max))
  const unsatisfiable = () =>
    new Error(`unsatisfiable schema: no number satisfies ${JSON.stringify(schema)}`)
  if (multipleOf !== undefined && multipleOf > 0) {
    // Generate the multiplier k, never the value: values are k * multipleOf by construction.
    // An undeclared bound limits k rather than the value, so `value / multipleOf` stays precise.
    const lowK = hasMin ? Math.ceil(min / multipleOf) : undefined
    const highK = hasMax ? Math.floor(max / multipleOf) : undefined
    let low = Math.max(
      lowK ?? (highK ?? DEFAULT_INTEGER_BOUND) - 2 * DEFAULT_INTEGER_BOUND,
      -SAFE_INTEGER_BOUND,
    )
    let high = Math.min(
      highK ?? (lowK ?? -DEFAULT_INTEGER_BOUND) + 2 * DEFAULT_INTEGER_BOUND,
      SAFE_INTEGER_BOUND,
    )
    const at = (k: number) => {
      const exact = k * multipleOf
      const tidied = tidy(exact, 15)
      // Prefer the tidy decimal unless float division would no longer read it as a multiple.
      return Math.abs(tidied / multipleOf - k) <= 1e-9 ? tidied : exact
    }
    while (low <= high && !inRange(at(low))) low++
    while (high >= low && !inRange(at(high))) high--
    if (low > high) throw unsatisfiable()
    return fc
      .oneof(
        { arbitrary: fc.integer({ min: low, max: high }), weight: 3 },
        {
          arbitrary: fc.constantFrom(...uniq([low, high, Math.min(Math.max(0, low), high)])),
          weight: 1,
        },
      )
      .map(at)
  }
  if (min > max || (min === max && (minExcluded || maxExcluded))) throw unsatisfiable()
  const doubles = fc.double({
    min,
    max,
    minExcluded,
    maxExcluded,
    noNaN: true,
    noDefaultInfinity: true,
  })
  const edges = uniq(
    [minimum, maximum, 0].filter((n): n is number => n !== undefined && inRange(n)),
  )
  const arbitrary =
    edges.length > 0
      ? fc.oneof(
          { arbitrary: doubles, weight: 3 },
          { arbitrary: fc.constantFrom(...edges), weight: 1 },
        )
      : doubles
  // Rounding can land on an exclusive bound (0.1000000000001 → 0.1); keep the raw double then.
  return arbitrary.map((n) => {
    const rounded = tidy(n, 12)
    return inRange(rounded) ? rounded : n
  })
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

/** Bounds that every allOf branch imposes at once: the tightest one wins. */
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"]
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"]

const mergeAllOf = (document: OpenAPIDocument, branches: SchemaObject[]): SchemaObject => {
  const merged: SchemaObject = {}
  const into = merged as Record<string, unknown>
  const mergeBranch = (branch: SchemaObject) => {
    for (const [key, value] of Object.entries(branch)) {
      if (key === "properties") {
        const properties = { ...(merged.properties ?? {}) }
        for (const [name, property] of Object.entries(branch.properties ?? {})) {
          const existing = properties[name]
          // Both declarations constrain the value; `build` merges this allOf when it gets there.
          properties[name] = existing ? { allOf: [existing, property] } : property
        }
        merged.properties = properties
      } else if (key === "required")
        merged.required = uniq([...(merged.required ?? []), ...(branch.required ?? [])])
      else if (key === "allOf") mergeBranch(mergeAllOf(document, branch.allOf ?? []))
      else if (typeof value === "number" && typeof into[key] === "number") {
        const current = into[key] as number
        if (LOWER_BOUNDS.includes(key)) into[key] = Math.max(current, value)
        else if (UPPER_BOUNDS.includes(key)) into[key] = Math.min(current, value)
        else into[key] = value
      } else into[key] = value
    }
  }
  for (const raw of branches) mergeBranch(resolveSchema(document, raw))
  return merged
}

/** Key under which structurally equal JSON values collide: object keys sorted, -0 read as 0. */
const structuralKey = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ) ?? "undefined"

/** How many draws a `oneOf` gets to land in exactly one branch before it settles for the last. */
const ONE_OF_ATTEMPTS = 32

/**
 * `filter` with a retry budget: a plain `.filter` retries forever, so `oneOf` branches that
 * overlap completely would hang generation. After `attempts` misses the last draw is returned.
 */
class RetryUntil<T> extends fc.Arbitrary<T> {
  constructor(
    private readonly arbitrary: fc.Arbitrary<T>,
    private readonly accept: (value: T) => boolean,
    private readonly attempts: number,
  ) {
    super()
  }
  generate(mrng: fc.Random, biasFactor: number | undefined): fc.Value<T> {
    let drawn = this.arbitrary.generate(mrng, biasFactor)
    for (let i = 1; i < this.attempts && !this.accept(drawn.value); i++)
      drawn = this.arbitrary.generate(mrng, biasFactor)
    return drawn
  }
  canShrinkWithoutContext(value: unknown): value is T {
    return this.arbitrary.canShrinkWithoutContext(value)
  }
  shrink(value: T, context: unknown): fc.Stream<fc.Value<T>> {
    return this.arbitrary.shrink(value, context).filter((shrunk) => this.accept(shrunk.value))
  }
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
      // Sibling keywords (`properties`, `required`, …) constrain every branch: fold them in.
      const {
        [keyword]: _union,
        default: _default,
        example: _example,
        examples: _examples,
        ...siblings
      } = resolved
      const hasSiblings = Object.keys(siblings).length > 0
      const branches = fc.oneof(
        ...union.map((branch, i) =>
          build(
            hasSiblings ? mergeAllOf(document, [siblings, branch]) : branch,
            [...path, keyword, String(i)],
            depth + 1,
          ),
        ),
      )
      if (keyword === "anyOf") return branches
      const exactlyOne = (value: unknown) =>
        union.filter((branch) => validateValue(document, branch, value).length === 0).length === 1
      return new RetryUntil(branches, exactlyOne, ONE_OF_ATTEMPTS)
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
    // JSON Schema compares items structurally, so two equal objects are duplicates.
    const unique = { selector: structuralKey, comparator: "SameValueZero" } as const
    // fast-check's uniqueArray never returns when minLength exceeds the distinct items available
    // (unique booleans, length 3), so the boundary aims for `length` but settles for `min`.
    const sized = (length: number) =>
      node.uniqueItems
        ? fc.uniqueArray(items, { minLength: min, maxLength: length, ...unique })
        : fc.array(items, { minLength: length, maxLength: length })
    return fc.oneof(
      {
        arbitrary: node.uniqueItems
          ? fc.uniqueArray(items, { minLength: min, maxLength: max, ...unique })
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
    const optional: Record<string, fc.Arbitrary<unknown>> = {}
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
        optional[name] = arbitrary
      }
    }
    const { minProperties, maxProperties } = node
    const unsatisfiable = () =>
      new Error(`unsatisfiable schema: no object satisfies ${JSON.stringify(node)}`)
    if (maxProperties !== undefined && requiredKeys.length > maxProperties) throw unsatisfiable()
    const optionalKeys = Object.keys(optional)
    const omitAbsent = (record: Record<string, unknown>) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
      return out
    }
    // Property counts bound how many optional keys appear, so pick that subset explicitly.
    const counted = minProperties !== undefined || maxProperties !== undefined
    const maxOptional = Math.min(
      optionalKeys.length,
      (maxProperties ?? Number.POSITIVE_INFINITY) - requiredKeys.length,
    )
    const declared = counted
      ? fc
          .subarray(optionalKeys, {
            minLength: Math.min(
              maxOptional,
              Math.max(0, (minProperties ?? 0) - requiredKeys.length),
            ),
            maxLength: maxOptional,
          })
          .chain((keys) =>
            fc.record({
              ...fields,
              ...Object.fromEntries(keys.map((k) => [k, optional[k] as fc.Arbitrary<unknown>])),
            }),
          )
          .map(omitAbsent)
      : fc
          .record({
            ...fields,
            ...Object.fromEntries(
              Object.entries(optional).map(([k, arbitrary]) => [
                k,
                fc.option(arbitrary, {
                  nil: undefined,
                  freq: nilFrequency(optionalProbability),
                }),
              ]),
            ),
          })
          .map(omitAbsent)
    const additional = node.additionalProperties
    // Undeclared keys are allowed unless `additionalProperties: false`; use them only when the
    // schema asks for them or the declared keys alone cannot reach minProperties.
    const needsExtra = (minProperties ?? 0) > requiredKeys.length + maxOptional
    if (needsExtra && additional === false) throw unsatisfiable()
    if (!needsExtra && (additional === undefined || additional === false || depth >= maxDepth))
      return declared
    const valueSchema: SchemaObject = typeof additional === "object" ? additional : {}
    const nameSchema = node.propertyNames ? resolveSchema(document, node.propertyNames) : undefined
    const keyArbitrary = nameSchema
      ? stringArbitrary({ ...nameSchema, type: "string" }).filter(
          (k) => validateValue(document, nameSchema, k).length === 0,
        )
      : fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/)
    const knownKeys = new Set(properties.map(([name]) => name))
    const extraValue = build(valueSchema, [...path, "additionalProperties"], depth + 1)
    return declared.chain((base) => {
      const present = Object.keys(base).length
      const minKeys = Math.max(0, (minProperties ?? 0) - present)
      const maxKeys = Math.max(
        minKeys,
        Math.min((maxProperties ?? DEFAULT_MAX_PROPERTIES) - present, DEFAULT_MAX_PROPERTIES),
      )
      return fc
        .dictionary(
          keyArbitrary.filter((k) => !knownKeys.has(k)),
          extraValue,
          { minKeys, maxKeys },
        )
        .map((more) => ({ ...more, ...base }))
    })
  }

  return build(schema, [], 0)
}
