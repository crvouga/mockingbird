import { describe, expect, test } from "bun:test"
import { decodeForm } from "@crvouga/mockingbird-http-codec"
import { type OpenAPIDocument, parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { ParityError, parity } from "./src/index.js"

const params = fcParameters(process.env)

const customerSchema = {
  type: "object",
  required: ["id", "object", "name", "email", "created", "metadata"],
  properties: {
    id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
    object: { const: "customer" },
    name: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
    metadata: { type: "object", additionalProperties: { type: "string" } },
    deleted: { type: "boolean" },
  },
}
const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { type: { type: "string" }, message: { type: "string" } },
    },
  },
}
const jsonResponse = (schema: unknown, description = "ok") => ({
  description,
  headers: { "content-type": { schema: { type: "string" }, "x-mockingbird-parity-header": true } },
  content: { "application/json": { schema } },
})
const customerBody = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 10 },
    email: { type: "string", format: "email" },
    metadata: {
      type: "object",
      properties: { run: { type: "string", "x-mockingbird-scope": { value: "run-id" } } },
      additionalProperties: { type: "string", maxLength: 8 },
    },
  },
}

const spec: OpenAPIDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "reference", version: "1" },
  paths: {
    "/v1/customers": {
      post: {
        operationId: "customers.create",
        requestBody: { content: { "application/x-www-form-urlencoded": { schema: customerBody } } },
        responses: { "200": jsonResponse(customerSchema), "400": jsonResponse(errorSchema, "bad") },
      },
      get: {
        operationId: "customers.list",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 3 } },
          {
            name: "created",
            in: "query",
            schema: {
              type: "object",
              required: ["gte"],
              properties: {
                gte: { type: "integer", "x-mockingbird-scope": { value: "walk-start-unix" } },
              },
            },
          },
        ],
        responses: {
          "200": jsonResponse({
            type: "object",
            required: ["object", "data", "has_more"],
            properties: {
              object: { const: "list" },
              data: { type: "array", items: customerSchema },
              has_more: { type: "boolean" },
            },
          }),
          "400": jsonResponse(errorSchema, "bad"),
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
          "x-mockingbird-resource-ref": { type: "customer" },
        },
      ],
      get: {
        operationId: "customers.retrieve",
        responses: {
          "200": jsonResponse(customerSchema),
          "404": jsonResponse(errorSchema, "missing"),
        },
      },
      post: {
        operationId: "customers.update",
        requestBody: { content: { "application/x-www-form-urlencoded": { schema: customerBody } } },
        responses: {
          "200": jsonResponse(customerSchema),
          "400": jsonResponse(errorSchema, "bad"),
          "404": jsonResponse(errorSchema, "missing"),
        },
      },
      delete: {
        operationId: "customers.delete",
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              id: {
                type: "string",
                "x-mockingbird-resource": { type: "customer", identity: true },
              },
              deleted: { const: true },
            },
          }),
          "404": jsonResponse(errorSchema, "missing"),
        },
      },
    },
  },
})

type Customer = {
  id: string
  object: "customer"
  name: string | null
  email: string | null
  created: number
  metadata: Record<string, string>
}

type Fault =
  | "none"
  | "update-drops-name"
  | "retrieve-404-as-400"
  | "create-extra-field"
  | "list-wrong-order"
  | "delete-keeps-customer"
  | "email-lowercased"

/** Minimal Stripe-flavoured reference server. `idPrefix` distinguishes the two sides' ids. */
const referenceServer = (idPrefix: string, fault: Fault, clock: () => number) => {
  const customers = new Map<string, Customer>()
  const order: string[] = []
  let counter = 0
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const error = (status: number, message: string) =>
    json(status, { error: { type: "invalid_request_error", message } })
  const parseBody = async (request: Request) => {
    const text = await request.text()
    return decodeForm(text)
  }
  const validate = (body: Record<string, unknown>): string | undefined => {
    for (const key of Object.keys(body))
      if (!["name", "email", "metadata"].includes(key)) return `Received unknown parameter: ${key}`
    if (typeof body.name === "string" && [...body.name].length > 10) return "name too long"
    if (body.name !== undefined && typeof body.name !== "string") return "Invalid string: name"
    if (body.email !== undefined && typeof body.email !== "string") return "Invalid string: email"
    if (
      body.metadata !== undefined &&
      (typeof body.metadata !== "object" || Array.isArray(body.metadata))
    )
      return "Invalid hash: metadata"
    if (typeof body.metadata === "object" && body.metadata !== null) {
      for (const value of Object.values(body.metadata as Record<string, unknown>)) {
        if (typeof value !== "string") return "Invalid string: metadata value"
        if ([...value].length > 8) return "metadata value too long"
      }
    }
    return undefined
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const segments = url.pathname.split("/").filter(Boolean)
      if (segments[0] !== "v1" || segments[1] !== "customers")
        return error(404, "Unrecognized request URL")
      const id = segments[2]
      if (id === undefined) {
        if (request.method === "POST") {
          const body = await parseBody(request)
          const problem = validate(body)
          if (problem) return error(400, problem)
          counter++
          const customer: Customer = {
            id: `cus_${idPrefix}${counter}`,
            object: "customer",
            name: typeof body.name === "string" ? body.name : null,
            email:
              typeof body.email === "string"
                ? fault === "email-lowercased"
                  ? body.email.toLowerCase()
                  : body.email
                : null,
            created: Math.floor(clock() / 1000),
            metadata: (body.metadata as Record<string, string> | undefined) ?? {},
          }
          customers.set(customer.id, customer)
          order.push(customer.id)
          return json(
            200,
            fault === "create-extra-field" ? { ...customer, livemode: false } : customer,
          )
        }
        if (request.method === "GET") {
          const limitRaw = url.searchParams.get("limit")
          const limit = limitRaw === null ? 10 : Number(limitRaw)
          if (!Number.isInteger(limit) || limit < 1 || limit > 3)
            return error(400, "Invalid integer: limit")
          const gteRaw = url.searchParams.get("created[gte]")
          const gte = gteRaw === null ? undefined : Number(gteRaw)
          let ids = [...order].reverse()
          if (fault === "list-wrong-order") ids = [...order]
          const data = ids
            .map((key) => customers.get(key))
            .filter(
              (c): c is Customer => c !== undefined && (gte === undefined || c.created >= gte),
            )
          return json(200, {
            object: "list",
            data: data.slice(0, limit),
            has_more: data.length > limit,
          })
        }
        return error(405, "method")
      }
      const existing = customers.get(id)
      if (request.method === "GET") {
        if (!existing)
          return error(fault === "retrieve-404-as-400" ? 400 : 404, `No such customer: '${id}'`)
        return json(200, existing)
      }
      if (request.method === "POST") {
        if (!existing) return error(404, `No such customer: '${id}'`)
        const body = await parseBody(request)
        const problem = validate(body)
        if (problem) return error(400, problem)
        if (typeof body.name === "string")
          existing.name = fault === "update-drops-name" ? null : body.name
        if (typeof body.email === "string") existing.email = body.email
        if (typeof body.metadata === "object" && body.metadata !== null) {
          existing.metadata = { ...existing.metadata, ...(body.metadata as Record<string, string>) }
        }
        return json(200, existing)
      }
      if (request.method === "DELETE") {
        if (!existing) return error(404, `No such customer: '${id}'`)
        if (fault !== "delete-keeps-customer") {
          customers.delete(id)
          order.splice(order.indexOf(id), 1)
        }
        return json(200, { id, deleted: true })
      }
      return error(405, "method")
    },
  }
}

const run = (
  fault: Fault,
  seed: number,
  extra: { numRuns?: number; maxCommands?: number } = {},
) => {
  let tick = 1_700_000_000_000
  const clock = () => (tick += 1000)
  const real = referenceServer("R", "none", clock)
  const lines: string[] = []
  return parity({
    provider: "reference",
    spec,
    seed,
    numRuns: extra.numRuns ?? 8,
    maxCommands: extra.maxCommands ?? 12,
    real: {
      baseUrl: "https://real.reference.local",
      allowedHosts: ["real.reference.local"],
      fetch: (r) => real.fetch(r),
    },
    mock: { create: () => referenceServer("M", fault, clock) },
    clockSkewSeconds: 0,
    now: clock,
    sleep: async () => {},
    log: (line) => lines.push(line),
  }).then(
    (report) => ({ ok: true as const, report, lines }),
    (error: unknown) => ({ ok: false as const, error, lines }),
  )
}

describe("parity runner", () => {
  test("identical implementations pass and every planned operation is exercised given enough walks", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const result = await run("none", seed, { numRuns: 10, maxCommands: 15 })
        if (!result.ok) throw result.error
        expect(result.report.walks).toBe(10)
        expect(result.report.operations).toBeGreaterThan(0)
        expect(result.report.planned.sort()).toEqual([
          "customers.create",
          "customers.delete",
          "customers.list",
          "customers.retrieve",
          "customers.update",
        ])
        expect(result.lines.at(-1)).toContain("reference parity passed")
        expect(result.lines.at(-1)).toContain("10 walks")
      }),
      { ...params, numRuns: 5 },
    )
  })

  test("every injected fault is detected, attributed to the right operation, and shrinks to a short walk", async () => {
    const faults: Array<[Fault, string, number]> = [
      ["update-drops-name", "customers.update", 2],
      ["retrieve-404-as-400", "customers.retrieve", 2],
      ["create-extra-field", "customers.create", 1],
      ["list-wrong-order", "customers.list", 3],
      [
        "delete-keeps-customer",
        "customers.retrieve|customers.list|customers.update|customers.delete",
        3,
      ],
      ["email-lowercased", "customers.create|customers.update", 2],
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...faults),
        fc.integer({ min: 1, max: 1_000_000 }),
        async ([fault, operations, maxHistory], seed) => {
          const result = await run(fault, seed, { numRuns: 40, maxCommands: 20 })
          if (result.ok) {
            expect(result.report.walks).toBe(40)
            return
          }
          const error = result.error
          expect(error).toBeInstanceOf(Error)
          if (!(error instanceof Error)) return
          expect(error.message).toContain(`FC_SEED=${seed}`)
          expect(error.message).toContain("Counterexample")
          const cause = findParityError(error)
          expect(cause).toBeInstanceOf(ParityError)
          if (!cause) return
          expect(operations.split("|")).toContain(cause.details.operationId)
          expect(cause.details.history.length).toBeLessThanOrEqual(maxHistory)
        },
      ),
      { ...params, numRuns: 12 },
    )
  })

  test("the same seed reproduces the same shrunk failure", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const first = await run("update-drops-name", seed, { numRuns: 30, maxCommands: 20 })
        const second = await run("update-drops-name", seed, { numRuns: 30, maxCommands: 20 })
        expect(first.ok).toBe(second.ok)
        if (!first.ok && !second.ok) {
          expect(String(findParityError(first.error)?.details.history)).toBe(
            String(findParityError(second.error)?.details.history),
          )
        }
      }),
      { ...params, numRuns: 3 },
    )
  })

  test("refuses hosts outside the allow list before contacting anything", async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl({ validSchemes: ["https"] }), async (url) => {
        let calls = 0
        await expect(
          parity({
            provider: "x",
            spec,
            real: {
              baseUrl: url,
              allowedHosts: ["allowed.local"],
              fetch: async () => {
                calls++
                return new Response()
              },
            },
            mock: { create: () => referenceServer("M", "none", () => 0) },
            numRuns: 1,
          }),
        ).rejects.toThrow(/refusing/)
        expect(calls).toBe(0)
      }),
      { ...params, numRuns: 10 },
    )
  })
})

const findParityError = (error: unknown): ParityError | undefined => {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (current instanceof ParityError) return current
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}
