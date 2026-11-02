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

const bound = fc.integer({ min: -200, max: 200 })

/** Ranges with at least one integer multiple of `multipleOf` after every bound is applied. */
const integerSchema = fc
  .record(
    {
      minimum: bound,
      maximum: bound,
      exclusiveMinimum: bound,
      exclusiveMaximum: bound,
      multipleOf: fc.constantFrom(1, 2, 3, 7, 0.5, 2.5, 0.25, 1.5),
    },
    { requiredKeys: [] },
  )
  .map((s): SchemaObject => ({ type: "integer", ...s }))
  .filter((s) => {
    const lo = Math.max(s.minimum ?? -1e6, (s.exclusiveMinimum ?? -1e6 - 1) + 1)
    const hi = Math.min(s.maximum ?? 1e6, (s.exclusiveMaximum ?? 1e6 + 1) - 1)
    for (let n = lo; n <= Math.min(hi, lo + 20); n++)
      if (validateValue(document, s, n).length === 0) return true
    return false
  })

test("generated integers satisfy every bound and multipleOf", () => {
  fc.assert(
    fc.property(
      integerSchema.chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 500 },
  )
})

test("exclusive bounds still apply next to inclusive ones", () => {
  const s: SchemaObject = { type: "integer", minimum: 0, exclusiveMinimum: 0, maximum: 3 }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 300, seed: 1 }))
    expect(value).toBeGreaterThan(0)
})

test("a non-integer multipleOf yields integers that are multiples of it", () => {
  const s: SchemaObject = { type: "integer", multipleOf: 2.5 }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 300, seed: 1 }))
    expect(Math.abs(value as number) % 5).toBe(0)
})

test("unsatisfiable integer ranges throw instead of hanging or emitting invalid values", () => {
  for (const s of [
    { type: "integer", minimum: 1, maximum: 4, multipleOf: 5 },
    { type: "integer", minimum: 5, maximum: 1 },
    { type: "integer", exclusiveMinimum: 1, exclusiveMaximum: 2 },
  ] satisfies SchemaObject[]) {
    expect(() => schemaArbitrary(s, { document })).toThrow(/unsatisfiable/)
  }
})
