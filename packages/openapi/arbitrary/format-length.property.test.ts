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

/** Shortest value each format can take: below it a length bound is unsatisfiable. */
const SHORTEST = { email: 6, uri: 5, url: 5, ipv4: 7, ipv6: 2 } as const

const lengthBoundSchema = fc
  .constantFrom(...(Object.keys(SHORTEST) as Array<keyof typeof SHORTEST>))
  .chain((format) =>
    fc
      .tuple(fc.integer({ min: SHORTEST[format], max: 40 }), fc.nat(10), fc.boolean())
      .map(([maxLength, below, withMin]): SchemaObject => {
        const s: SchemaObject = { type: "string", format, maxLength }
        // IP addresses top out at 15 (v4) and 39 (v6) characters; keep minLength reachable.
        const longest = format === "ipv4" ? 15 : format === "ipv6" ? 39 : maxLength
        const ceiling = Math.min(maxLength, longest)
        if (withMin) s.minLength = Math.max(0, ceiling - below)
        return s
      }),
  )

test("formatted strings fit small length bounds", () => {
  fc.assert(
    fc.property(
      lengthBoundSchema.chain((s) => fc.tuple(fc.constant(s), schemaArbitrary(s, { document }))),
      ([s, value]) => {
        expect(validateValue(document, s, value)).toEqual([])
      },
    ),
    { ...params, numRuns: params.numRuns ?? 300 },
  )
})

test("an email bound to 6 characters is generated directly, not by rejection", () => {
  const s: SchemaObject = { type: "string", format: "email", maxLength: 6 }
  const started = performance.now()
  const values = fc.sample(schemaArbitrary(s, { document }), { numRuns: 500, seed: 1 })
  expect(performance.now() - started).toBeLessThan(500)
  for (const value of values) expect(validateValue(document, s, value)).toEqual([])
})

test("date-time drops its milliseconds to fit maxLength 20", () => {
  const s: SchemaObject = { type: "string", format: "date-time", maxLength: 20 }
  for (const value of fc.sample(schemaArbitrary(s, { document }), { numRuns: 100, seed: 1 }))
    expect(validateValue(document, s, value)).toEqual([])
})

test("a length bound no value of the format can meet is reported", () => {
  for (const s of [
    { type: "string", format: "uuid", maxLength: 10 },
    { type: "string", format: "date", minLength: 11 },
    { type: "string", format: "email", maxLength: 4 },
    { type: "string", format: "ipv4", minLength: 16 },
  ] satisfies SchemaObject[])
    expect(() => schemaArbitrary(s, { document })).toThrow(/unsatisfiable/)
})
