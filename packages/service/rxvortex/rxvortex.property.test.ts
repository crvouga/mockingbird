import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, RxVortexAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.rxvortex.local"
const now = () => 1_700_000_000_000

/** A token both instances accept: tokens are self-describing and signed deterministically. */
const token = async () => {
  const response = await new RxVortexAPI({ now }).fetch(
    new Request(`https://${MOCK_HOST}/api/v1/generate-access-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "parity", client_secret: "parity" }),
    }),
  )
  return ((await response.json()) as { access_token: string }).access_token
}

describe("RxVortexAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const auth = { authorization: `Bearer ${await token()}` }
      const reference = new RxVortexAPI({ now })
      const report = await parity({
        provider: "rxvortex",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new RxVortexAPI({ now }),
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
      // Every operation, including order create/cancel, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      const auth = { authorization: `Bearer ${await token()}` }
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new RxVortexAPI({ now })
          const faulty = () => {
            const api = new RxVortexAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/preset-catalog-items"))
                  return response
                const body = (await response.json()) as { data: { medication_name: string }[] }
                body.data[0] = { ...body.data[0], medication_name: "diverged" } as never
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "rxvortex",
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
            only: ["ListPresetCatalogItems"],
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
