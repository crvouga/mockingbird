import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, GoogleMapsAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.maps.googleapis.local"
const now = () => 1_700_000_000_000

/** Every operation the random walks may reach (the JS shim is parity-disabled). */
const PARITY_OPERATIONS = supportedOperationIds.filter((id) => id !== "MapsJavaScriptApi")

describe("GoogleMapsAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new GoogleMapsAPI({ now })
      const report = await parity({
        provider: "google-maps",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => reference.fetch(request),
        },
        mock: { create: () => new GoogleMapsAPI({ now }), baseUrl: `https://${MOCK_HOST}` },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(Object.keys(report.exercised).sort()).toEqual([...PARITY_OPERATIONS].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new GoogleMapsAPI({ now })
          const faulty = () => {
            const api = new GoogleMapsAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/geocode/json")) return response
                // Rewrite Google's status: the first field our consumer reads.
                const body = (await response.json()) as Record<string, unknown>
                return Response.json(
                  { ...body, status: "UNKNOWN_ERROR" },
                  { status: response.status },
                )
              },
            }
          }
          const failure = await parity({
            provider: "google-maps",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}` },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["Geocode"],
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
