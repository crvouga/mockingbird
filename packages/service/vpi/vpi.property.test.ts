import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, supportedOperationIds, VpiAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.vpi.local"
const now = () => 1_700_000_000_000

/** A JWT both instances accept: tokens are self-describing and signed deterministically. */
const token = async () => {
  const response = await new VpiAPI({ now }).fetch(
    new Request(`https://${MOCK_HOST}/accounts/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "parity@example.com", password: "parity" }),
    }),
  )
  return ((await response.json()) as { jwtToken: string }).jwtToken
}

describe("VpiAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const auth = { authorization: `Bearer ${await token()}` }
      const reference = new VpiAPI({ now })
      const report = await parity({
        provider: "vpi",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new VpiAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        // Patients and products are discovered through the roster and category listings.
        weights: {
          GetProductsByCategory: 5,
          GetPatientsInClinic: 5,
          SaveNewPrescription: 3,
          GetShippingRate: 3,
          CheckProviderSignatureNeededDuplicate: 3,
        },
        coverageBias: 4,
        numRuns: params.numRuns ?? 100,
        maxCommands: 30,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, including saveNewPrescription, is reached by the walks.
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
          const reference = new VpiAPI({ now })
          const faulty = () => {
            const api = new VpiAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/getShippingStates")) return response
                const body = (await response.json()) as {
                  data: { states: { name: string }[] }[]
                }
                const states = body.data[0]?.states ?? []
                states[0] = { ...states[0], name: "Narnia" } as never
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "vpi",
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
            only: ["GetShippingStates"],
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
