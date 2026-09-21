import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { CustomerIoAPI, document, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.customerio.local"
const now = () => 1_700_000_000_000

/**
 * The CDP host takes `Basic <write key>:` and the App API host `Bearer <app key>`; one parity
 * base URL serves both here, so the credential is chosen per path.
 */
const authed = (api: { fetch: (r: Request) => Promise<Response> }) => ({
  fetch: (request: Request) => {
    const headers = new Headers(request.headers)
    const path = new URL(request.url).pathname
    if (/^\/v1\/(identify|track|batch)$/.test(path)) {
      headers.set("authorization", `Basic ${btoa("cdp_write_key:")}`)
    } else if (path.startsWith("/v1/")) {
      headers.set("authorization", "Bearer app_api_key")
    }
    return api.fetch(new Request(request, { headers }))
  },
})

describe("CustomerIoAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new CustomerIoAPI({ now })
      const real = authed(reference)
      const report = await parity({
        provider: "customerio",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => real.fetch(request),
        },
        mock: { create: () => authed(new CustomerIoAPI({ now })), baseUrl: `https://${MOCK_HOST}` },
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
          const reference = authed(new CustomerIoAPI({ now }))
          const faulty = () => {
            const api = authed(new CustomerIoAPI({ now }))
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/v1/transactional")) return response
                const body = (await response.json()) as { messages: { trigger_name: string }[] }
                body.messages[0] = { ...body.messages[0], trigger_name: "diverged" } as never
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "customerio",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}` },
            only: ["ListTransactionalMessages"],
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
