import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, OtelAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.otel.local"
const now = () => 1_700_000_000_000

/**
 * The receiver takes a bearer token and O2 takes Basic auth, so each request gets the
 * credential its route expects (parity's static headers can carry only one).
 */
const withAuth = (request: Request): Request => {
  const headers = new Headers(request.headers)
  headers.set(
    "authorization",
    new URL(request.url).pathname.startsWith("/v1/")
      ? "Bearer parity-ingest-token"
      : `Basic ${btoa("parity:parity")}`,
  )
  return new Request(request, { headers })
}

const authed = (api: OtelAPI) => ({ fetch: (request: Request) => api.fetch(withAuth(request)) })

describe("OtelAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new OtelAPI({ now })
      const report = await parity({
        provider: "otel",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => authed(reference).fetch(request),
        },
        mock: {
          create: () => authed(new OtelAPI({ now })),
          baseUrl: `https://${MOCK_HOST}`,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 30,
        maxCommands: 25,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, receiver and search alike, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new OtelAPI({ now })
          const faulty = () => {
            const api = authed(new OtelAPI({ now }))
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/organizations")) return response
                const body = (await response.json()) as { data: { name: string }[] }
                body.data[0] = { ...body.data[0], name: "diverged" } as never
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "otel",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              fetch: (r) => authed(reference).fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}` },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["ListOrganizations"],
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
