import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, PrismAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.prism.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer prism-parity", accept: "application/json;v=1" }

describe("PrismAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new PrismAPI({ now })
      const report = await parity({
        provider: "prism",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new PrismAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 60, 60),
        maxCommands: 30,
        coverageBias: 4,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // The presigned upload and asset downloads are binary and parity-disabled (see openapi.yaml);
      // the acceptance tests cover them.
      const binary = ["GetAsset", "UploadCapture"]
      expect(Object.keys(report.exercised).sort()).toEqual(
        supportedOperationIds.filter((id) => !binary.includes(id)).sort(),
      )
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new PrismAPI({ now })
          const faulty = () => {
            const api = new PrismAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status >= 300) return response
                const body = (await response.json()) as { total_count: number }
                return Response.json(
                  { ...body, total_count: body.total_count + 1 },
                  { status: 200 },
                )
              },
            }
          }
          const failure = await parity({
            provider: "prism",
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
            only: ["UpsertUser"],
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
