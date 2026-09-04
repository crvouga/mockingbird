import { expect, test } from "bun:test"
import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { validateValue } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { invalidSchemaArbitrary, mutationSites, schemaArbitrary } from "./src/index.js"

const params = fcParameters(process.env)

const document: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: {
    schemas: {
      id: { type: "string", format: "uuid" },
      money: { type: "integer", minimum: 0, maximum: 99_999_999 },
    },
  },
}

const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/)

const stringSchema = fc
  .tuple(
    fc.option(fc.nat(6), { nil: undefined }),
    fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
    fc.option(fc.constantFrom("uuid", "date", "date-time", "email"), { nil: undefined }),
  )
  .map(([min, max, format]): SchemaObject => {
    const schema: SchemaObject = { type: "string" }
    if (format !== undefined) {
      schema.format = format
      return schema
    }
    if (min !== undefined) schema.minLength = min
    if (max !== undefined) schema.maxLength = Math.max(max, min ?? 0)
    return schema
  })

const integerSchema = fc
  .tuple(
    fc.option(fc.integer({ min: -100, max: 100 }), { nil: undefined }),
    fc.option(fc.integer({ min: -100, max: 100 }), { nil: undefined }),
  )
  .map(([a, b]): SchemaObject => {
    const schema: SchemaObject = { type: "integer" }
    if (a !== undefined) schema.minimum = Math.min(a, b ?? a)
    if (b !== undefined) schema.maximum = Math.max(b, a ?? b)
    return schema
  })

const enumSchema = fc
  .uniqueArray(fc.string({ maxLength: 5 }), { minLength: 1, maxLength: 4 })
  .map((values): SchemaObject => ({ type: "string", enum: values }))

const schema: fc.Arbitrary<SchemaObject> = fc.letrec<{ schema: SchemaObject }>((tie) => ({
  schema: fc.oneof(
    { arbitrary: stringSchema, weight: 3 },
    { arbitrary: integerSchema, weight: 3 },
    { arbitrary: enumSchema, weight: 1 },
    { arbitrary: fc.constant<SchemaObject>({ type: "boolean" }), weight: 1 },
    { arbitrary: fc.constant<SchemaObject>({ $ref: "#/components/schemas/id" }), weight: 1 },
    { arbitrary: fc.constant<SchemaObject>({ $ref: "#/components/schemas/money" }), weight: 1 },
    { arbitrary: fc.constant<SchemaObject>({ type: ["string", "null"], maxLength: 3 }), weight: 1 },
    {
      arbitrary: fc
        .tuple(
          tie("schema"),
          fc.nat(2),
          fc.option(fc.integer({ min: 2, max: 4 }), { nil: undefined }),
        )
        .map(
          ([items, min, max]): SchemaObject => ({
            type: "array",
            items,
            minItems: min,
            ...(max === undefined ? {} : { maxItems: Math.max(max, min) }),
          }),
        ),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(
          fc.dictionary(name, tie("schema"), { minKeys: 1, maxKeys: 4 }),
          fc.boolean(),
          fc.boolean(),
        )
        .map(
          ([properties, closed, allRequired]): SchemaObject => ({
            type: "object",
            properties,
            required: allRequired ? Object.keys(properties) : Object.keys(properties).slice(0, 1),
            ...(closed
              ? { additionalProperties: false }
              : { additionalProperties: { type: "string", maxLength: 4 } }),
          }),
        ),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(tie("schema"), tie("schema"))
        .map(([a, b]): SchemaObject => ({ anyOf: [a, b] })),
      weight: 1,
    },
  ),
})).schema

test("every generated value validates against its schema", () => {
  fc.assert(
    fc.property(
      schema.chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 300 },
  )
})

test("every invalid value fails validation with the declared violation", () => {
  fc.assert(
    fc.property(
      schema
        .filter((s) => mutationSites(document, s).length > 0)
        .chain((s) => fc.tuple(fc.constant(s), invalidSchemaArbitrary(s, { document }))),
      ([s, invalid]) => {
        expect(validateValue(document, s, invalid.value).length).toBeGreaterThan(0)
        expect(invalid.mutation.violation).toBeTruthy()
      },
    ),
    { ...params, numRuns: params.numRuns ?? 200 },
  )
})

test("boundaries are exercised: bounded strings hit both min and max lengths", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 6, max: 12 }), (min, max) => {
      const s: SchemaObject = { type: "string", minLength: min, maxLength: max }
      const samples = fc.sample(schemaArbitrary(s, { document }), {
        numRuns: 200,
        seed: params.seed ?? 1,
      })
      const lengths = new Set(samples.map((v) => [...(v as string)].length))
      expect(lengths.has(min)).toBe(true)
      expect(lengths.has(max)).toBe(true)
    }),
    { ...params, numRuns: 10 },
  )
})

test("override hook replaces generation at the addressed path", () => {
  fc.assert(
    fc.property(fc.string(), (marker) => {
      const s: SchemaObject = {
        type: "object",
        required: ["a"],
        properties: { a: { type: "string" }, b: { type: "integer" } },
      }
      const arbitrary = schemaArbitrary(s, {
        document,
        override: (_node, path) =>
          path.join("/") === "properties/a"
            ? fc.constant(marker)
            : path.join("/") === "properties/b"
              ? "omit"
              : undefined,
      })
      for (const value of fc.sample(arbitrary, 20)) {
        expect((value as Record<string, unknown>).a).toBe(marker)
        expect("b" in (value as object)).toBe(false)
      }
    }),
    { ...params, numRuns: 20 },
  )
})
