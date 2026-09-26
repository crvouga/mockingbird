import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { Database } from "@crvouga/sqlite-mem"
import fc from "fast-check"
import { document, StripeAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)

const MOCK_HOST = "mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }
const now = () => 1_700_000_000_000

/**
 * Walk shape shared by every self-parity run. Mirrors `scripts/parity.ts` so a divergence found
 * here reproduces there with the same seed:
 * - producers weighted up so walks accumulate customers, products and prices early;
 * - coverage bias so every operation is reached within a walk instead of only the cheap ones;
 * - deletions tracked so later references deliberately hit tombstoned customers and gone
 *   products (404s, 400s and the deleted-customer shape);
 * - a third of bodies violate one schema constraint, so every validation branch is compared.
 */
const WALK = {
  maxCommands: 40,
  coverageBias: 10,
  weights: { PostCustomers: 3, PostProducts: 4, PostPrices: 4 },
  deletionTypes: { DeleteCustomersCustomer: ["customer"], DeleteProductsId: ["product"] },
  invalidProbability: 0.35,
  missingProbability: 0.15,
  deletedRefProbability: 0.3,
  /**
   * Both sides are the same implementation on one scheduler, so latency here only measures GC
   * and OS noise; the gate exists for live parity and is effectively disabled for self-parity.
   */
  latencyToleranceMs: 1_000,
} as const

/** Every operation must run several times per suite, or the walk shape has regressed. */
const MIN_HITS_PER_OPERATION = 3
/** Ineligible commands are skipped, so the executed depth is what matters, not `maxCommands`. */
const MIN_MEAN_OPERATIONS_PER_WALK = 8

/**
 * Two independent StripeAPI instances given the same random walk must behave identically after
 * canonicalization, and every response must conform to the vendored OpenAPI contract. This is
 * the network-free half of the differential suite; `parity.ts` runs the same walks against Stripe.
 */
describe("StripeAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new StripeAPI({ now })
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
          create: () => new StripeAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        numRuns: params.numRuns ?? 150,
        ...WALK,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(report.planned.sort()).toEqual([...supportedOperationIds].sort())
      for (const operationId of supportedOperationIds)
        expect(report.exercised[operationId] ?? 0).toBeGreaterThanOrEqual(MIN_HITS_PER_OPERATION)
      expect(report.operations / report.walks).toBeGreaterThanOrEqual(MIN_MEAN_OPERATIONS_PER_WALK)
    },
    { timeout: 120_000 },
  )

  test(
    "self-parity with an injected sqlite-mem client",
    async () => {
      const reference = new StripeAPI({ sqlite: new Database(), now })
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
          create: () => new StripeAPI({ sqlite: new Database(), now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        numRuns: params.numRuns ?? 20,
        ...WALK,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
    },
    { timeout: 60_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new StripeAPI({ now })
          const faulty = () => {
            const api = new StripeAPI({ now })
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
    },
    { timeout: 30_000 },
  )

  test("state is isolated per namespace and reset clears only Stripe", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,19}$/), async (name) => {
        const sqlite = new Database()
        const stripe = new StripeAPI({ sqlite, now })
        sqlite
          .prepare(
            `INSERT INTO mockingbird_records (namespace, collection, id, seq, value)
             VALUES ('other', 'keep', '1', 1, ?)`,
          )
          .run(JSON.stringify({ seq: 1, value: "keep" }))
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
        const other = sqlite
          .prepare(
            "SELECT value FROM mockingbird_records WHERE namespace = 'other' AND collection = 'keep' AND id = '1'",
          )
          .get<{ value: string }>()
        expect(other).toBeDefined()
      }),
      { ...params, numRuns: 10 },
    )
  })
})
