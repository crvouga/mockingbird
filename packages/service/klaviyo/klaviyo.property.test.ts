import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, KLAVIYO_REVISION, KlaviyoAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.klaviyo.local"
const now = () => 1_700_000_000_000
const headers = () => ({
  authorization: "Klaviyo-API-Key pk_parity",
  revision: KLAVIYO_REVISION,
})

describe("KlaviyoAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new KlaviyoAPI({ now })
      const report = await parity({
        provider: "klaviyo",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: { create: () => new KlaviyoAPI({ now }), baseUrl: `https://${MOCK_HOST}`, headers },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 10_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
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
          const reference = new KlaviyoAPI({ now })
          const faulty = () => {
            const api = new KlaviyoAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                // Swallow every event: the list the suite reads back stays empty.
                if (request.method === "POST") return new Response(null, { status: 202 })
                return response
              },
            }
          }
          const failure = await parity({
            provider: "klaviyo",
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
            only: ["CreateEvent", "GetEvents"],
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
