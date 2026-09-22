import { describe, expect, test } from "bun:test"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, MailosaurAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.mailosaur.local"
const now = () => 1_700_000_000_000
const auth = { authorization: `Basic ${btoa("parity-key:")}` }

/** Every operation the walks may reach (the long-poll `await` routes are parity-disabled). */
const parityOperations = Object.values(document.paths ?? {})
  .flatMap((item) => Object.values(item as Record<string, unknown>))
  .filter((operation): operation is { operationId: string } =>
    Boolean((operation as { operationId?: string }).operationId),
  )
  .filter((operation) => operationMetadata(operation as never).parity.enabled)
  .map((operation) => operation.operationId)
  .sort()

describe("MailosaurAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new MailosaurAPI({ now })
      const report = await parity({
        provider: "mailosaur",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new MailosaurAPI({ now }),
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
      expect(parityOperations).toHaveLength(6)
      expect(Object.keys(report.exercised).sort()).toEqual(parityOperations)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new MailosaurAPI({ now })
          const faulty = () => {
            const api = new MailosaurAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (request.method !== "POST" || new URL(request.url).pathname !== "/api/messages")
                  return response
                if (response.status !== 200) return response
                const body = (await response.json()) as { subject: string }
                return Response.json({ ...body, subject: `${body.subject} (diverged)` })
              },
            }
          }
          const failure = await parity({
            provider: "mailosaur",
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
            only: ["CreateMessage"],
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
