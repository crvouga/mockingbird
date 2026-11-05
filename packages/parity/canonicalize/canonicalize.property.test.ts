import { describe, expect, test } from "bun:test"
import { canonicalToken, ResourceTable } from "@crvouga/mockingbird-model"
import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  canonicalizeExchange,
  canonicalizeValue,
  discoverIdentities,
  formatDifference,
  replaceKnownIds,
  structuralDiff,
  unknownToken,
  volatileToken,
} from "./src/index.js"

const params = fcParameters(process.env)

const document: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: {
    schemas: {
      customer: {
        type: "object",
        properties: {
          id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
          created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
          name: { type: ["string", "null"] },
          default_price: {
            type: ["string", "null"],
            "x-mockingbird-resource": { type: "price", identity: true },
          },
        },
      } as SchemaObject,
    },
  },
}
const customerSchema: SchemaObject = { $ref: "#/components/schemas/customer" }
const listSchema: SchemaObject = {
  type: "object",
  properties: { data: { type: "array", items: customerSchema }, has_more: { type: "boolean" } },
}

const idArb = (prefix: string) => fc.stringMatching(/^[a-z0-9]{6,12}$/).map((s) => `${prefix}_${s}`)

describe("canonicalizeValue", () => {
  test("known identities become tokens, volatiles become shape tokens, everything else is untouched", () => {
    fc.assert(
      fc.property(
        idArb("cus"),
        idArb("cus"),
        fc.integer(),
        fc.option(fc.string(), { nil: null }),
        fc.option(idArb("price"), { nil: null }),
        (realId, mockId, created, name, price) => {
          const table = new ResourceTable()
          const resource = table.register("customer", { real: realId, mock: mockId })
          const value = { id: realId, created, name, default_price: price, extra: realId }
          const canonical = canonicalizeValue(value, {
            document,
            schema: customerSchema,
            parityHeaders: [],
            side: "real",
            table,
          }) as Record<string, unknown>
          expect(canonical.id).toBe(canonicalToken("customer", resource.handle))
          expect(canonical.created).toBe(volatileToken("timestamp", created))
          expect(canonical.name).toBe(name === null ? null : replaceKnownIds(name, table, "real"))
          expect(canonical.default_price).toBe(price === null ? null : unknownToken("price", price))
          expect(canonical.extra).toBe(canonicalToken("customer", resource.handle))
          expect(Object.keys(canonical)).toEqual(Object.keys(value))
        },
      ),
      params,
    )
  })

  test("real and mock canonical forms agree iff deterministic content agrees", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(idArb("cus"), idArb("cus"), fc.integer(), fc.integer(), fc.string()), {
          maxLength: 6,
        }),
        fc.boolean(),
        (rows, perturb) => {
          const table = new ResourceTable()
          for (const [realId, mockId] of rows) {
            if (
              table.lookup("real", "customer", realId) ||
              table.lookup("mock", "customer", mockId)
            )
              continue
            table.register("customer", { real: realId, mock: mockId })
          }
          const bound = table.all()
          const real = {
            data: bound.map((r, i) => ({
              id: r.ids.real,
              created: rows[i]?.[2] ?? 0,
              name: rows[i]?.[4] ?? "",
            })),
            has_more: false,
          }
          const mock = {
            data: bound.map((r, i) => ({
              id: r.ids.mock,
              created: rows[i]?.[3] ?? 0,
              name: perturb && i === 0 ? `${rows[i]?.[4] ?? ""}!` : (rows[i]?.[4] ?? ""),
            })),
            has_more: false,
          }
          const options = { document, schema: listSchema, parityHeaders: [] as string[], table }
          const cReal = canonicalizeValue(real, { ...options, side: "real" })
          const cMock = canonicalizeValue(mock, { ...options, side: "mock" })
          const differences = structuralDiff(cReal, cMock)
          if (perturb && bound.length > 0) {
            expect(differences.length).toBeGreaterThan(0)
            expect(differences.every((d) => d.path[0] === "data" && d.path[2] === "name")).toBe(
              true,
            )
          } else expect(differences).toEqual([])
        },
      ),
      params,
    )
  })

  test("preserves __proto__ keys as own properties without changing prototypes", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":null}}')
    const canonical = canonicalizeValue(value, {
      document,
      schema: undefined,
      parityHeaders: [],
      side: "mock",
      table: new ResourceTable(),
    }) as Record<string, unknown>
    expect(canonical).toEqual(value)
    expect(Object.hasOwn(canonical, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(canonical.nested)).toBe(Object.prototype)
    expect(canonical.polluted).toBeUndefined()
  })

  test("without a schema nothing but known ids is rewritten", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const table = new ResourceTable()
        const canonical = canonicalizeValue(value, {
          document,
          schema: undefined,
          parityHeaders: [],
          side: "mock",
          table,
        })
        expect(canonical).toEqual(value)
      }),
      params,
    )
  })
})

describe("token stability", () => {
  // Resource #3 has the numeric-string id "1" on the real side and "2" on the mock side.
  const numericTable = () => {
    const table = new ResourceTable()
    table.register("customer", { real: "cus_real_a", mock: "cus_mock_a" }) // #1
    table.register("customer", { real: "cus_real_b", mock: "cus_mock_b" }) // #2
    table.register("customer", { real: "1", mock: "2" }) // #3
    return table
  }

  test("a short known id never rewrites the handle inside an emitted token", () => {
    const table = numericTable()
    expect(replaceKnownIds("cus_real_a", table, "real")).toBe(canonicalToken("customer", 1))
    expect(replaceKnownIds("cus_mock_b", table, "mock")).toBe(canonicalToken("customer", 2))
    expect(replaceKnownIds("see cus_real_a and 1", table, "real")).toBe(
      `see ${canonicalToken("customer", 1)} and ${canonicalToken("customer", 3)}`,
    )
  })

  test("different resources on each side never canonicalize to the same value", () => {
    const table = numericTable()
    const options = { document, schema: customerSchema, parityHeaders: [] as string[], table }
    // Real answers customer #1, the mock answers customer #2: a divergence.
    const real = canonicalizeValue(
      { id: "cus_real_a", name: "for cus_real_a" },
      { ...options, side: "real" },
    )
    const mock = canonicalizeValue(
      { id: "cus_mock_b", name: "for cus_mock_b" },
      { ...options, side: "mock" },
    )
    expect(structuralDiff(real, mock).map((d) => formatDifference(d))).toEqual([
      '$.id: real="resource:customer:1" mock="resource:customer:2"',
      '$.name: real="for resource:customer:1" mock="for resource:customer:2"',
    ])
  })

  test("short ids never rewrite schema property names while dynamic keys still canonicalize", () => {
    const table = new ResourceTable()
    table.register("customer", { real: "_", mock: ":" })
    table.register("customer", { real: "a", mock: "i" })
    const options = { document, schema: customerSchema, parityHeaders: [] as string[], table }
    const real = canonicalizeValue({ id: "a", name: "a" }, { ...options, side: "real" })
    const mock = canonicalizeValue({ id: "i", name: "i" }, { ...options, side: "mock" })
    expect(real).toEqual({ id: canonicalToken("customer", 2), name: canonicalToken("customer", 2) })
    expect(mock).toEqual(real)
    const composedSchema: SchemaObject = {
      type: "array",
      items: { allOf: [{ oneOf: [customerSchema] }] },
    }
    expect(
      canonicalizeValue([{ id: "a", name: "a" }], {
        ...options,
        schema: composedSchema,
        side: "real",
      }),
    ).toEqual(
      canonicalizeValue([{ id: "i", name: "i" }], {
        ...options,
        schema: composedSchema,
        side: "mock",
      }),
    )
    const mapSchema: SchemaObject = { type: "object", additionalProperties: customerSchema }
    expect(
      canonicalizeValue({ a: { id: "a" } }, { ...options, schema: mapSchema, side: "real" }),
    ).toEqual(
      canonicalizeValue({ i: { id: "i" } }, { ...options, schema: mapSchema, side: "mock" }),
    )
  })

  test("canonical forms agree iff the referenced handles agree", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[0-9a-z:_]{1,4}$/), { minLength: 2, maxLength: 8 }),
        fc.uniqueArray(fc.stringMatching(/^[0-9a-z:_]{1,4}$/), { minLength: 2, maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        (realIds, mockIds, a, b) => {
          const n = Math.min(realIds.length, mockIds.length)
          const table = new ResourceTable()
          for (let i = 0; i < n; i++)
            table.register("customer", { real: realIds[i] as string, mock: mockIds[i] as string })
          const realId = realIds[a % n] as string
          const mockId = mockIds[b % n] as string
          const options = { document, schema: customerSchema, parityHeaders: [] as string[], table }
          const real = canonicalizeValue({ id: realId }, { ...options, side: "real" })
          const mock = canonicalizeValue({ id: mockId }, { ...options, side: "mock" })
          expect(structuralDiff(real, mock).length === 0).toBe(a % n === b % n)
        },
      ),
      params,
    )
  })
})

describe("discoverIdentities", () => {
  test("pairs fresh ids at the same path, ignores known or mismatched locations", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(idArb("cus"), idArb("cus")), { minLength: 1, maxLength: 5 }),
        (pairs) => {
          const table = new ResourceTable()
          const real = { data: pairs.map(([r]) => ({ id: r })), has_more: false }
          const mock = { data: pairs.map(([, m]) => ({ id: m })), has_more: false }
          const discovered = discoverIdentities(document, listSchema, real, mock, table)
          const uniqueReal = new Set(pairs.map(([r]) => r))
          const uniqueMock = new Set(pairs.map(([, m]) => m))
          expect(discovered.length).toBeLessThanOrEqual(Math.min(uniqueReal.size, uniqueMock.size))
          for (const d of discovered) {
            expect(table.lookup("real", "customer", d.real)?.ids.mock).toBe(d.mock)
          }
          expect(discoverIdentities(document, listSchema, real, mock, table)).toEqual([])
          const cReal = canonicalizeValue(real, {
            document,
            schema: listSchema,
            parityHeaders: [],
            side: "real",
            table,
          })
          const cMock = canonicalizeValue(mock, {
            document,
            schema: listSchema,
            parityHeaders: [],
            side: "mock",
            table,
          })
          const allDistinct = uniqueReal.size === pairs.length && uniqueMock.size === pairs.length
          if (allDistinct) expect(structuralDiff(cReal, cMock)).toEqual([])
        },
      ),
      params,
    )
  })
})

describe("canonicalizeExchange", () => {
  test("keeps exactly the declared parity headers, lower-cased, with ids replaced", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z][a-z-]{0,10}$/), fc.string(), { maxKeys: 6 }),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z-]{0,10}$/), { maxLength: 4 }),
        fc.integer({ min: 100, max: 599 }),
        (headers, parityHeaders, status) => {
          const table = new ResourceTable()
          const canonical = canonicalizeExchange(
            { status, headers, body: { kind: "empty" } },
            { document, schema: undefined, parityHeaders, side: "real", table },
          )
          expect(canonical.status).toBe(status)
          expect(canonical.body).toEqual({ kind: "empty" })
          const expected: Record<string, string> = {}
          for (const h of parityHeaders) {
            const v = headers[h]
            if (v !== undefined) expected[h] = v
          }
          expect(canonical.headers).toEqual(expected)
        },
      ),
      params,
    )
  })
})

describe("structuralDiff", () => {
  test("is empty exactly for structurally equal values and every difference formats", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const diff = structuralDiff(a, b)
        expect(diff.length === 0).toBe(JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)))
        expect(structuralDiff(a, a)).toEqual([])
        for (const d of diff) expect(typeof formatDifference(d)).toBe("string")
      }),
      params,
    )
  })

  test("distinguishes omitted from null and string from number", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), (key, n) => {
        expect(structuralDiff({ [key]: null }, {}).length).toBe(1)
        expect(structuralDiff({ [key]: n }, { [key]: String(n) }).length).toBe(1)
        expect(structuralDiff([n], [n, n]).length).toBe(1)
      }),
      params,
    )
  })
})

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}
