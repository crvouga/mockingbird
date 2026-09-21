import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, GeneByGeneAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.genebygene.local"
const now = () => 1_781_194_684_000

/** A token both instances accept: tokens are self-describing and signed deterministically. */
const token = async () => {
  const response = await new GeneByGeneAPI({ now }).fetch(
    new Request(`https://${MOCK_HOST}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "parity",
        client_secret: "parity",
      }),
    }),
  )
  return ((await response.json()) as { access_token: string }).access_token
}

// Walks never reach the admin-only lifecycle, so the mock-only blob route stays out of scope.
const WALKED = supportedOperationIds.filter((id) => id !== "GetResultBlob")

describe("GeneByGeneAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const auth = { authorization: `Bearer ${await token()}` }
      const reference = new GeneByGeneAPI({ now })
      const report = await parity({
        provider: "genebygene",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new GeneByGeneAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 250, 250),
        maxCommands: 30,
        coverageBias: 4,
        weights: {
          CreateOrder: 6,
          CreateOrderForExistingKits: 2,
          CancelOrderLine: 4,
          CancelFulfillment: 3,
          CancelKitOrderLines: 3,
          GetKitResults: 2,
          SetKitAttributes: 2,
          UpdateShipmentAddress: 2,
        },
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every parity-enabled operation, including order placement and all three cancel layers.
      expect(Object.keys(report.exercised).sort()).toEqual([...WALKED].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      const auth = { authorization: `Bearer ${await token()}` }
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new GeneByGeneAPI({ now })
          const faulty = () => {
            const api = new GeneByGeneAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/attributes")) return response
                const body = (await response.json()) as { name: string }[]
                if (body[0]) body[0] = { ...body[0], name: "diverged" }
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "genebygene",
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
            only: ["ListAttributeDefinitions"],
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            missingProbability: 0,
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
