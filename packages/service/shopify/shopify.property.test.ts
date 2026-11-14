import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, ShopifyAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const HOST = "mockingbird-test.myshopify.com"
const now = () => Date.UTC(2026, 0, 4, 12)
const headers = { "x-shopify-access-token": "shpat_parity_token" }

describe("ShopifyAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new ShopifyAPI({ now })
      const report = await parity({
        provider: "shopify",
        spec: document,
        real: {
          baseUrl: `https://${HOST}`,
          allowedHosts: [HOST],
          headers: () => headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new ShopifyAPI({ now }),
          baseUrl: `https://${HOST}`,
          headers: () => headers,
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
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new ShopifyAPI({ now })
          const faulty = () => {
            const api = new ShopifyAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                const body = (await response.json()) as Record<string, unknown>
                return Response.json(
                  { ...body, data: { diverged: true } },
                  { status: response.status },
                )
              },
            }
          }
          const failure = await parity({
            provider: "shopify",
            spec: document,
            real: {
              baseUrl: `https://${HOST}`,
              allowedHosts: [HOST],
              headers: () => headers,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${HOST}`, headers: () => headers },
            cleanup: async () => {
              await reference.reset()
            },
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
