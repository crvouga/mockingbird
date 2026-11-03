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

const expectAllValid = (s: SchemaObject, numRuns = 300) => {
  for (const value of fc.sample(schemaArbitrary(s, { document }), {
    numRuns,
    seed: params.seed ?? 1,
  }))
    expect(validateValue(document, s, value)).toEqual([])
}

test("oneOf/anyOf keep the sibling properties and required keys", () => {
  for (const keyword of ["oneOf", "anyOf"] as const)
    expectAllValid({
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", minLength: 1 } },
      [keyword]: [
        {
          type: "object",
          required: ["kind", "a"],
          properties: { kind: { const: "a" }, a: { type: "string" } },
        },
        {
          type: "object",
          required: ["kind", "b"],
          properties: { kind: { const: "b" }, b: { type: "integer" } },
        },
      ],
    })
})

test("overlapping oneOf branches yield values matching exactly one branch", () => {
  expectAllValid({ oneOf: [{ type: "string" }, { type: "string", maxLength: 3 }] })
})

test("fully overlapping oneOf branches still terminate", () => {
  const s: SchemaObject = { oneOf: [{ type: "boolean" }, { type: "boolean" }] }
  expect(fc.sample(schemaArbitrary(s, { document }), 20)).toHaveLength(20)
})

/** Integer ranges as oneOf branches; most of each range is outside every other range. */
const range = fc
  .tuple(fc.integer({ min: -60, max: 60 }), fc.integer({ min: 0, max: 40 }))
  .map(([min, width]): SchemaObject => ({ type: "integer", minimum: min, maximum: min + width }))
const exclusiveShare = (branches: SchemaObject[]) => {
  let exclusive = 0
  let total = 0
  for (const branch of branches)
    for (let n = branch.minimum as number; n <= (branch.maximum as number); n++) {
      total++
      if (branches.filter((b) => validateValue(document, b, n).length === 0).length === 1)
        exclusive++
    }
  return exclusive / total
}

test("generated values match exactly one of overlapping oneOf ranges", () => {
  fc.assert(
    fc.property(
      fc
        .array(range, { minLength: 2, maxLength: 3 })
        .filter((branches) => exclusiveShare(branches) >= 0.7)
        .map((branches): SchemaObject => ({ oneOf: branches }))
        .chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 300 },
  )
})
