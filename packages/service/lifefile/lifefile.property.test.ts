import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, LifeFileAPI, supportedOperationIds } from "./src/index.js"
import { headers } from "./test/consumer.js"

const host = "mock.lifefile.local"
const params = fcParameters(process.env)
const now = () => 1700000000000

// The generator supplies X-* parameters. Differently cased copies in target headers
// would combine into invalid comma-separated values and prevent order creation.

test(
  "independent LifeFile instances agree across every OpenAPI operation",
  async () => {
    const real = new LifeFileAPI({ now })
    const report = await parity({
      provider: "lifefile",
      spec: document,
      real: {
        baseUrl: `https://${host}`,
        allowedHosts: [host],
        headers: () => ({ authorization: headers.authorization }),
        fetch: (r) => real.fetch(r),
      },
      mock: {
        create: () => new LifeFileAPI({ now }),
        baseUrl: `https://${host}`,
        headers: () => ({ authorization: headers.authorization }),
      },
      cleanup: async () => {
        await real.reset()
      },
      includeUnsafe: true,
      numRuns: params.numRuns ?? 15,
      maxCommands: 12,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
  },
  { timeout: 60000 },
)

test(
  "parity detects a deliberately divergent create envelope",
  async () => {
    const real = new LifeFileAPI({ now })
    const error = await parity({
      provider: "lifefile",
      spec: document,
      real: {
        baseUrl: `https://${host}`,
        allowedHosts: [host],
        headers: () => ({ authorization: headers.authorization }),
        fetch: (r) => real.fetch(r),
      },
      mock: {
        create: () => ({
          fetch: async () => Response.json({ type: "error", message: "Divergent fixture" }),
        }),
        baseUrl: `https://${host}`,
        headers: () => ({ authorization: headers.authorization }),
      },
      cleanup: async () => {
        await real.reset()
      },
      only: ["CreateOrder"],
      includeUnsafe: true,
      numRuns: 3,
      maxCommands: 3,
      invalidProbability: 0,
      sleep: async () => {},
      log: () => {},
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ParityError)
  },
  { timeout: 60000 },
)
