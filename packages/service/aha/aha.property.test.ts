import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { AhaAPI, document, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.aha.local"
const now = () => 1_700_000_000_000

/**
 * HMAC-mode headers. With no credentials configured the mock checks the signature's shape
 * and the timestamp window only, so both instances accept the same headers.
 */
const auth = () => ({
  "x-api-key": "acme_aha_parity",
  "x-timestamp": String(Date.now()),
  "x-signature": Buffer.alloc(32, 7).toString("base64"),
})

describe("AhaAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new AhaAPI({ now })
      const report = await parity({
        provider: "aha",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new AhaAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: auth,
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
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "self-parity holds in the wrapped envelope too",
    async () => {
      const settings = { envelope: "wrapped" as const }
      const reference = new AhaAPI({ now, settings })
      const report = await parity({
        provider: "aha",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new AhaAPI({ now, settings }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 10,
        maxCommands: 12,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new AhaAPI({ now })
          const faulty = () => {
            const api = new AhaAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = (await response.json()) as { message: string }
                return Response.json({ ...body, message: "diverged" }, { status: 200 })
              },
            }
          }
          const failure = await parity({
            provider: "aha",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: auth,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: auth },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["CreateOrder"],
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
