import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { BedrockAPI, document, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "bedrock-runtime.mock.local"
const now = () => 1_700_000_000_000
/** Parity-enabled operations (the duplex Nova Sonic session is exercised by the SDK tests). */
const PARITY_OPERATIONS = supportedOperationIds.filter(
  (id) => id !== "InvokeModelWithBidirectionalStream",
)
const auth = () => ({
  authorization:
    "AWS4-HMAC-SHA256 Credential=AKIDPARITY/20260920/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=0",
})

describe("BedrockAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new BedrockAPI({ now })
      const report = await parity({
        provider: "bedrock",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new BedrockAPI({ now }),
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
      expect(Object.keys(report.exercised).sort()).toEqual([...PARITY_OPERATIONS].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new BedrockAPI({ now })
          const faulty = () => {
            const api = new BedrockAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = (await response.json()) as { stopReason?: string }
                return Response.json({ ...body, stopReason: "max_tokens" }, { status: 200 })
              },
            }
          }
          const failure = await parity({
            provider: "bedrock",
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
            only: ["Converse"],
            numRuns: 20,
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
