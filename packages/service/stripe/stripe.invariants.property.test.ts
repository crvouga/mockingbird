import { describe, expect, test } from "bun:test"
import { encodeForm } from "@crvouga/mockingbird-http-codec"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { StripeAPI } from "./src/index.js"

/**
 * Documented Stripe semantics that self-parity cannot check (two identical mocks always agree):
 * cursor pagination, list filters, metadata merging, deletion tombstones, lookup-key ownership,
 * decimal amounts and the auth/routing envelope. Each property drives a fresh mock with generated
 * inputs and compares it with a small model of the documented rule.
 */

const params = fcParameters(process.env)
const HOST = "https://mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }
const START = 1_700_000_000_000

type Json = Record<string, unknown>
type Reply = { status: number; body: Json }

const client = () => {
  let clock = START
  const api = new StripeAPI({ now: () => clock })
  const send = async (method: string, path: string, form?: Record<string, unknown>) => {
    const response = await api.fetch(
      new Request(`${HOST}${path}`, {
        method,
        headers:
          form === undefined
            ? AUTH
            : { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
        ...(form === undefined ? {} : { body: encodeForm(form) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Json }
  }
  return {
    api,
    /** Advance the clock by whole seconds so `created`/`updated` move. */
    tick: (seconds: number) => {
      clock += seconds * 1000
    },
    seconds: () => Math.floor(clock / 1000),
    post: (path: string, form: Record<string, unknown>) => send("POST", path, form),
    get: (path: string, query: Record<string, unknown> = {}) => {
      const encoded = encodeForm(query)
      return send("GET", encoded === "" ? path : `${path}?${encoded}`)
    },
    del: (path: string) => send("DELETE", path),
  }
}

const id = (reply: Reply) => reply.body.id as string
const ids = (reply: Reply) => (reply.body.data as Json[]).map((item) => item.id as string)
const error = (reply: Reply) => reply.body.error as Json
const created = async (reply: Promise<Reply>) => {
  const result = await reply
  expect(result.status).toBe(200)
  return result
}

const clampLimit = (limit: number) => Math.min(100, Math.max(1, limit))

/** Stripe strips names and refuses blank ones, so every generated name keeps a visible character. */
const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,9}$/)
const word = fc.stringMatching(/^[a-z]{1,5}$/)
const EMAILS = ["ada@example.com", "grace@example.com", "linus@example.com"]
const LOOKUP_KEYS = ["alpha", "beta", "gamma"]

describe("Stripe list semantics", () => {
  test("cursor pagination enumerates every product newest-first exactly once, forwards and backwards", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ name, active: fc.boolean() }), { maxLength: 12 }),
        fc.integer({ min: -2, max: 6 }),
        async (products, limit) => {
          const c = client()
          const newestFirst: string[] = []
          for (const product of products)
            newestFirst.unshift(id(await created(c.post("/v1/products", product))))
          const pageSize = clampLimit(limit)

          const forward: string[] = []
          let cursor: string | undefined
          for (;;) {
            const page = await c.get("/v1/products", {
              limit,
              ...(cursor === undefined ? {} : { starting_after: cursor }),
            })
            expect(page.status).toBe(200)
            const chunk = ids(page)
            expect(chunk.length).toBeLessThanOrEqual(pageSize)
            forward.push(...chunk)
            expect(page.body.has_more).toBe(forward.length < newestFirst.length)
            if (!page.body.has_more) break
            expect(chunk.length).toBe(pageSize)
            cursor = chunk[chunk.length - 1]
          }
          expect(forward).toEqual(newestFirst)

          for (const [index, anchor] of newestFirst.entries()) {
            const page = await c.get("/v1/products", { limit, ending_before: anchor })
            expect(page.status).toBe(200)
            expect(ids(page)).toEqual(newestFirst.slice(Math.max(0, index - pageSize), index))
            expect(page.body.has_more).toBe(index - pageSize > 0)
          }

          const active = await c.get("/v1/products", { limit: 100, active: true })
          expect(ids(active)).toEqual(
            newestFirst.filter((_, index) => products[products.length - 1 - index]?.active),
          )
          const both = await c.get("/v1/products", {
            starting_after: newestFirst[0] ?? "prod_x",
            ending_before: newestFirst[0] ?? "prod_x",
          })
          expect(both.status).toBe(400)
          const missing = await c.get("/v1/products", { starting_after: "prod_missing" })
          expect(missing.status).toBe(400)
          expect(error(missing).code).toBe("resource_missing")
          expect(error(missing).param).toBe("starting_after")
        },
      ),
      { ...params, numRuns: params.numRuns ?? 40 },
    )
  })

  test("`ids[]` returns exactly the existing requested products; cursors are rejected alongside it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(name, { minLength: 1, maxLength: 8 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        async (names, chosen) => {
          const c = client()
          const newestFirst: string[] = []
          for (const item of names)
            newestFirst.unshift(id(await created(c.post("/v1/products", { name: item }))))
          const requested = newestFirst.filter((_, index) => chosen[index])
          const page = await c.get("/v1/products", { ids: [...requested, "prod_missing"] })
          expect(page.status).toBe(200)
          expect(ids(page)).toEqual(requested)
          const clash = await c.get("/v1/products", {
            ids: requested,
            starting_after: newestFirst[0],
          })
          expect(clash.status).toBe(400)
          expect(error(clash).param).toBe("ids")
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })

  test("`created` range filters partition products by their creation second", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 8 }),
        async (gaps, pivotIndex) => {
          const c = client()
          const stamps: Array<{ id: string; created: number }> = []
          for (const gap of gaps) {
            c.tick(gap)
            const product = await created(c.post("/v1/products", { name: "p" }))
            stamps.unshift({ id: id(product), created: product.body.created as number })
            expect(product.body.created).toBe(c.seconds())
          }
          const pivot = stamps[pivotIndex % stamps.length]?.created ?? 0
          const expectIds = (query: Json, keep: (created: number) => boolean) =>
            c.get("/v1/products", { limit: 100, ...query }).then((page) => {
              expect(page.status).toBe(200)
              expect(ids(page)).toEqual(stamps.filter((s) => keep(s.created)).map((s) => s.id))
            })
          await expectIds({ created: pivot }, (t) => t === pivot)
          await expectIds({ created: { gt: pivot } }, (t) => t > pivot)
          await expectIds({ created: { gte: pivot } }, (t) => t >= pivot)
          await expectIds({ created: { lt: pivot } }, (t) => t < pivot)
          await expectIds({ created: { lte: pivot } }, (t) => t <= pivot)
          await expectIds({ created: { gt: pivot - 1, lte: pivot } }, (t) => t === pivot)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })

  test("customer list excludes tombstones and filters by exact email; tombstones keep their documented shape", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            email: fc.option(fc.constantFrom(...EMAILS), { nil: undefined }),
            deleted: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        async (customers) => {
          const c = client()
          const rows: Array<{ id: string; email?: string; deleted: boolean }> = []
          for (const customer of customers) {
            const reply = await created(
              c.post(
                "/v1/customers",
                customer.email === undefined ? {} : { email: customer.email },
              ),
            )
            rows.unshift({
              id: id(reply),
              deleted: customer.deleted,
              ...(customer.email === undefined ? {} : { email: customer.email }),
            })
          }
          for (const row of rows) {
            if (!row.deleted) continue
            const gone = await c.del(`/v1/customers/${row.id}`)
            expect(gone.body).toEqual({ id: row.id, object: "customer", deleted: true })
          }
          const live = rows.filter((row) => !row.deleted)
          const page = await c.get("/v1/customers", { limit: 100 })
          expect(ids(page)).toEqual(live.map((row) => row.id))
          for (const email of EMAILS) {
            const filtered = await c.get("/v1/customers", { limit: 100, email })
            expect(ids(filtered)).toEqual(
              live.filter((row) => row.email === email).map((row) => row.id),
            )
          }
          for (const row of rows) {
            const fetched = await c.get(`/v1/customers/${row.id}`)
            expect(fetched.status).toBe(200)
            expect(fetched.body.deleted === true).toBe(row.deleted)
            if (!row.deleted) continue
            const again = await c.del(`/v1/customers/${row.id}`)
            expect(again.status).toBe(404)
            expect(error(again).code).toBe("resource_missing")
            const update = await c.post(`/v1/customers/${row.id}`, { name: "x" })
            expect(update.status).toBe(400)
            expect(error(update).code).toBe("resource_missing")
            const cursor = await c.get("/v1/customers", { starting_after: row.id })
            expect(cursor.status).toBe(400)
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })
})

describe("Stripe write semantics", () => {
  test('metadata merges per key, `""` deletes a key, `metadata=""` clears, and reads see every write', async () => {
    const entry = fc.tuple(word, fc.stringMatching(/^[a-z0-9]{0,4}$/))
    const step = fc.oneof(
      { arbitrary: fc.array(entry, { minLength: 1, maxLength: 4 }), weight: 4 },
      { arbitrary: fc.constant("clear" as const), weight: 1 },
    )
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("customer", "product"),
        fc.array(entry, { maxLength: 4 }),
        fc.array(step, { maxLength: 6 }),
        async (kind, initial, steps) => {
          const c = client()
          const model: Record<string, string> = {}
          const apply = (entries: Array<[string, string]>) => {
            for (const [key, value] of entries) {
              if (value === "") delete model[key]
              else model[key] = value
            }
          }
          apply(initial)
          const path = kind === "customer" ? "/v1/customers" : "/v1/products"
          // `metadata=` (an empty hash) is refused on create, so an empty start sends nothing.
          const create = await created(
            c.post(path, {
              ...(kind === "product" ? { name: "p" } : {}),
              ...(initial.length === 0 ? {} : { metadata: Object.fromEntries(initial) }),
            }),
          )
          expect(create.body.metadata).toEqual(model)
          const self = `${path}/${id(create)}`
          for (const item of steps) {
            c.tick(1)
            const before = ((await c.get(self)).body.updated as number | undefined) ?? 0
            let reply: Reply
            if (item === "clear") {
              for (const key of Object.keys(model)) delete model[key]
              reply = await c.post(self, { metadata: "" })
            } else {
              apply(item)
              reply = await c.post(self, { metadata: Object.fromEntries(item) })
            }
            expect(reply.status).toBe(200)
            expect(reply.body.metadata).toEqual(model)
            const read = await c.get(self)
            expect(read.body).toEqual(reply.body)
            if (kind === "product") expect(read.body.updated as number).toBeGreaterThan(before)
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 40 },
    )
  })

  test("a lookup key has at most one holder; `transfer_lookup_key` moves it, otherwise the clash is refused", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            key: fc.constantFrom(...LOOKUP_KEYS),
            transfer: fc.boolean(),
            viaUpdate: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (steps) => {
          const c = client()
          const product = id(await created(c.post("/v1/products", { name: "p" })))
          const holder = new Map<string, string>()
          const keyless: string[] = []
          for (const step of steps) {
            const existing = holder.get(step.key)
            const base = { product, currency: "usd", unit_amount: 100 }
            const target = step.viaUpdate ? keyless.pop() : undefined
            const reply =
              target === undefined
                ? await c.post("/v1/prices", {
                    ...base,
                    lookup_key: step.key,
                    ...(step.transfer ? { transfer_lookup_key: true } : {}),
                  })
                : await c.post(`/v1/prices/${target}`, {
                    lookup_key: step.key,
                    ...(step.transfer ? { transfer_lookup_key: true } : {}),
                  })
            if (existing !== undefined && !step.transfer) {
              expect(reply.status).toBe(400)
              expect(error(reply).message).toBe(
                `A price (\`${existing}\`) already uses that lookup key.`,
              )
              expect(error(reply).param).toBe("lookup_key")
              if (target !== undefined) keyless.push(target)
              else keyless.push(id(await created(c.post("/v1/prices", base))))
            } else {
              expect(reply.status).toBe(200)
              expect(reply.body.lookup_key).toBe(step.key)
              if (existing !== undefined) {
                keyless.push(existing)
                expect((await c.get(`/v1/prices/${existing}`)).body.lookup_key).toBeNull()
              }
              holder.set(step.key, id(reply))
            }
            for (const key of LOOKUP_KEYS) {
              const listed = await c.get("/v1/prices", { lookup_keys: [key], limit: 100 })
              const owner = holder.get(key)
              expect(ids(listed)).toEqual(owner === undefined ? [] : [owner])
            }
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 40 },
    )
  })

  test("prices pin products: deletion is refused while a price exists and allowed otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 6 }),
        async (priceCounts) => {
          const c = client()
          for (const count of priceCounts) {
            const product = id(await created(c.post("/v1/products", { name: "p" })))
            for (let i = 0; i < count; i += 1)
              await created(c.post("/v1/prices", { product, currency: "usd", unit_amount: i }))
            const removal = await c.del(`/v1/products/${product}`)
            if (count > 0) {
              expect(removal.status).toBe(400)
              expect(error(removal).message).toBe(
                "This product cannot be deleted because it has one or more user-created prices.",
              )
              expect((await c.get(`/v1/products/${product}`)).status).toBe(200)
              continue
            }
            expect(removal.body).toEqual({ id: product, object: "product", deleted: true })
            const gone = await c.get(`/v1/products/${product}`)
            expect(gone.status).toBe(404)
            expect(error(gone).code).toBe("resource_missing")
            const orphan = await c.post("/v1/prices", { product, currency: "usd", unit_amount: 1 })
            expect(orphan.status).toBe(400)
            expect(error(orphan)).toMatchObject({ code: "resource_missing", param: "product" })
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })

  test("unit_amount is the integral view of unit_amount_decimal, which is echoed normalised", async () => {
    const decimal = fc
      .tuple(fc.nat({ max: 999_999 }), fc.stringMatching(/^[0-9]{0,14}$/), fc.boolean())
      .map(([whole, fraction, negative]) => ({
        raw: `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`,
        whole,
        fraction,
        negative,
      }))
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: -5, max: 1_000_000 }).map((amount) => ({ unit_amount: amount })),
          decimal.map((d) => ({ unit_amount_decimal: d.raw, d })),
        ),
        async (input) => {
          const c = client()
          const product = id(await created(c.post("/v1/products", { name: "p" })))
          const body = {
            product,
            currency: "usd",
            ...("d" in input ? { unit_amount_decimal: input.unit_amount_decimal } : input),
          }
          const reply = await c.post("/v1/prices", body)
          if ("d" in input) {
            const { whole, fraction, negative } = input.d
            const trimmed = fraction.replace(/0+$/, "")
            const zero = whole === 0 && trimmed === ""
            if (fraction.length > 12) {
              expect(reply.status).toBe(400)
              expect(error(reply).message).toContain("must contain at most 12 decimal places")
              return
            }
            if (negative && !zero) {
              expect(reply.status).toBe(400)
              expect(error(reply).message).toContain("must be greater than or equal to 0")
              return
            }
            expect(reply.status).toBe(200)
            const expected = trimmed === "" ? String(whole) : `${whole}.${trimmed}`
            expect(reply.body.unit_amount_decimal).toBe(expected)
            expect(reply.body.unit_amount).toBe(trimmed === "" ? whole : null)
          } else {
            if (input.unit_amount < 0) {
              expect(reply.status).toBe(400)
              expect(error(reply).param).toBe("unit_amount")
              return
            }
            expect(reply.status).toBe(200)
            expect(reply.body.unit_amount).toBe(input.unit_amount)
            expect(reply.body.unit_amount_decimal).toBe(String(input.unit_amount))
          }
          expect(reply.body.type).toBe("one_time")
          expect((await c.get(`/v1/prices/${id(reply)}`)).body).toEqual(reply.body)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 60 },
    )
  })

  test("inline product_data creates the product the price points at, atomically", async () => {
    await fc.assert(
      fc.asyncProperty(name, fc.boolean(), async (productName, broken) => {
        const c = client()
        const before = ids(await c.get("/v1/products", { limit: 100 }))
        const reply = await c.post("/v1/prices", {
          product_data: { name: productName, ...(broken ? { statement_descriptor: "<bad>" } : {}) },
          currency: "usd",
          unit_amount: 100,
        })
        if (broken) {
          expect(reply.status).toBe(400)
          expect(error(reply).param).toBe("product_data[statement_descriptor]")
          expect(ids(await c.get("/v1/products", { limit: 100 }))).toEqual(before)
          return
        }
        expect(reply.status).toBe(200)
        const product = await c.get(`/v1/products/${reply.body.product as string}`)
        expect(product.status).toBe(200)
        expect(product.body.name).toBe(productName.trim())
        expect(ids(await c.get("/v1/prices", { product: reply.body.product }))).toEqual([id(reply)])
      }),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })
})

describe("Stripe request envelope", () => {
  const route = fc.constantFrom(
    "/v1/customers",
    "/v1/products",
    "/v1/prices",
    "/v1/customers/cus_x",
    "/v1/products/prod_x",
    "/v1/prices/price_x",
  )

  test("every request without an API key is refused with Stripe's 401 before anything else runs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("GET", "POST", "DELETE"),
        fc.oneof(route, fc.stringMatching(/^\/v1\/[a-z]{1,8}$/)),
        async (method, path) => {
          const c = client()
          const response = await c.api.fetch(new Request(`${HOST}${path}`, { method }))
          expect(response.status).toBe(401)
          const body = (await response.json()) as Json
          expect(error({ status: 401, body }).message).toMatch(/^You did not provide an API key/)
          expect(error({ status: 401, body }).type).toBe("invalid_request_error")
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })

  test("paths outside the contract answer Stripe's 404 envelope, and error bodies always carry a request log url", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^\/v1\/[a-z]{1,8}(\/[a-z0-9_]{1,8})?$/),
        route,
        async (unknownPath, knownPath) => {
          const c = client()
          const unknown = await c.get(unknownPath)
          const known = await c.get(knownPath)
          if (known.status === 200) {
            expect(unknown.status).toBe(404)
            expect(error(unknown).message).toMatch(/^Unrecognized request URL \(GET: /)
          }
          for (const reply of [unknown, known]) {
            if (reply.status === 200) continue
            expect(error(reply).request_log_url).toMatch(/^https:\/\/dashboard\.stripe\.com\//)
            expect(Object.keys(error(reply))).toEqual([...Object.keys(error(reply))].sort())
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  })
})
