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
  components: {
    schemas: {
      base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
}

const expectAllValid = (s: SchemaObject, numRuns = 300) => {
  for (const value of fc.sample(schemaArbitrary(s, { document }), {
    numRuns,
    seed: params.seed ?? 1,
  }))
    expect(validateValue(document, s, value)).toEqual([])
}

test("nested allOf merges properties and required instead of replacing them", () => {
  expectAllValid({
    allOf: [
      { $ref: "#/components/schemas/base" },
      { allOf: [{ type: "object", required: ["x"], properties: { x: { type: "string" } } }] },
    ],
  })
})

test("a property declared in two branches keeps both branches' constraints", () => {
  expectAllValid({
    type: "object",
    required: ["n"],
    allOf: [
      { properties: { n: { type: "integer", minimum: 5 } } },
      { properties: { n: { type: "integer", maximum: 10 } } },
    ],
  })
})

/** Integer-range fragments split across allOf branches at random nesting depths. */
const fragment = fc.record(
  {
    name: fc.constantFrom("a", "b", "c"),
    required: fc.boolean(),
    minimum: fc.integer({ min: -50, max: 0 }),
    maximum: fc.integer({ min: 0, max: 50 }),
    nested: fc.boolean(),
  },
  { requiredKeys: ["name", "required", "nested"] },
)

test("splitting an object across (nested) allOf branches never loses a constraint", () => {
  fc.assert(
    fc.property(
      fc.array(fragment, { minLength: 1, maxLength: 5 }).chain((fragments) => {
        const branches = fragments.map((f): SchemaObject => {
          const property: SchemaObject = { type: "integer" }
          if (f.minimum !== undefined) property.minimum = f.minimum
          if (f.maximum !== undefined) property.maximum = f.maximum
          const branch: SchemaObject = {
            type: "object",
            properties: { [f.name]: property },
            ...(f.required ? { required: [f.name] } : {}),
          }
          return f.nested ? { allOf: [branch] } : branch
        })
        const s: SchemaObject = { allOf: branches }
        return fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))
      }),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 300 },
  )
})
