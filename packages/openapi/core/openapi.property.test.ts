import { expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  expandPathTemplate,
  HTTP_METHODS,
  listOperations,
  type OpenAPIDocument,
  OpenAPIDocumentError,
  parseOpenAPIDocument,
  pathTemplateParameters,
  resolveSchema,
  responseForStatus,
  type SchemaObject,
  validateValue,
} from "./src/index.js"

const params = fcParameters(process.env)

const identifier = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/)

type Route = {
  path: string
  method: (typeof HTTP_METHODS)[number]
  operationId: string
  params: string[]
}

const route = fc
  .tuple(
    fc.array(fc.tuple(identifier, fc.boolean()), { minLength: 1, maxLength: 4 }),
    fc.constantFrom(...HTTP_METHODS),
    identifier,
  )
  .map(([segments, method, id]) => {
    const seen = new Set<string>()
    const parts: string[] = []
    const paramNames: string[] = []
    for (const [name, isParam] of segments) {
      if (isParam && !seen.has(name)) {
        seen.add(name)
        parts.push(`{${name}}`)
        paramNames.push(name)
      } else parts.push(name)
    }
    return {
      path: `/${parts.join("/")}`,
      method,
      operationId: id,
      params: paramNames,
    } satisfies Route
  })

const routes = fc
  .uniqueArray(route, { selector: (r) => `${r.method} ${r.path}`, minLength: 1, maxLength: 8 })
  .map((rs) => rs.map((r, i) => ({ ...r, operationId: `${r.operationId}_${i}` })))

const documentFor = (rs: Route[]): OpenAPIDocument => {
  const paths: OpenAPIDocument["paths"] = {}
  for (const r of rs) {
    const item = paths[r.path] ?? {}
    paths[r.path] = item
    item[r.method] = {
      operationId: r.operationId,
      parameters: r.params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { $ref: "#/components/schemas/thing" } } },
        },
      },
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths,
    components: { schemas: { thing: { type: "object", properties: { id: { type: "string" } } } } },
  }
}

test("well-formed documents parse and expose every operation exactly once", () => {
  fc.assert(
    fc.property(routes, (rs) => {
      const document = parseOpenAPIDocument(documentFor(rs))
      const operations = listOperations(document)
      expect(operations.map((o) => o.operationId).sort()).toEqual(
        rs.map((r) => r.operationId).sort(),
      )
      for (const operation of operations) {
        expect(operation.parameters.filter((p) => p.in === "path").map((p) => p.name)).toEqual(
          pathTemplateParameters(operation.path),
        )
      }
    }),
    params,
  )
})

test("duplicate operationIds, missing path params and dangling refs are rejected", () => {
  fc.assert(
    fc.property(routes, fc.constantFrom("dup", "param", "ref"), (rs, kind) => {
      const document = documentFor(rs)
      const first = rs[0] as Route
      const op = document.paths[first.path]?.[first.method]
      if (!op) throw new Error("unreachable")
      if (kind === "dup") {
        if (rs.length < 2) return
        const second = rs[1] as Route
        const other = document.paths[second.path]?.[second.method]
        if (!other) throw new Error("unreachable")
        other.operationId = op.operationId ?? "dup"
      } else if (kind === "param") {
        if (first.params.length === 0) return
        op.parameters = []
      } else {
        op.responses["200"] = {
          description: "x",
          content: { "application/json": { schema: { $ref: "#/components/schemas/missing" } } },
        }
      }
      expect(() => parseOpenAPIDocument(document)).toThrow(OpenAPIDocumentError)
    }),
    params,
  )
})

test("expandPathTemplate substitutes every parameter and percent-encodes values", () => {
  fc.assert(
    fc.property(route, fc.string(), (r, value) => {
      const values = Object.fromEntries(r.params.map((name) => [name, value]))
      const expanded = expandPathTemplate(r.path, values)
      expect(expanded.includes("{")).toBe(false)
      for (const _ of r.params) expect(expanded).toContain(encodeURIComponent(value))
    }),
    params,
  )
})

test("resolveSchema merges $ref siblings and normalises nullable", () => {
  const document: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas: { base: { type: "string", maxLength: 5 } } },
  }
  fc.assert(
    fc.property(fc.string({ maxLength: 20 }), fc.boolean(), (description, nullable) => {
      const schema: SchemaObject = {
        $ref: "#/components/schemas/base",
        description,
        ...(nullable ? { nullable: true } : {}),
      }
      const resolved = resolveSchema(document, schema)
      expect(resolved.maxLength).toBe(5)
      expect(resolved.description).toBe(description)
      expect(resolved.type).toEqual(nullable ? ["string", "null"] : "string")
    }),
    params,
  )
})

test("responseForStatus prefers exact, then range, then default", () => {
  fc.assert(
    fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
      const responses = {
        [String(status)]: { description: "exact" },
        [`${Math.floor(status / 100)}XX`]: { description: "range" },
        default: { description: "default" },
      }
      expect(responseForStatus(responses, status)?.description).toBe("exact")
      const { [String(status)]: _, ...withoutExact } = responses
      expect(responseForStatus(withoutExact, status)?.description).toBe("range")
      expect(responseForStatus({ default: { description: "default" } }, status)?.description).toBe(
        "default",
      )
    }),
    params,
  )
})

test("validateValue accepts values produced by their own schema shape and rejects type mismatches", () => {
  const document: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
  }
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 50 }), fc.string({ maxLength: 50 }), (n, s) => {
      const schema: SchemaObject = {
        type: "object",
        required: ["n", "s"],
        properties: {
          n: { type: "integer", minimum: 0, maximum: 50 },
          s: { type: "string", maxLength: 50 },
        },
        additionalProperties: false,
      }
      expect(validateValue(document, schema, { n, s })).toEqual([])
      expect(validateValue(document, schema, { n: s, s: n }).length).toBeGreaterThan(0)
      expect(validateValue(document, schema, { n, s, extra: 1 }).length).toBe(1)
    }),
    params,
  )
})
