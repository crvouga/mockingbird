import { describe, expect, test } from "bun:test"
import { planOperations } from "@crvouga/mockingbird-commands"
import { seedParity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, StripeAPI } from "./src/index.js"
import { QA_SURFACE_OPS } from "./src/qa-corpus.js"
import { reshapeQaCommand } from "./src/reshape-qa.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }
const now = () => 1_700_000_000_000

/**
 * Operations that need no pre-existing resource, so a walk must always reach them. Everything else
 * (retrieve/update/delete by id) is exercised opportunistically as the walk creates ids.
 */
const REF_FREE_OPS = planOperations(document, {
  forceInclude: QA_SURFACE_OPS,
  includeUnsafe: true,
})
  .filter((plan) => plan.requires.length === 0)
  .map((plan) => plan.operation.operationId)

/**
 * Offline monkey confidence for the QA-facing surface.
 *
 * A reference instance is warmed with dynamic (coverage-guided) walks, hands its state to a fresh
 * instance through `seedMock`, and both then walk the same commands in lockstep: any divergence,
 * any non-conforming response, and any unhandled ref-free operation fails the suite. Walks are
 * reshaped onto the values the QA suites actually send and include unsafe operations, so billing paths
 * are exercised too.
 *
 * Seeded parity against the real API stays live-only (`bun run parity`, credentials required):
 * importing a real account's state is not something an offline mock can do.
 */
describe("StripeAPI QA surface", () => {
  test(
    "seeded lockstep diverges nowhere and reaches every resource-free operation",
    async () => {
      const oracle = new StripeAPI({ now })
      const report = await seedParity({
        provider: "stripe",
        // Full-surface coverage is the goal; a handful of coverage-guided walks reaches every
        // resource-free operation, and each walk already runs 800 commands.
        numRuns: 5,
        spec: document,
        env: process.env,
        ...params,
        explore: "dynamic",
        forceInclude: QA_SURFACE_OPS,
        includeUnsafe: true,
        warmupCommands: 400,
        compareCommands: 400,
        maxCommands: 400,
        // Both sides are in-process, so the latency guard only catches a mock that is orders of
        // magnitude slower than the reference — not sub-second noise between two mocks.
        latencyToleranceMs: 1_000,
        reshapeCommand: reshapeQaCommand,
        mock: {
          create: () => new StripeAPI({ now }),
          headers: () => AUTH,
        },
        real: {
          allowedHosts: [MOCK_HOST],
          baseUrl: `https://${MOCK_HOST}`,
          fetch: (request) => oracle.fetch(request),
          headers: () => AUTH,
        },
        seedMock: async ({ mock }) => {
          const target = mock as unknown as StripeAPI
          target.importStateFrom(oracle)
        },
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      const exercised = new Set(Object.keys(report.exercised))
      expect(REF_FREE_OPS.filter((id) => !exercised.has(id))).toEqual([])
    },
    { timeout: 600_000 },
  )
})
