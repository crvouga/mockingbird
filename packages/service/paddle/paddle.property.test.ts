import { describe, expect, test } from "bun:test"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, PaddleAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.paddle.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer pdl_sdbx_apikey_parity" }

/**
 * Both sides start from the same fixture account: subscriptions only come from paid
 * transactions (the admin routes), so a walk discovers them through `ListSubscriptions`. One
 * instance per side is reset and reseeded between walks (a fresh SQLite per walk is what makes
 * long runs slow).
 */
const seeded = () => {
  const api = new PaddleAPI({ now })
  api.seedFixtures()
  return api
}
const reseed = async (api: PaddleAPI) => {
  await api.reset()
  api.seedFixtures()
  return api
}

/**
 * Lists surface the fixtures (and are cheap), transactions are the scarcest resource, and the
 * operations whose optional references make them eligible late in a walk get a nudge.
 */
const WEIGHTS = {
  ListCustomers: 3,
  ListAddresses: 4,
  ListBusinesses: 4,
  ListProducts: 2,
  ListPrices: 3,
  ListTransactions: 6,
  ListSubscriptions: 6,
  CreateCustomer: 2,
  CreateAddress: 3,
  CreateBusiness: 3,
  CreatePrice: 2,
  CreateTransaction: 6,
  GetTransaction: 4,
  UpdateTransaction: 8,
  GetTransactionInvoice: 3,
  GetSubscription: 3,
  UpdateSubscription: 6,
  ActivateSubscription: 3,
  PauseSubscription: 2,
  ResumeSubscription: 3,
  CancelSubscription: 3,
  CreateSubscriptionCharge: 4,
  PreviewTransaction: 5,
  GetAddress: 3,
  GetBusiness: 2,
  UpdateAddress: 2,
  UpdateBusiness: 2,
}

/** Every parity-enabled operation. */
const parityOperations = Object.values(document.paths ?? {})
  .flatMap((item) => Object.values(item as Record<string, unknown>))
  .filter((operation): operation is { operationId: string } =>
    Boolean((operation as { operationId?: string }).operationId),
  )
  .filter((operation) => operationMetadata(operation as never).parity.enabled)
  .map((operation) => operation.operationId)
  .sort()

describe("PaddleAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = seeded()
      const mock = seeded()
      const report = await parity({
        provider: "paddle",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => reseed(mock),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reseed(reference)
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 300, 300),
        maxCommands: 100,
        coverageBias: 3,
        weights: WEIGHTS,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(parityOperations).toHaveLength(37)
      expect(Object.keys(report.exercised).sort()).toEqual(parityOperations)
    },
    { timeout: 180_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = seeded()
          const faulty = () => {
            const api = seeded()
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (request.method !== "GET" || response.status !== 200) return response
                const body = (await response.json()) as { data: { email?: string } }
                if (!body.data.email) return Response.json(body)
                return Response.json({
                  ...body,
                  data: { ...body.data, email: "diverged@example.com" },
                })
              },
            }
          }
          const failure = await parity({
            provider: "paddle",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => auth,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => auth },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["CreateCustomer", "GetCustomer"],
            includeUnsafe: true,
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            sleep: async () => {},
            log: () => {},
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )
})
