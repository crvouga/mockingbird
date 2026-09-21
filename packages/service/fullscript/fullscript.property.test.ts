import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  document,
  FullscriptAPI,
  issueAccessToken,
  type SeedOrder,
  supportedOperationIds,
} from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.fullscript.local"
const now = () => 1_700_000_000_000
const orders: SeedOrder[] = [
  { id: "lo_seed_1", patientId: "pat_seed_1", state: "results_ready" },
  { id: "lo_seed_2", patientId: "pat_seed_1", state: "processing" },
  { id: "lo_seed_3", patientId: "pat_seed_2", state: "partial_results" },
]
const create = () => new FullscriptAPI({ now, orders })
// Access tokens are self-describing and signed deterministically: both instances accept it.
const token = issueAccessToken(
  {
    clientId: "parity-client",
    practitionerId: "prac_mock_1",
    clinicId: "clinic_mock_1",
    type: "Practitioner",
  },
  now() / 1000,
)
const auth = { authorization: `Bearer ${token}`, accept: "application/json" }
// The consent redirect and the binary PDF are parity-disabled (see openapi.yaml).
const browserOnly = ["Authorize", "GetResultPdf"]

describe("FullscriptAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = create()
      const report = await parity({
        provider: "fullscript",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: { create, baseUrl: `https://${MOCK_HOST}`, headers: () => auth },
        cleanup: async () => {
          await reference.reset()
          for (const order of orders) reference.seedOrder(order)
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 60,
        maxCommands: 30,
        coverageBias: 4,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(Object.keys(report.exercised).sort()).toEqual(
        supportedOperationIds.filter((id) => !browserOnly.includes(id)).sort(),
      )
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = create()
          const faulty = () => {
            const api = create()
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = (await response.json()) as { clinic: Record<string, unknown> }
                return Response.json(
                  { clinic: { ...body.clinic, name: "diverged" } },
                  { status: 200 },
                )
              },
            }
          }
          const failure = await parity({
            provider: "fullscript",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => auth,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => auth },
            only: ["GetClinic"],
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
