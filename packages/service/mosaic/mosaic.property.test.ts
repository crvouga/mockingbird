import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, MosaicAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const baseUrl = "http://mosaic.local"
const headers = () => ({ ApiKey: "mockingbird" })
const create = () => new MosaicAPI({ now: () => 1_750_000_000_000 })

const options = (reference: MosaicAPI) => ({
  provider: "mosaic",
  spec: document,
  real: {
    baseUrl,
    allowedHosts: ["mosaic.local"],
    headers,
    fetch: (request: Request) => reference.fetch(request),
  },
  mock: { create, baseUrl, headers },
  cleanup: () => reference.reset(),
  includeUnsafe: true,
  ...(params.seed === undefined ? {} : { seed: params.seed }),
  latencyToleranceMs: 1_000,
  sleep: async () => {},
  log: () => {},
})

test("self-parity walks cover every supported operation and validate vendor responses", async () => {
  const report = await parity({
    ...options(create()),
    numRuns: params.numRuns ?? 30,
    maxCommands: 40,
    coverageBias: 4,
  })
  expect(report.walks).toBeGreaterThan(0)
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
}, 55_000)

test("self-parity catches a deliberately divergent, contract-valid response", async () => {
  const baseline = options(create())
  await expect(
    parity({
      ...baseline,
      only: ["ListLanguages"],
      numRuns: 3,
      maxCommands: 5,
      mock: { ...baseline.mock, create: () => ({ fetch: async () => Response.json([]) }) },
    }),
  ).rejects.toBeInstanceOf(ParityError)
})
