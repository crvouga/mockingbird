import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, supportedOperationIds, TwilioAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.twilio.local"
const now = () => 1_700_000_000_000
/**
 * The contract narrowed for walks: one Verify service (a verification belongs to the service
 * that created it, so start → check only chain when they share one) and recipients drawn from
 * fictional 555-01xx numbers plus one invalid, so sends succeed often enough to chain fetches.
 */
const RECIPIENTS = ["+12025550123", "+13105550142", "+14155550100", "+15550100"]
const spec = (() => {
  const copy = structuredClone(document)
  const parameter = copy.components?.parameters?.ServiceSid as { schema?: unknown } | undefined
  if (parameter) parameter.schema = { type: "string", enum: ["VA0123456789abcdef0123456789abcdef"] }
  for (const item of Object.values(copy.paths ?? {})) {
    for (const operation of Object.values(item as Record<string, unknown>)) {
      const body = (
        operation as { requestBody?: { content?: Record<string, { schema?: unknown }> } }
      ).requestBody
      const schema = body?.content?.["application/x-www-form-urlencoded"]?.schema as
        | { properties?: Record<string, unknown> }
        | undefined
      if (schema?.properties?.To) schema.properties.To = { type: "string", enum: RECIPIENTS }
    }
  }
  return copy
})()
const auth = {
  authorization: `Basic ${btoa("AC33333333333333333333333333333333:parity-token")}`,
}

describe("TwilioAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new TwilioAPI({ now })
      const report = await parity({
        provider: "twilio",
        spec,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new TwilioAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        // No API call creates a recording, so recording commands only run with a missing sid
        // (the rest are skipped as ineligible): draw them more often.
        weights: { FetchRecordingMedia: 8, FetchRecording: 8, DeleteRecording: 8 },
        coverageBias: 4,
        numRuns: Math.max(params.numRuns ?? 100, 100),
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, including Verify, Messages and Recordings, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new TwilioAPI({ now })
          const faulty = () => {
            const api = new TwilioAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.startsWith("/lookups/")) return response
                const body = (await response.json()) as Record<string, unknown>
                // The kind of drift live parity exists to catch: a renamed response key.
                const { national_format, ...rest } = body
                return Response.json(
                  { ...rest, nationalFormat: national_format },
                  { status: response.status },
                )
              },
            }
          }
          const failure = await parity({
            provider: "twilio",
            spec,
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
            only: ["FetchPhoneNumber"],
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
