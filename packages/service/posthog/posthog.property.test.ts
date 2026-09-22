import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, type FlagSpec, PostHogAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.posthog.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer phx_parity" }

/** Seed flags so random `/flags` and `/decide` walks answer non-empty maps. */
const flags: Record<string, FlagSpec> = {
  "on-flag": { default: true, payload: '{"a":1}', overrides: [] },
  "off-flag": { default: false, payload: null, overrides: [] },
  "variant-flag": { default: "control", payload: null, overrides: [] },
}

describe("PostHogAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new PostHogAPI({ now, flags })
      const report = await parity({
        provider: "posthog",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new PostHogAPI({ now, flags }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
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
      // Every operation, including capture and flag create/patch, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new PostHogAPI({ now, flags })
          const faulty = () => {
            const api = new PostHogAPI({ now, flags })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                // A mock that forgets the absent-vs-false distinction.
                const body = (await response.json()) as { flags?: Record<string, unknown> }
                if (body.flags && "off-flag" in body.flags) delete body.flags["off-flag"]
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "posthog",
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
            only: ["EvaluateFlags"],
            numRuns: 20,
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
