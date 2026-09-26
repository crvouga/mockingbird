import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { DEFAULT_SETTINGS, document, HealthieAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.healthie.local"
const now = () => 1_700_000_000_000
/** The seeded organization key: both instances resolve it to the same org admin. */
const auth = {
  authorization: `Bearer ${DEFAULT_SETTINGS.orgApiKeys[0]}`,
  authorizationsource: "API",
}

describe("HealthieAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new HealthieAPI({ now })
      const report = await parity({
        provider: "healthie",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new HealthieAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        // GraphQL carries every document; downloads with random tokens only exercise the 403s.
        weights: { Graphql: 6, DownloadFile: 1 },
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Both the GraphQL endpoint and the file download route are reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new HealthieAPI({ now })
          const faulty = () => {
            const api = new HealthieAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/graphql")) return response
                const body = (await response.json()) as { data?: Record<string, unknown> | null }
                // A mock that forgets `errors` never diverges on `data`; flip every payload.
                return Response.json(
                  { ...body, data: { diverged: true } },
                  { status: response.status },
                )
              },
            }
          }
          const failure = await parity({
            provider: "healthie",
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
            only: ["Graphql"],
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
