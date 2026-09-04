import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { resolveSchema, schemaTypes, validateValue } from "@crvouga/mockingbird-openapi"
import fc from "fast-check"
import {
  type SchemaArbitraryOptions,
  type SchemaPath,
  schemaArbitrary,
} from "./schema-arbitrary.js"

export type Violation =
  | "wrong-type"
  | "string-too-long"
  | "string-too-short"
  | "number-too-large"
  | "number-too-small"
  | "not-in-enum"
  | "missing-required"
  | "unexpected-property"
  | "array-too-long"
  | "array-too-short"
  | "bad-format"

export type Mutation = {
  /** Location of the mutated value in generated *values* (not schema keywords). */
  valuePath: Array<string | number>
  violation: Violation
  detail: string
}

export type InvalidValue = { value: unknown; mutation: Mutation }

type Site = Mutation & { schema: SchemaObject }

const FORMATS_WITH_SYNTAX = new Set(["uuid", "date", "date-time", "email", "uri", "ipv4"])

/** Enumerate every way a value for `schema` could break one constraint. */
export const mutationSites = (
  document: OpenAPIDocument,
  schema: SchemaObject,
  options: {
    mode?: "request" | "response"
    skip?: (schema: SchemaObject, path: SchemaPath) => boolean
  } = {},
): Site[] => {
  const sites: Site[] = []
  const seen = new Set<SchemaObject>()
  const go = (
    node: SchemaObject,
    schemaPath: SchemaPath,
    valuePath: Array<string | number>,
    depth: number,
  ) => {
    if (depth > 8) return
    const resolved = resolveSchema(document, node)
    if (seen.has(resolved)) return
    seen.add(resolved)
    if (options.skip?.(resolved, schemaPath)) {
      seen.delete(resolved)
      return
    }
    const add = (violation: Violation, detail: string) =>
      sites.push({ schema: resolved, valuePath, violation, detail })
    const types = schemaTypes(resolved)
    if (resolved.enum && resolved.enum.length > 0)
      add("not-in-enum", `enum ${JSON.stringify(resolved.enum)}`)
    if (
      types.length > 0 &&
      !(types.includes("string") && resolved.enum === undefined && types.length > 1)
    )
      add("wrong-type", `type ${types.join("|")}`)
    if (types.includes("string")) {
      if (resolved.maxLength !== undefined)
        add("string-too-long", `maxLength ${resolved.maxLength}`)
      if (resolved.minLength !== undefined && resolved.minLength > 0)
        add("string-too-short", `minLength ${resolved.minLength}`)
      if (resolved.format !== undefined && FORMATS_WITH_SYNTAX.has(resolved.format))
        add("bad-format", `format ${resolved.format}`)
    }
    if (types.includes("integer") || types.includes("number")) {
      if (resolved.maximum !== undefined || resolved.exclusiveMaximum !== undefined)
        add("number-too-large", `maximum ${resolved.maximum ?? resolved.exclusiveMaximum}`)
      if (resolved.minimum !== undefined || resolved.exclusiveMinimum !== undefined)
        add("number-too-small", `minimum ${resolved.minimum ?? resolved.exclusiveMinimum}`)
    }
    if (types.includes("array")) {
      if (resolved.maxItems !== undefined) add("array-too-long", `maxItems ${resolved.maxItems}`)
      if (resolved.minItems !== undefined && resolved.minItems > 0)
        add("array-too-short", `minItems ${resolved.minItems}`)
      if (resolved.items) go(resolved.items, [...schemaPath, "items"], [...valuePath, 0], depth + 1)
    }
    if (types.includes("object") || resolved.properties) {
      for (const name of resolved.required ?? [])
        sites.push({ schema: resolved, valuePath, violation: "missing-required", detail: name })
      if (resolved.additionalProperties === false)
        add("unexpected-property", "additionalProperties: false")
      for (const [name, property] of Object.entries(resolved.properties ?? {})) {
        const p = resolveSchema(document, property)
        if ((options.mode ?? "request") === "request" && p.readOnly) continue
        go(property, [...schemaPath, "properties", name], [...valuePath, name], depth + 1)
      }
    }
    const union = resolved.oneOf ?? resolved.anyOf
    if (union && union.length === 1 && union[0])
      go(union[0], [...schemaPath, resolved.oneOf ? "oneOf" : "anyOf", "0"], valuePath, depth + 1)
    for (const branch of resolved.allOf ?? [])
      go(branch, [...schemaPath, "allOf"], valuePath, depth + 1)
    seen.delete(resolved)
  }
  go(schema, [], [], 0)
  return sites
}

const repeat = (unit: string, length: number) => Array.from({ length }, () => unit).join("")

const wrongTyped = (schema: SchemaObject): fc.Arbitrary<unknown> => {
  const types = new Set(schemaTypes(schema))
  const candidates: fc.Arbitrary<unknown>[] = []
  if (!types.has("string")) candidates.push(fc.string({ minLength: 1 }))
  if (!types.has("integer") && !types.has("number")) candidates.push(fc.integer())
  if (!types.has("boolean")) candidates.push(fc.boolean())
  if (!types.has("array")) candidates.push(fc.constant([]))
  if (!types.has("object")) candidates.push(fc.constant({}))
  return fc.oneof(...candidates)
}

const invalidLeaf = (site: Site): fc.Arbitrary<unknown> => {
  const s = site.schema
  switch (site.violation) {
    case "wrong-type":
      return wrongTyped(s)
    case "string-too-long":
      return fc.constant(repeat("x", (s.maxLength ?? 0) + 1))
    case "string-too-short":
      return fc.constant(repeat("x", Math.max(0, (s.minLength ?? 1) - 1)))
    case "number-too-large": {
      const bound = s.maximum ?? s.exclusiveMaximum ?? 0
      return fc.constant(s.maximum !== undefined ? bound + 1 : bound)
    }
    case "number-too-small": {
      const bound = s.minimum ?? s.exclusiveMinimum ?? 0
      return fc.constant(s.minimum !== undefined ? bound - 1 : bound)
    }
    case "not-in-enum":
      return fc.string({ minLength: 1 }).filter((v) => !(s.enum ?? []).includes(v))
    case "array-too-long":
      return fc.constant(Array.from({ length: (s.maxItems ?? 0) + 1 }, () => null))
    case "array-too-short":
      return fc.constant([])
    case "bad-format":
      return fc.constantFrom("not-a-valid-value", "", "42", "@@")
    default:
      return fc.constant(null)
  }
}

const setAt = (
  root: unknown,
  path: Array<string | number>,
  update: (
    current: unknown,
    parent: Record<string, unknown> | unknown[] | undefined,
    key: string | number | undefined,
  ) => unknown,
): unknown => {
  if (path.length === 0) return update(root, undefined, undefined)
  const clone = (value: unknown): unknown =>
    Array.isArray(value)
      ? [...value]
      : typeof value === "object" && value !== null
        ? { ...(value as object) }
        : value
  const copy = clone(root)
  let cursor: unknown = copy
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number
    if (typeof cursor !== "object" || cursor === null) return undefined
    const container = cursor as Record<string | number, unknown>
    if (!(key in container)) return undefined
    container[key] = clone(container[key])
    cursor = container[key]
  }
  if (typeof cursor !== "object" || cursor === null) return undefined
  const last = path[path.length - 1] as string | number
  const parent = cursor as Record<string, unknown> | unknown[]
  const result = update((parent as Record<string | number, unknown>)[last], parent, last)
  return result === undefined ? undefined : copy
}

/**
 * Generate values that violate exactly one declared constraint of `schema`, alongside a
 * description of the violation. Every produced value is verified invalid via `validateValue`.
 */
export const invalidSchemaArbitrary = (
  schema: SchemaObject,
  options: SchemaArbitraryOptions & { skip?: (schema: SchemaObject, path: SchemaPath) => boolean },
): fc.Arbitrary<InvalidValue> => {
  const sites = mutationSites(options.document, schema, {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
  })
  if (sites.length === 0) {
    return fc
      .constant(undefined)
      .filter((): boolean => false) as unknown as fc.Arbitrary<InvalidValue>
  }
  const valid = schemaArbitrary(schema, { ...options, optionalProbability: 0.9 })
  return fc
    .constantFrom(...sites)
    .chain((site) =>
      fc.tuple(
        fc.constant(site),
        valid,
        site.violation === "unexpected-property" || site.violation === "missing-required"
          ? fc.constant(undefined)
          : invalidLeaf(site),
      ),
    )
    .map(([site, value, replacement]): InvalidValue | undefined => {
      const mutation: Mutation = {
        valuePath: site.valuePath,
        violation: site.violation,
        detail: site.detail,
      }
      let mutated: unknown
      if (site.violation === "missing-required") {
        mutated = setAt(value, site.valuePath, (current) => {
          if (
            typeof current !== "object" ||
            current === null ||
            Array.isArray(current) ||
            !(site.detail in current)
          )
            return undefined
          const { [site.detail]: _removed, ...rest } = current as Record<string, unknown>
          return rest
        })
      } else if (site.violation === "unexpected-property") {
        mutated = setAt(value, site.valuePath, (current) =>
          typeof current === "object" && current !== null && !Array.isArray(current)
            ? { ...current, mockingbird_unexpected: "x" }
            : undefined,
        )
      } else {
        mutated =
          site.valuePath.length === 0
            ? replacement
            : setAt(value, site.valuePath, (_current, parent, key) => {
                if (parent === undefined || key === undefined || !(key in parent)) return undefined
                ;(parent as Record<string | number, unknown>)[key] = replacement
                return parent
              })
      }
      if (mutated === undefined) return undefined
      if (validateValue(options.document, schema, mutated).length === 0) return undefined
      return { value: mutated, mutation }
    })
    .filter((candidate): candidate is InvalidValue => candidate !== undefined)
}
