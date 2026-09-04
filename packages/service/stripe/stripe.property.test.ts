import { describe, expect, test } from "bun:test"
import { MemoryKV } from "@crvouga/mockingbird-kv-memory"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, StripeAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)

const MOCK_HOST = "mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }

/**
 * Two independent StripeAPI instances given the same random walk must behave identically after
 * canonicalization, and every response must conform to the vendored OpenAPI contract. This is
 * the network-free half of the differential suite; `parity.ts` runs the same walks against Stripe.
 */
describe("StripeAPI", () => {
  test("self-parity: independent instances agree on every random walk and conform to the spec", async () => {
    const reference = new StripeAPI({ kv: new MemoryKV(), now: () => 1_700_000_000_000 })
    const report = await parity({
      provider: "stripe",
      spec: document,
      real: {
        baseUrl: `https://${MOCK_HOST}`,
        allowedHosts: [MOCK_HOST],
        headers: () => AUTH,
        fetch: (request) => reference.fetch(request),
      },
      mock: {
        create: () => new StripeAPI({ kv: new MemoryKV(), now: () => 1_700_000_000_000 }),
        baseUrl: `https://${MOCK_HOST}`,
        headers: () => AUTH,
      },
      cleanup: async () => {
        await reference.reset()
      },
      numRuns: params.numRuns ?? 40,
      maxCommands: 25,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      env: process.env,
      sleep: async () => {},
      log: () => {},
    })
    expect(report.walks).toBeGreaterThan(0)
    expect(new Set(Object.keys(report.exercised)).size).toBeGreaterThan(
      supportedOperationIds.length / 2,
    )
  })

  test("a deliberately divergent instance is caught and shrunk", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (seed) => {
        const reference = new StripeAPI({ kv: new MemoryKV(), now: () => 1_700_000_000_000 })
        const faulty = () => {
          const api = new StripeAPI({ kv: new MemoryKV(), now: () => 1_700_000_000_000 })
          return {
            fetch: async (request: Request) => {
              const response = await api.fetch(request)
              if (
                request.method !== "POST" ||
                !new URL(request.url).pathname.endsWith("/v1/customers")
              )
                return response
              const body = (await response.json()) as Record<string, unknown>
              return Response.json(
                { ...body, balance: 1 },
                { status: response.status, headers: { "content-type": "application/json" } },
              )
            },
          }
        }
        const failure = await parity({
          provider: "stripe",
          spec: document,
          real: {
            baseUrl: `https://${MOCK_HOST}`,
            allowedHosts: [MOCK_HOST],
            headers: () => AUTH,
            fetch: (r) => reference.fetch(r),
          },
          mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => AUTH },
          cleanup: async () => {
            await reference.reset()
          },
          only: ["PostCustomers"],
          numRuns: 20,
          maxCommands: 6,
          seed,
          invalidProbability: 0,
          sleep: async () => {},
          log: () => {},
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(ParityError)
        const error = failure as ParityError
        expect(error.details.kind).toBe("mismatch")
        expect(error.details.history.length).toBeLessThanOrEqual(1)
      }),
      { ...params, numRuns: 3 },
    )
  })

  test("state is isolated per namespace and reset clears only Stripe", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (name) => {
        const kv = new MemoryKV()
        await kv.set("other", new TextEncoder().encode("keep"))
        const stripe = new StripeAPI({ kv })
        const created = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers`, {
            method: "POST",
            headers: { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ name }),
          }),
        )
        expect(created.status).toBe(200)
        const { id } = (await created.json()) as { id: string }
        const fetched = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers/${id}`, { headers: AUTH }),
        )
        expect(((await fetched.json()) as { name: string }).name).toBe(name)
        await stripe.reset()
        const gone = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers/${id}`, { headers: AUTH }),
        )
        expect(gone.status).toBe(404)
        expect(new TextDecoder().decode(await kv.get("other"))).toBe("keep")
      }),
      { ...params, numRuns: 10 },
    )
  })
})
