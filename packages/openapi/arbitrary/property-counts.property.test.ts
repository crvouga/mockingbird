import { expect, test } from "bun:test"
import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { validateValue } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { schemaArbitrary } from "./src/index.js"

const params = fcParameters(process.env)
const document: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
}

/** Objects mixing required/optional keys, open/closed additionalProperties and property counts. */
const objectSchema = fc
  .record({
    names: fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 5 }),
    requiredCount: fc.nat(5),
    additional: fc.constantFrom<SchemaObject["additionalProperties"]>(undefined, false, true, {
      type: "integer",
    }),
    minProperties: fc.option(fc.nat(6), { nil: undefined }),
    maxProperties: fc.option(fc.nat(6), { nil: undefined }),
  })
  .map(({ names, requiredCount, additional, minProperties, maxProperties }): SchemaObject => {
    const s: SchemaObject = {
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, { type: "string", maxLength: 2 }])),
      required: names.slice(0, Math.min(requiredCount, names.length)),
    }
    if (additional !== undefined) s.additionalProperties = additional
    if (minProperties !== undefined) s.minProperties = minProperties
    if (maxProperties !== undefined) s.maxProperties = maxProperties
    return s
  })
  .filter((s) => {
    const required = s.required?.length ?? 0
    const declared = Object.keys(s.properties ?? {}).length
    const reachable = s.additionalProperties === false ? declared : Infinity
    const lo = Math.max(s.minProperties ?? 0, required)
    return lo <= Math.min(s.maxProperties ?? Infinity, reachable)
  })

test("generated objects respect minProperties and maxProperties", () => {
  fc.assert(
    fc.property(
      objectSchema.chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 500 },
  )
})

test("minProperties without additionalProperties is met", () => {
  const s: SchemaObject = {
    type: "object",
    minProperties: 1,
    properties: { a: { type: "string" }, b: { type: "string" } },
  }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 200, seed: 1 }))
    expect(Object.keys(value as object).length).toBeGreaterThanOrEqual(1)
})

test("maxProperties counts optional declared keys", () => {
  const s: SchemaObject = {
    type: "object",
    maxProperties: 1,
    properties: { a: { type: "string" }, b: { type: "string" } },
  }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 200, seed: 1 }))
    expect(Object.keys(value as object).length).toBeLessThanOrEqual(1)
})

test("an object that cannot reach its property counts is reported", () => {
  for (const s of [
    { type: "object", maxProperties: 1, required: ["a", "b"], properties: { a: {}, b: {} } },
    { type: "object", minProperties: 3, properties: { a: {} }, additionalProperties: false },
  ] satisfies SchemaObject[])
    expect(() => schemaArbitrary(s, { document })).toThrow(/unsatisfiable/)
})
