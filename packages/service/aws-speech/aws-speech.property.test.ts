import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, SpeechAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "polly.mock.local"
const now = () => 1_700_000_000_000
/** Parity-enabled operations (the duplex streams are exercised by the SDK tests). */
const PARITY_OPERATIONS = supportedOperationIds.filter(
  (id) => id !== "StartSpeechSynthesisStream" && id !== "StartStreamTranscription",
)
const auth = () => ({
  authorization:
    "AWS4-HMAC-SHA256 Credential=AKIDPARITY/20260920/us-east-1/polly/aws4_request, SignedHeaders=host, Signature=0",
})

describe("SpeechAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new SpeechAPI({ now })
      const report = await parity({
        provider: "aws-speech",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new SpeechAPI({ now }),
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
          const reference = new SpeechAPI({ now })
          const faulty = () => {
            const api = new SpeechAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                // Every generated request must reveal the injected fault, including requests
                // rejected by cross-field rules (e.g. an incompatible format/sample rate).
                // Otherwise an unlucky seed can miss every 200 and the outer property spends
                // its timeout shrinking that seed instead of testing divergence detection.
                return Response.json(
                  { message: "diverged" },
                  { status: response.status === 500 ? 502 : 500 },
                )
              },
            }
          }
          const failure = await parity({
            provider: "aws-speech",
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
            only: ["SynthesizeSpeech"],
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
