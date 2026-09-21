import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, IntercomAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.intercom.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer ic-parity", "intercom-version": "2.11" }

describe("IntercomAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new IntercomAPI({ now })
      const report = await parity({
        provider: "intercom",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new IntercomAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 150, 150),
        maxCommands: 20,
        // Conversation operations need a contact, then a conversation, from earlier in the walk.
        weights: {
          CreateContact: 2,
          CreateConversation: 3,
          ReplyConversation: 3,
          ManageConversation: 3,
          GetConversation: 2,
          UpdateConversation: 2,
        },
        coverageBias: 3,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, including replies and state changes, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new IntercomAPI({ now })
          const faulty = () => {
            const api = new IntercomAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (new URL(request.url).pathname !== "/admins") return response
                // The admin list loses its last admin.
                const body = (await response.json()) as { type: string; admins: unknown[] }
                return Response.json(
                  { ...body, admins: body.admins.slice(0, -1) },
                  { status: response.status },
                )
              },
            }
          }
          const failure = await parity({
            provider: "intercom",
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
            only: ["ListAdmins"],
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            latencyToleranceMs: 1_000,
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
