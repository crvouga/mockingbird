import { expect, test } from "bun:test"
import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { annotateValue, operationMetadata, pathKey, validateMetadata } from "./src/index.js"

const params = fcParameters(process.env)

const baseDocument = (schemas: Record<string, SchemaObject>): OpenAPIDocument => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: { schemas },
})

test("operationMetadata defaults and derivations", () => {
  fc.assert(
    fc.property(
      fc.option(fc.boolean(), { nil: undefined }),
      fc.option(fc.boolean(), { nil: undefined }),
      (supported, enabled) => {
        const meta = operationMetadata({
          responses: {},
          "x-mockingbird": {
            ...(supported === undefined ? {} : { supported }),
            parity: enabled === undefined ? {} : { enabled },
          },
        })
        expect(meta.supported).toBe(supported ?? true)
        expect(meta.parity.enabled).toBe((supported ?? true) && (enabled ?? true))
        expect(meta.parity.safe).toBe(true)
      },
    ),
    params,
  )
})

test("annotateValue finds every identity and volatile value inside nested lists and maps", () => {
  const document = baseDocument({
    customer: {
      type: "object",
      properties: {
        id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
        created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
        tags: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    list: {
      type: "object",
      properties: { data: { type: "array", items: { $ref: "#/components/schemas/customer" } } },
    },
    union: { anyOf: [{ $ref: "#/components/schemas/customer" }, { type: "string", enum: [""] }] },
  })
  const customer = fc.record({
    id: fc.string(),
    created: fc.integer(),
    tags: fc.dictionary(fc.string(), fc.string()),
  })
  fc.assert(
    fc.property(fc.array(customer, { maxLength: 5 }), (data) => {
      const annotations = annotateValue(document, { $ref: "#/components/schemas/list" }, { data })
      const identities = annotations
        .filter((a) => a.kind === "identity")
        .map((a) => pathKey(a.path))
      const volatile = annotations.filter((a) => a.kind === "volatile").map((a) => pathKey(a.path))
      expect(identities).toEqual(data.map((_, i) => pathKey(["data", i, "id"])))
      expect(volatile).toEqual(data.map((_, i) => pathKey(["data", i, "created"])))
      const single = data[0]
      if (single) {
        const viaUnion = annotateValue(document, { $ref: "#/components/schemas/union" }, single)
        expect(viaUnion.some((a) => a.kind === "identity")).toBe(true)
        expect(annotateValue(document, { $ref: "#/components/schemas/union" }, "")).toEqual([])
      }
    }),
    params,
  )
})

test("validateMetadata rejects dangling references and non-string identities, accepts consistent documents", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.stringMatching(/^[a-z]{1,8}$/),
      (produced, referenced) => {
        const document = baseDocument({
          thing: {
            type: "object",
            properties: {
              id: { type: "string", "x-mockingbird-resource": { type: produced, identity: true } },
            },
          },
          input: {
            type: "object",
            properties: {
              thing: { type: "string", "x-mockingbird-resource-ref": { type: referenced } },
            },
          },
        })
        const issues = validateMetadata(document)
        if (produced === referenced) expect(issues).toEqual([])
        else expect(issues.length).toBe(1)
        const bad = baseDocument({
          thing: {
            type: "object",
            properties: {
              id: { type: "integer", "x-mockingbird-resource": { type: produced, identity: true } },
            },
          },
        })
        expect(validateMetadata(bad).length).toBeGreaterThan(0)
      },
    ),
    params,
  )
})
