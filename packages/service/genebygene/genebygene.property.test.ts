import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, GeneByGeneAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.genebygene.local"
const AUTH = { authorization: "Bearer mockingbird" }
const now = () => 1_700_000_000_000

describe("GeneByGeneAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new GeneByGeneAPI({ now })
      const report = await parity({
        provider: "genebygene",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => AUTH,
          fetch: async (request) => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return reference.fetch(request)
          },
        },
        mock: {
          create: () => new GeneByGeneAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        numRuns: params.numRuns ?? 20,
        maxCommands: 15,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(new Set(Object.keys(report.exercised)).size).toBeGreaterThan(
        supportedOperationIds.length / 2,
      )
    },
    { timeout: 30_000 },
  )

  test("a deliberately divergent instance is caught and shrunk", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (seed) => {
        const reference = new GeneByGeneAPI({ now })
        const faulty = () => {
          const api = new GeneByGeneAPI({ now })
          return {
            fetch: async (request: Request) => {
              const response = await api.fetch(request)
              if (!new URL(request.url).pathname.endsWith("/api/v2/products")) return response
              const body = (await response.json()) as unknown[]
              return Response.json([{ ...(body[0] as object), name: "diverged" }], {
                status: response.status,
                headers: { "content-type": "application/json" },
              })
            },
          }
        }
        const failure = await parity({
          provider: "genebygene",
          spec: document,
          real: {
            baseUrl: `https://${MOCK_HOST}`,
            allowedHosts: [MOCK_HOST],
            headers: () => AUTH,
            fetch: (r) => reference.fetch(r),
          },
          mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => AUTH },
          cleanup: async () => {
            await reference.reset()
          },
          only: ["GetProducts"],
          numRuns: 20,
          maxCommands: 4,
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
  })
})
