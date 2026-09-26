import { describe, expect, test } from "bun:test"
import { encodeForm } from "@crvouga/mockingbird-http-codec"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { StripeAPI } from "./src/index.js"

/**
 * Stripe's idempotency layer (https://docs.stripe.com/api/idempotent_requests): the first
 * response for an `Idempotency-Key` on a POST is stored and replayed for identical retries,
 * reusing the key with different parameters is an `idempotency_error`, and GET/DELETE ignore it.
 */

const params = fcParameters(process.env)
const HOST = "https://mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }
const now = () => 1_700_000_000_000

type Json = Record<string, unknown>

const send = async (
  api: StripeAPI,
  method: string,
  path: string,
  form: Record<string, unknown> | undefined,
  key: string | undefined,
) => {
  const response = await api.fetch(
    new Request(`${HOST}${path}`, {
      method,
      headers: {
        ...AUTH,
        ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      ...(form === undefined ? {} : { body: encodeForm(form) }),
    }),
  )
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replayed"),
    text: await response.text(),
  }
}

const KEYS = ["k-1", "k-2", "k-3"]
const step = fc.record({
  key: fc.option(fc.constantFrom(...KEYS), { nil: undefined }),
  path: fc.constantFrom("/v1/customers", "/v1/products"),
  body: fc.oneof(
    fc.record({ name: fc.stringMatching(/^[a-z]{1,6}$/) }),
    fc.constant({ name: "" }),
    fc.constant({}),
  ),
})

describe("Idempotency-Key", () => {
  test("POST replays the first response for the same request and refuses the key for a different one", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const api = new StripeAPI({ now })
        const first = new Map<string, { fingerprint: string; status: number; text: string }>()
        for (const item of steps) {
          const fingerprint = `${item.path} ${encodeForm(item.body)}`
          const reply = await send(api, "POST", item.path, item.body, item.key)
          const seen = item.key === undefined ? undefined : first.get(item.key)
          if (seen === undefined) {
            expect(reply.replayed).toBeNull()
            expect(reply.status).toBeLessThan(500)
            if (item.key !== undefined)
              first.set(item.key, { fingerprint, status: reply.status, text: reply.text })
            continue
          }
          if (seen.fingerprint === fingerprint) {
            expect(reply.replayed).toBe("true")
            expect(reply.status).toBe(seen.status)
            expect(reply.text).toBe(seen.text)
          } else {
            expect(reply.status).toBe(400)
            const error = (JSON.parse(reply.text) as { error: Json }).error
            expect(error.type).toBe("idempotency_error")
            expect(error.message).toBe(
              `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${item.key}' if you meant to execute a different request.`,
            )
          }
        }
        // A replayed (or refused) create must not have created a second object; every customer
        // body here is valid (`name=""` just leaves the name unset), so each first use creates one.
        const customers = (
          JSON.parse(
            (await send(api, "GET", "/v1/customers?limit=100", undefined, undefined)).text,
          ) as { data: Json[] }
        ).data
        const createdCustomers = steps.filter(
          (item, index) =>
            item.path === "/v1/customers" &&
            !(
              item.key !== undefined &&
              steps.slice(0, index).some((prior) => prior.key === item.key)
            ),
        )
        expect(customers.length).toBe(createdCustomers.length)
      }),
      { ...params, numRuns: params.numRuns ?? 60 },
    )
  })

  test("GET and DELETE ignore the header, and reset forgets every key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KEYS),
        fc.stringMatching(/^[a-z]{1,6}$/),
        async (key, name) => {
          const api = new StripeAPI({ now })
          const create = await send(api, "POST", "/v1/customers", { name }, key)
          const { id } = JSON.parse(create.text) as { id: string }
          const read = await send(api, "GET", `/v1/customers/${id}`, undefined, key)
          expect(read.status).toBe(200)
          expect(read.replayed).toBeNull()
          const remove = await send(api, "DELETE", `/v1/customers/${id}`, undefined, key)
          expect(remove.status).toBe(200)
          expect(remove.replayed).toBeNull()
          const removeAgain = await send(api, "DELETE", `/v1/customers/${id}`, undefined, key)
          expect(removeAgain.status).toBe(404)
          await api.reset()
          const fresh = await send(api, "POST", "/v1/products", { name }, key)
          expect(fresh.status).toBe(200)
          expect(fresh.replayed).toBeNull()
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })
})
