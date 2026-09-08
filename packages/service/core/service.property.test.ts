import { describe, expect, test } from "bun:test"
import { type OpenAPIDocument, parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { createDefaultSqlite, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  bootSqlite,
  Collection,
  coerce,
  createService,
  HttpError,
  IdSequence,
  jsonRes,
  type OperationHandlers,
  OperationRegistryError,
  opaqueToken,
  verifyOperations,
} from "./src/index.js"

const params = fcParameters(process.env)

const document: OpenAPIDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/v1/things": {
      post: { operationId: "things.create", responses: { "200": { description: "ok" } } },
      get: { operationId: "things.list", responses: { "200": { description: "ok" } } },
    },
    "/v1/things/search": {
      get: { operationId: "things.search", responses: { "200": { description: "ok" } } },
    },
    "/v1/things/{thing}": {
      parameters: [{ name: "thing", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "things.retrieve", responses: { "200": { description: "ok" } } },
      delete: {
        operationId: "things.delete",
        "x-mockingbird": { supported: false, reason: "not yet" },
        responses: { "200": { description: "ok" } },
      },
    },
  },
})

const handlers: OperationHandlers = {
  "things.create": async (ctx) => jsonRes(200, { op: "create", body: ctx.body, query: ctx.query }),
  "things.list": async (ctx) => jsonRes(200, { op: "list", query: ctx.query }),
  "things.search": async () => jsonRes(200, { op: "search" }),
  "things.retrieve": async (ctx) => {
    if (ctx.params.thing === "boom") throw new HttpError(418, { error: "teapot" })
    if (ctx.params.thing === "crash") throw new Error("unexpected")
    return jsonRes(200, { op: "retrieve", id: ctx.params.thing })
  },
}

const ready = (sqlite?: SqliteClient) => bootSqlite(sqlite ?? createDefaultSqlite())

const build = (sqlite = ready(), replacement?: OperationHandlers) =>
  createService({
    document,
    handlers: replacement ?? handlers,
    sqlite,
    namespace: "things",
    notFound: () => jsonRes(404, { error: "nope" }),
    unsupported: () => jsonRes(501, { error: "unsupported" }),
    onError: (error) =>
      error instanceof HttpError ? error.toResponse() : jsonRes(500, { error: "internal" }),
  })

describe("createService", () => {
  test("registry: missing, extra and unsupported-with-handler are all rejected; the exact set passes", () => {
    expect(verifyOperations(document, handlers)).toEqual([])
    fc.assert(
      fc.property(
        fc.subarray(Object.keys(handlers), { minLength: 1 }),
        fc.boolean(),
        fc.boolean(),
        (omit, extra, unsupported) => {
          const partial: OperationHandlers = { ...handlers }
          for (const id of omit) delete partial[id]
          if (extra) partial["things.unknown"] = async () => new Response()
          if (unsupported) partial["things.delete"] = async () => new Response()
          const problems = verifyOperations(document, partial)
          expect(problems.length).toBe(omit.length + (extra ? 1 : 0) + (unsupported ? 1 : 0))
          expect(() => build(ready(), partial)).toThrow(OperationRegistryError)
        },
      ),
      params,
    )
  })

  test("static routes win over parameterised ones, parameters decode, and unknown paths hit notFound", async () => {
    const service = build()
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/), async (id) => {
        const retrieve = await service.fetch(new Request(`https://x.local/v1/things/${id}`))
        const body = (await retrieve.json()) as Record<string, unknown>
        if (id === "search") expect(body).toEqual({ op: "search" })
        else if (id === "boom") expect(retrieve.status).toBe(418)
        else if (id === "crash") expect(retrieve.status).toBe(500)
        else expect(body).toEqual({ op: "retrieve", id })
        const missing = await service.fetch(new Request(`https://x.local/v1/${id}/nothing`))
        expect(missing.status).toBe(404)
        const unsupported = await service.fetch(
          new Request(`https://x.local/v1/things/${id}`, { method: "DELETE" }),
        )
        expect(unsupported.status).toBe(501)
      }),
      params,
    )
  })

  test("query strings and form bodies reach handlers decoded with bracket notation", async () => {
    const service = build()
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,6}$/),
          fc.oneof(
            fc.string(),
            fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), fc.string(), {
              minKeys: 1,
              maxKeys: 2,
            }),
          ),
          { maxKeys: 3 },
        ),
        async (query) => {
          const url = new URL("https://x.local/v1/things")
          for (const [key, value] of Object.entries(query)) {
            if (typeof value === "string") url.searchParams.append(key, value)
            else
              for (const [k, v] of Object.entries(value)) url.searchParams.append(`${key}[${k}]`, v)
          }
          const response = await service.fetch(new Request(url))
          const body = (await response.json()) as { query: unknown }
          expect(body.query).toEqual(query)
        },
      ),
      params,
    )
  })

  test("reset clears only this service's namespace", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.integer()), {
          minLength: 1,
          maxLength: 5,
        }),
        async (entries) => {
          const sqlite = ready()
          const service = build(sqlite)
          const other = new Collection<number>(sqlite, "other", "items")
          const mine = new Collection<number>(sqlite, "things", "items")
          for (const [key, value] of entries) {
            mine.insert(key, value)
            other.insert(key, value)
          }
          await service.reset()
          expect(mine.list()).toEqual([])
          expect(other.list().length).toBe(new Set(entries.map(([k]) => k)).size)
        },
      ),
      params,
    )
  })
})

describe("Collection", () => {
  test("behaves like an insertion-ordered map with newest-first listing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant("insert" as const),
              id: fc.stringMatching(/^[a-c]$/),
              value: fc.integer(),
            }),
            fc.record({
              op: fc.constant("update" as const),
              id: fc.stringMatching(/^[a-c]$/),
              value: fc.integer(),
            }),
            fc.record({ op: fc.constant("delete" as const), id: fc.stringMatching(/^[a-c]$/) }),
          ),
          { maxLength: 20 },
        ),
        async (ops) => {
          const collection = new Collection<number>(ready(), "ns", "c")
          const model = new Map<string, { seq: number; value: number }>()
          let seq = 0
          for (const op of ops) {
            if (op.op === "insert") {
              collection.insert(op.id, op.value)
              model.set(op.id, { seq: ++seq, value: op.value })
            } else if (op.op === "update") {
              const result = collection.update(op.id, op.value)
              const existing = model.get(op.id)
              expect(result === undefined).toBe(existing === undefined)
              if (existing) existing.value = op.value
            } else {
              expect(collection.delete(op.id)).toBe(model.delete(op.id))
            }
          }
          const listed = collection.list()
          const expected = [...model.entries()]
            .sort((a, b) => b[1].seq - a[1].seq)
            .map(([id, v]) => ({ id, seq: v.seq, value: v.value }))
          expect(listed).toEqual(expected)
          const oldest = collection.list({ order: "oldest" })
          expect(oldest).toEqual([...expected].reverse())
        },
      ),
      params,
    )
  })
})

describe("IdSequence", () => {
  test("ids are unique, prefixed, fixed-length, deterministic per sequence history, and never collide across prefixes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("cus_", "prod_", "price_"), { minLength: 1, maxLength: 30 }),
        async (prefixes) => {
          const a = new IdSequence(ready(), "ns")
          const b = new IdSequence(ready(), "ns")
          const seen = new Set<string>()
          for (const prefix of prefixes) {
            const id = a.next(prefix)
            expect(b.next(prefix)).toBe(id)
            expect(id.startsWith(prefix)).toBe(true)
            expect(id.length).toBe(prefix.length + 14)
            expect(/^[A-Za-z0-9_]+$/.test(id)).toBe(true)
            expect(seen.has(id)).toBe(false)
            seen.add(id)
          }
        },
      ),
      params,
    )
  })

  test("opaqueToken has the requested length and differs for different inputs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer({ min: 1, max: 40 }), (a, b, length) => {
        expect(opaqueToken(a, length).length).toBe(length)
        if (a !== b && length >= 8) expect(opaqueToken(a, length)).not.toBe(opaqueToken(b, length))
      }),
      params,
    )
  })
})

describe("coerce", () => {
  test("integer/boolean round-trip through their string forms and reject everything else", () => {
    fc.assert(
      fc.property(fc.integer(), fc.boolean(), fc.string(), (n, b, s) => {
        expect(coerce.integer(String(n))).toEqual({ ok: true, value: n })
        expect(coerce.boolean(String(b))).toEqual({ ok: true, value: b })
        const asInt = coerce.integer(s)
        if (asInt.ok) expect(String(asInt.value)).toBe(String(Number(s.trim())))
        const asBool = coerce.boolean(s)
        if (asBool.ok) expect(["true", "false", "1", "0"]).toContain(s)
        expect(coerce.enumeration(s, ["a", "b"]).ok).toBe(s === "a" || s === "b")
      }),
      params,
    )
  })
})
