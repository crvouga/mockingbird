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

const bound = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })

/** `type: number` schemas mixing inclusive/exclusive bounds and decimal `multipleOf`s. */
const numberSchema = fc
  .record(
    {
      minimum: bound,
      maximum: bound,
      exclusiveMinimum: bound,
      exclusiveMaximum: bound,
      multipleOf: fc.constantFrom(0.01, 0.1, 0.25, 0.5, 1, 2.5, 7),
    },
    { requiredKeys: [] },
  )
  .map((s): SchemaObject => ({ type: "number", ...s }))
  .filter((s) => {
    const lo = Math.max(s.minimum ?? -Infinity, s.exclusiveMinimum ?? -Infinity)
    const hi = Math.min(s.maximum ?? Infinity, s.exclusiveMaximum ?? Infinity)
    return hi - lo > (s.multipleOf ?? 0) * 2 + 1e-6
  })

test("generated numbers satisfy bounds and multipleOf", () => {
  fc.assert(
    fc.property(
      numberSchema.chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 500 },
  )
})

test("rounding never lands on an exclusive bound", () => {
  for (const s of [
    { type: "number", exclusiveMinimum: 0.1 },
    { type: "number", exclusiveMinimum: 0.1, maximum: 0.1000000000001 },
    { type: "number", minimum: -0.2000000000001, exclusiveMaximum: -0.2 },
  ] satisfies SchemaObject[]) {
    for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 300, seed: 1 }))
      expect(validateValue(document, s, value)).toEqual([])
  }
})

test("decimal multipleOf yields exact-looking multiples", () => {
  const s: SchemaObject = { type: "number", minimum: 0, maximum: 10, multipleOf: 0.01 }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 300, seed: 1 }))
    expect(String(value)).toMatch(/^\d+(\.\d{1,2})?$/)
})

test("a number range holding no multiple is reported, not silently violated", () => {
  const s: SchemaObject = { type: "number", minimum: 0.1, maximum: 0.2, multipleOf: 0.5 }
  expect(() => schemaArbitrary(s, { document })).toThrow(/unsatisfiable/)
})
