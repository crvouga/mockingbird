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

/** Item schemas with few distinct values, so structurally equal objects/arrays are likely. */
const itemSchema: fc.Arbitrary<SchemaObject> = fc.constantFrom<SchemaObject>(
  {
    type: "object",
    required: ["a"],
    properties: { a: { type: "boolean" } },
    additionalProperties: false,
  },
  {
    type: "object",
    required: ["a", "b"],
    properties: { a: { type: "boolean" }, b: { enum: [1, 2] } },
    additionalProperties: false,
  },
  { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 },
  { type: "integer", minimum: 0, maximum: 3 },
)

test("uniqueItems arrays never hold two structurally equal items", () => {
  fc.assert(
    fc.property(
      fc
        .tuple(itemSchema, fc.integer({ min: 0, max: 2 }), fc.integer({ min: 2, max: 3 }))
        .map(
          ([items, minItems, maxItems]): SchemaObject => ({
            type: "array",
            uniqueItems: true,
            items,
            minItems,
            maxItems,
          }),
        )
        .chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 500 },
  )
})

test("unique arrays over a small item domain stop at the distinct values instead of hanging", () => {
  const s: SchemaObject = {
    type: "array",
    uniqueItems: true,
    items: { type: "boolean" },
    maxItems: 3,
  }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 200, seed: 1 }))
    expect(validateValue(document, s, value)).toEqual([])
})
