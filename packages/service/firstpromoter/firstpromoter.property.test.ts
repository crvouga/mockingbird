import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, FirstPromoterAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.firstpromoter.local"
const now = () => 1_700_000_000_000
// The v1 routes authenticate with X-API-KEY; v2 ignores it, so every walk sends both.
const headers = () => ({
  authorization: "Bearer fp_parity",
  "account-id": "acc_parity",
  "x-api-key": "fp_parity_v1",
})
// The legacy v1 routes are parity-disabled for the live oracle (no v1 credentials) but are still
// walked here, so self-parity and response-schema checks cover them.
const V1_OPERATIONS = supportedOperationIds.filter((id) => id.startsWith("V1"))

describe("FirstPromoterAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new FirstPromoterAPI({ now })
      const options: Parameters<typeof parity>[0] = {
        provider: "firstpromoter",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new FirstPromoterAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        forceInclude: V1_OPERATIONS,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 10_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      }
      const report = await parity(options)
      // Random walks may miss a reachable operation. Supplement coverage with a
      // reproducible walk without retrying or suppressing any parity mismatch.
      if (supportedOperationIds.some((id) => !report.exercised[id])) {
        const coverage = await parity({ ...options, seed: 0, numRuns: 100 })
        Object.assign(report.exercised, coverage.exercised)
      }
      expect(report.walks).toBeGreaterThan(0)
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new FirstPromoterAPI({ now })
          const faulty = () => {
            const api = new FirstPromoterAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                // Report every promoter without a campaign: our client would find no ref_link.
                if (request.method !== "POST" || response.status !== 200) return response
                const body = (await response.json()) as Record<string, unknown>
                return Response.json({ ...body, promoter_campaigns: [] }, { status: 200 })
              },
            }
          }
          const failure = await parity({
            provider: "firstpromoter",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["CreatePromoter"],
            includeUnsafe: true,
            numRuns: 30,
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
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )
})
