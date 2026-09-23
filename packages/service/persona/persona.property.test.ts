import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, PersonaAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.persona.local"
const now = () => 1_700_000_000_000
const auth = () => ({
  authorization: "Bearer persona_sandbox_parity",
  "persona-version": "2023-01-05",
})
/** The operations random walks can reach (the hosted flow pages are browser-only). */
const PARITY_OPS = ["CreateInquiry", "GetInquiry", "ListInquiries"]

describe("PersonaAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new PersonaAPI({ now })
      const report = await parity({
        provider: "persona",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new PersonaAPI({ now }),
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
      expect(Object.keys(report.exercised).sort()).toEqual(PARITY_OPS)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new PersonaAPI({ now })
          const faulty = () => {
            const api = new PersonaAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (request.method !== "POST" || response.status !== 201) return response
                const body = (await response.json()) as { data: { attributes: { status: string } } }
                body.data.attributes.status = "pending"
                return Response.json(body, { status: 201 })
              },
            }
          }
          const failure = await parity({
            provider: "persona",
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
            only: ["CreateInquiry"],
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
