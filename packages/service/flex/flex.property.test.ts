import { describe, expect, test } from "bun:test"
import { listOperations } from "@crvouga/mockingbird-openapi"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, FlexAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.flex.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer fsk_test_parity" }

/** Every operation self-parity walks: the JSON API (the hosted page is HTML, parity-disabled). */
const parityOperations = listOperations(document)
  .filter((operation) => operationMetadata(operation.operation).parity.enabled)
  .map((operation) => operation.operationId)
  .sort()

describe("FlexAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new FlexAPI({ now })
      const report = await parity({
        provider: "flex",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new FlexAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 40,
        maxCommands: 20,
        coverageBias: 4,
        // Session create is the richest operation (modes, line items, customers): walk it more.
        weights: { CreateCheckoutSession: 4, GetCheckoutSession: 2, RefundCheckoutSession: 2 },
        // Both sides share one scheduler; a GC pause on a loaded machine is not a divergence.
        latencyToleranceMs: 5_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(parityOperations).toHaveLength(10)
      // Every JSON operation, including session create and refund, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual(parityOperations)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new FlexAPI({ now })
          const faulty = () => {
            const api = new FlexAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (new URL(request.url).pathname !== "/v1/products" || request.method !== "GET") {
                  return response
                }
                const body = (await response.json()) as { products: { active: boolean }[] }
                body.products[0] = { ...body.products[0], active: false } as never
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "flex",
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
            only: ["ListProducts"],
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
