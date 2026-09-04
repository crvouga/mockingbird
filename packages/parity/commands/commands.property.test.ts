import { describe, expect, test } from "bun:test"
import { decodeForm } from "@crvouga/mockingbird-http-codec"
import { collectPlaceholders, ResourceTable } from "@crvouga/mockingbird-model"
import {
  type OpenAPIDocument,
  parseOpenAPIDocument,
  validateValue,
} from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  commandArbitrary,
  concretize,
  describeCommand,
  isEligible,
  planOperations,
  referencedTypes,
  toRequest,
} from "./src/index.js"

const params = fcParameters(process.env)

const document: OpenAPIDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "shop", version: "1" },
  paths: {
    "/v1/customers": {
      post: {
        operationId: "customers.create",
        requestBody: {
          required: false,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", maxLength: 10 },
                  email: { type: "string", format: "email" },
                  metadata: {
                    type: "object",
                    properties: {
                      run: { type: "string", "x-mockingbird-scope": { value: "run-id" } },
                    },
                    required: ["run"],
                  },
                  legacy: { type: "string", "x-mockingbird-unsupported": true },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/customer" } } },
          },
        },
      },
      get: {
        operationId: "customers.list",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          {
            name: "created",
            in: "query",
            schema: {
              type: "object",
              properties: {
                gte: { type: "integer", "x-mockingbird-scope": { value: "walk-start-unix" } },
              },
              required: ["gte"],
            },
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/customer" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/customers/{customer}": {
      parameters: [
        {
          name: "customer",
          in: "path",
          required: true,
          schema: { type: "string" },
          "x-mockingbird-resource-ref": { type: "customer", missing: "cus_missing" },
        },
      ],
      get: {
        operationId: "customers.retrieve",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/customer" } } },
          },
        },
      },
      delete: {
        operationId: "customers.delete",
        "x-mockingbird": { parity: { safe: false, reason: "destructive" } },
        responses: { "200": { description: "ok" } },
      },
    },
    "/v1/prices": {
      post: {
        operationId: "prices.create",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["customer", "amount"],
                properties: {
                  customer: { type: "string", "x-mockingbird-resource-ref": { type: "customer" } },
                  amount: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/price" } } },
          },
        },
      },
    },
    "/v1/unsupported": {
      get: {
        operationId: "unsupported.get",
        "x-mockingbird": { supported: false, reason: "n/a" },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      customer: {
        type: "object",
        properties: {
          id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
          name: { type: "string" },
        },
      },
      price: {
        type: "object",
        properties: {
          id: { type: "string", "x-mockingbird-resource": { type: "price", identity: true } },
          customer: {
            type: "string",
            "x-mockingbird-resource": { type: "customer", identity: true },
          },
        },
      },
    },
  },
})

const plans = planOperations(document)
const planById = new Map(plans.map((plan) => [plan.operation.operationId, plan]))
const scope = { runId: "run-1", walkStartUnix: 1_700_000_000 }

describe("planOperations", () => {
  test("excludes unsupported and unsafe operations, derives requires/produces from metadata", () => {
    expect([...planById.keys()].sort()).toEqual([
      "customers.create",
      "customers.list",
      "customers.retrieve",
      "prices.create",
    ])
    expect(planById.get("customers.create")?.produces).toEqual(["customer"])
    expect(planById.get("customers.retrieve")?.requires).toEqual(["customer"])
    expect(planById.get("prices.create")?.requires).toEqual(["customer"])
    expect(planById.get("prices.create")?.produces).toEqual(["customer", "price"])
    expect(planById.get("customers.list")?.requires).toEqual([])
    expect(
      planOperations(document, { includeUnsafe: true }).map((p) => p.operation.operationId),
    ).toContain("customers.delete")
  })
})

describe("commandArbitrary", () => {
  const commands = commandArbitrary({ document, plans })

  test("every command targets a planned operation, never leaks unsupported fields, and valid bodies validate once resolved", () => {
    fc.assert(
      fc.property(commands, (command) => {
        const plan = planById.get(command.operationId)
        expect(plan).toBeDefined()
        if (!plan) return
        expect(JSON.stringify(command)).not.toContain("legacy")
        expect(typeof describeCommand(command)).toBe("string")
        for (const parameter of plan.operation.parameters) {
          if (parameter.in === "path") expect(command.parameters[parameter.name]).toBeDefined()
        }
        if (command.body !== undefined && plan.body && command.invalid === undefined) {
          const table = new ResourceTable()
          table.register("customer", { real: "cus_r", mock: "cus_m" })
          const request = concretize(command, plan, table, "real", scope)
          expect(request.body).toBeDefined()
          if (plan.body.mediaType === "application/json") {
            const decoded: unknown = JSON.parse(request.body?.body ?? "null")
            expect(validateValue(document, plan.body.schema, decoded)).toEqual([])
          }
        }
      }),
      params,
    )
  })

  test("eligibility is exactly 'every referenced type has an instance'", () => {
    fc.assert(
      fc.property(commands, fc.nat({ max: 3 }), (command, customers) => {
        const table = new ResourceTable()
        for (let i = 0; i < customers; i++)
          table.register("customer", { real: `realcus_${i}`, mock: `mockcus_${i}` })
        const eligible = isEligible(command, (type) => table.count(type))
        const types = referencedTypes(command)
        expect(eligible).toBe(types.every((type) => table.count(type) > 0))
        if (eligible) {
          const plan = planById.get(command.operationId)
          if (!plan) throw new Error("unreachable")
          const real = concretize(command, plan, table, "real", scope)
          const mock = concretize(command, plan, table, "mock", scope)
          expect(real.method).toBe(mock.method)
          expect(real.path.replaceAll("realcus_", "cus_")).toBe(
            mock.path.replaceAll("mockcus_", "cus_"),
          )
          expect(JSON.stringify(real.query)).not.toContain("$mockingbird")
          expect(JSON.stringify(real.body ?? "")).not.toContain("$mockingbird")
          const request = toRequest(real, "https://api.example.test/base/", {
            authorization: "Bearer x",
          })
          expect(request.url.startsWith(`https://api.example.test/base${real.path}`)).toBe(true)
          expect(request.headers.get("authorization")).toBe("Bearer x")
        } else if (types.length > 0) {
          const plan = planById.get(command.operationId)
          if (!plan) throw new Error("unreachable")
          expect(() => concretize(command, plan, table, "real", scope)).toThrow()
        }
      }),
      params,
    )
  })

  test("scope placeholders resolve identically on both sides and land in query/body encodings", () => {
    fc.assert(
      fc.property(
        commands.filter(
          (c) => c.operationId === "customers.create" || c.operationId === "customers.list",
        ),
        (command) => {
          const plan = planById.get(command.operationId)
          if (!plan) throw new Error("unreachable")
          const table = new ResourceTable()
          const real = concretize(command, plan, table, "real", scope)
          const mock = concretize(command, plan, table, "mock", scope)
          expect(real).toEqual(mock)
          if (
            command.operationId === "customers.list" &&
            command.parameters.created !== undefined
          ) {
            expect(real.query).toContainEqual(["created[gte]", String(scope.walkStartUnix)])
          }
          if (command.operationId === "customers.create" && command.body !== undefined) {
            const decoded = decodeForm(real.body?.body ?? "")
            const metadata = decoded.metadata
            if (
              metadata !== undefined &&
              typeof metadata === "object" &&
              !Array.isArray(metadata)
            ) {
              expect(metadata.run).toBe(scope.runId)
            }
          }
        },
      ),
      params,
    )
  })

  test("resource references are placeholders, never concrete ids, and missing refs use the declared id", () => {
    fc.assert(
      fc.property(
        commands.filter((c) => c.operationId === "customers.retrieve"),
        (command) => {
          const placeholders = collectPlaceholders(command.parameters)
          expect(placeholders.length).toBe(1)
          const [placeholder] = placeholders
          if (!placeholder) throw new Error("unreachable")
          const plan = planById.get(command.operationId)
          if (!plan) throw new Error("unreachable")
          const table = new ResourceTable()
          table.register("customer", { real: "cus_real", mock: "cus_mock" })
          const real = concretize(command, plan, table, "real", scope)
          if (placeholder.$mockingbird === "missing")
            expect(real.path).toBe("/v1/customers/cus_missing")
          else expect(real.path).toBe("/v1/customers/cus_real")
        },
      ),
      params,
    )
  })

  test("invalid bodies are produced with nonzero frequency and describe their violation", () => {
    const samples = fc.sample(
      commands.filter((c) => c.operationId === "prices.create"),
      { numRuns: 200, ...params },
    )
    const invalid = samples.filter((c) => c.invalid !== undefined)
    expect(invalid.length).toBeGreaterThan(0)
    for (const command of invalid) expect(describeCommand(command)).toContain("invalid(")
  })
})
