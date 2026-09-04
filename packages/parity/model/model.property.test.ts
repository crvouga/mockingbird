import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  canonicalToken,
  collectPlaceholders,
  isPlaceholder,
  missingPlaceholder,
  pickRef,
  ResourceTable,
  refPlaceholder,
  resolvePlaceholders,
  type Side,
  scopePlaceholder,
} from "./src/index.js"

const typeArb = fc.constantFrom("customer", "product", "price", "user")
const idArb = fc.string({ minLength: 1, maxLength: 12 })

describe("ResourceTable", () => {
  test("handles are sequential per table and idOf/lookup are inverse for every bound side", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: typeArb,
            real: fc.option(idArb, { nil: undefined }),
            mock: fc.option(idArb, { nil: undefined }),
          }),
          { maxLength: 30 },
        ),
        (specs) => {
          const table = new ResourceTable()
          const seen = new Map<string, number>()
          const resources = specs.map((spec, i) => {
            const ids: Partial<Record<Side, string>> = {}
            if (spec.real !== undefined && !seen.has(`real:${spec.type}:${spec.real}`)) {
              ids.real = spec.real
              seen.set(`real:${spec.type}:${spec.real}`, i)
            }
            if (spec.mock !== undefined && !seen.has(`mock:${spec.type}:${spec.mock}`)) {
              ids.mock = spec.mock
              seen.set(`mock:${spec.type}:${spec.mock}`, i)
            }
            return table.register(spec.type, ids)
          })
          resources.forEach((resource, i) => {
            expect(resource.handle).toBe(i + 1)
            for (const side of ["real", "mock"] as const) {
              const id = resource.ids[side]
              if (id === undefined) continue
              expect(table.lookup(side, resource.type, id)).toBe(resource)
              expect(table.idOf(resource, side)).toBe(id)
            }
          })
          for (const type of new Set(specs.map((s) => s.type))) {
            const expected = resources.filter((r) => r.type === type).map((r) => r.handle)
            expect([...table.handles(type)]).toEqual(expected)
            expect(table.count(type)).toBe(expected.length)
          }
          expect(table.all()).toEqual(resources)
        },
      ),
      fcParameters(process.env),
    )
  })

  test("rebinding a handle to a different id throws, same id is idempotent", () => {
    fc.assert(
      fc.property(typeArb, idArb, idArb, (type, a, b) => {
        const table = new ResourceTable()
        const r = table.allocate(type)
        table.bind(r.handle, "real", a)
        table.bind(r.handle, "real", a)
        if (a === b) expect(() => table.bind(r.handle, "real", b)).not.toThrow()
        else expect(() => table.bind(r.handle, "real", b)).toThrow()
        expect(() => table.bind(r.handle + 1, "real", b)).toThrow(RangeError)
      }),
      fcParameters(process.env),
    )
  })

  test("knownIds is sorted longest-first and covers every bound id", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(typeArb, idArb), { maxLength: 20 }), (pairs) => {
        const table = new ResourceTable()
        const bound = new Set<string>()
        for (const [type, id] of pairs) {
          if (table.lookup("mock", type, id)) continue
          table.register(type, { mock: id })
          bound.add(id)
        }
        const known = table.knownIds("mock")
        expect(new Set(known.map((k) => k.id))).toEqual(bound)
        for (let i = 1; i < known.length; i++) {
          const prev = known[i - 1]
          const curr = known[i]
          if (!prev || !curr) throw new Error("unreachable")
          expect(prev.id.length >= curr.id.length).toBe(true)
        }
      }),
      fcParameters(process.env),
    )
  })

  test("pickRef wraps modulo the number of resources and is undefined when none exist", () => {
    fc.assert(
      fc.property(typeArb, fc.nat({ max: 10 }), fc.nat({ max: 1000 }), (type, count, pick) => {
        const table = new ResourceTable()
        for (let i = 0; i < count; i++) table.allocate(type)
        const ref = pickRef(table, type, pick)
        if (count === 0) expect(ref).toBeUndefined()
        else {
          expect(ref?.type).toBe(type)
          expect(ref?.handle).toBe((pick % count) + 1)
        }
      }),
      fcParameters(process.env),
    )
  })
})

describe("placeholders", () => {
  const placeholderArb = fc.oneof(
    fc.tuple(typeArb, fc.nat({ max: 50 })).map(([t, p]) => refPlaceholder(t, p)),
    fc
      .tuple(typeArb, fc.option(idArb, { nil: undefined }))
      .map(([t, m]) => missingPlaceholder(t, m)),
    idArb.map(scopePlaceholder),
  )
  const { tree } = fc.letrec((tie) => ({
    tree: fc.oneof(
      { depthSize: "small" },
      fc.jsonValue({ maxDepth: 1 }),
      placeholderArb,
      fc.array(tie("tree"), { maxLength: 4 }),
      fc.dictionary(fc.string({ maxLength: 4 }), tie("tree"), { maxKeys: 4 }),
    ),
  }))

  test("resolvePlaceholders replaces every placeholder exactly once and touches nothing else", () => {
    fc.assert(
      fc.property(tree, (value) => {
        const placeholders = collectPlaceholders(value)
        let calls = 0
        const resolved = resolvePlaceholders(value, (p) => {
          calls++
          return `<${p.$mockingbird}>`
        })
        expect(calls).toBe(placeholders.length)
        expect(collectPlaceholders(resolved)).toEqual([])
        const identity = resolvePlaceholders(value, (p) => p)
        expect(identity).toEqual(value)
      }),
      fcParameters(process.env),
    )
  })

  test("isPlaceholder is false for arbitrary JSON without the marker", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(isPlaceholder(value)).toBe(
          typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).$mockingbird === "string",
        )
      }),
      fcParameters(process.env),
    )
  })

  test("canonicalToken is injective on (type, handle)", () => {
    fc.assert(
      fc.property(typeArb, typeArb, fc.nat(), fc.nat(), (t1, t2, h1, h2) => {
        expect(canonicalToken(t1, h1) === canonicalToken(t2, h2)).toBe(t1 === t2 && h1 === h2)
      }),
      fcParameters(process.env),
    )
  })
})
