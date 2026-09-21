import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, MakorCpgAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.makor-cpg.local"
const now = () => 1_700_000_000_000
const auth = { "x-api-key": "mk-parity" }

describe("MakorCpgAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new MakorCpgAPI({ now })
      const report = await parity({
        provider: "makor-cpg",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new MakorCpgAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 150, 150),
        maxCommands: 20,
        // Summary reads and review scripts need a user produced by an earlier summary generation.
        weights: {
          GenerateUserSummary: 2,
          GenerateReviewScript: 3,
          GetReviewScript: 3,
          RegenerateReviewScript: 3,
        },
        coverageBias: 3,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, including generation and the webhook, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new MakorCpgAPI({ now })
          const faulty = () => {
            const api = new MakorCpgAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 202) return response
                // The bloodwork webhook acknowledges with a different message.
                return Response.json({ message: "diverged" }, { status: 202 })
              },
            }
          }
          const failure = await parity({
            provider: "makor-cpg",
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
            only: ["BloodworkResultsReceived"],
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            latencyToleranceMs: 1_000,
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
