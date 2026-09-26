import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  document,
  GoogleCalendarAPI,
  issueAccessToken,
  supportedOperationIds,
} from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.gcal.local"
const now = () => 1_700_000_000_000
/** Tokens are self-describing and deterministically signed, so every instance accepts them. */
const auth = { authorization: `Bearer ${issueAccessToken("parity@example.com", now() / 1000)}` }

describe("GoogleCalendarAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new GoogleCalendarAPI({ now })
      const report = await parity({
        provider: "google-calendar",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new GoogleCalendarAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 120, 120),
        maxCommands: 30,
        coverageBias: 4,
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
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new GoogleCalendarAPI({ now })
          const faulty = () => {
            const api = new GoogleCalendarAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = (await response.json()) as { total_count: number }
                return Response.json(
                  { ...body, total_count: body.total_count + 1 },
                  { status: 200 },
                )
              },
            }
          }
          const failure = await parity({
            provider: "google-calendar",
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
            only: ["CalendarListList"],
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
