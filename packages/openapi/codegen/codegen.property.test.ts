import { describe, expect, test } from "bun:test"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { stringify } from "yaml"
import { generate, loadSpec, renderModule, SpecValidationError } from "./src/index.js"

const params = fcParameters(process.env)

const identifier = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/)

const documentArb: fc.Arbitrary<OpenAPIDocument> = fc
  .uniqueArray(
    fc.record({
      id: fc.stringMatching(/^[A-Z][a-zA-Z]{1,10}$/),
      path: identifier.map((s) => `/v1/${s}`),
      method: fc.constantFrom("get", "post", "delete"),
      supported: fc.boolean(),
      description: fc.string({ maxLength: 20 }).filter((s) => !s.includes("`")),
    }),
    { minLength: 1, maxLength: 6, selector: (r) => `${r.method} ${r.path}` },
  )
  .filter((rows) => new Set(rows.map((r) => r.id)).size === rows.length)
  .map((rows) => {
    const paths: OpenAPIDocument["paths"] = {}
    for (const row of rows) {
      const item = paths[row.path] ?? {}
      paths[row.path] = item
      item[row.method as "get" | "post" | "delete"] = {
        operationId: row.id,
        responses: { "200": { description: row.description } },
        ...(row.supported
          ? {}
          : { "x-mockingbird": { supported: false, reason: "not implemented" } }),
      }
    }
    return { openapi: "3.1.0", info: { title: "gen", version: "1" }, paths }
  })

describe("codegen", () => {
  test("generated module embeds an identical document and exact operation id unions", async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, async (document) => {
        const yamlText = stringify(document)
        const files = generate(yamlText)
        const path = `${import.meta.dir}/node_modules/.codegen-test/${Math.abs(hash(files.module))}.ts`
        await Bun.write(path, files.module)
        const generated = (await import(path)) as {
          document: OpenAPIDocument
          operationIds: readonly string[]
          supportedOperationIds: readonly string[]
        }
        expect(generated.document).toEqual(document)
        const operations = listOperations(document)
        expect([...generated.operationIds]).toEqual(operations.map((o) => o.operationId))
        expect(files.module).toContain(
          `export type OperationId = ${operations.map((o) => JSON.stringify(o.operationId)).join(" | ")}`,
        )
        for (const operation of operations) {
          expect(files.support).toContain(`\`${operation.operationId}\``)
          expect(files.support).toContain(`\`${operation.method.toUpperCase()} ${operation.path}\``)
        }
        expect(files.support).toContain(`operations in spec: **${operations.length}**`)
      }),
      { ...params, numRuns: 25 },
    )
  })

  test("renderModule is deterministic and re-parses cleanly", () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        expect(renderModule(document)).toBe(renderModule(structuredClone(document)))
        expect(loadSpec(stringify(document))).toEqual(document)
      }),
      params,
    )
  })

  test("metadata problems surface as SpecValidationError", () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const broken = structuredClone(document)
        const [path] = Object.keys(broken.paths)
        if (!path) return
        const item = broken.paths[path]
        if (!item) return
        const operation = item.get ?? item.post ?? item.delete
        if (!operation) return
        operation["x-mockingbird"] = { supported: false }
        expect(() => loadSpec(stringify(broken))).toThrow(SpecValidationError)
      }),
      params,
    )
  })
})

const hash = (text: string) => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return h
}
