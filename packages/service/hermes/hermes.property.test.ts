import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, HermesAPI, supportedOperationIds } from "./src/index.js"

const host = "hermes.mock.local"
const params = fcParameters(process.env)
const create = () => new HermesAPI({ now: () => 1_700_000_000_000 })

test("self-parity exercises every implemented peer operation with explicit coverage", async () => {
  const reference = create()
  const report = await parity({
    provider: "hermes",
    spec: document,
    includeUnsafe: true,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: { create, baseUrl: `http://${host}` },
    cleanup: () => reference.reset(),
    numRuns: params.numRuns ?? 25,
    maxCommands: 12,
    seed: params.seed ?? 42,
    latencyToleranceMs: 1000,
    env: process.env,
    sleep: async () => {},
    log: () => {},
  })
  expect(report.walks).toBeGreaterThan(0)
  expect(report.planned.slice().sort()).toEqual(supportedOperationIds.slice().sort())
  expect(Object.keys(report.exercised).sort()).toEqual(supportedOperationIds.slice().sort())
  for (const id of supportedOperationIds) expect(report.exercised[id]).toBeGreaterThan(0)
})

for (const divergent of [false, true]) {
  test(`poll parity ${divergent ? "detects schema-valid lifecycle divergence" : "compares a real admitted observation"}`, async () => {
    const seed = (api: HermesAPI) => api.idempotency.submit('{"input":"synthetic"}', "", "")
    const reference = create()
    const run = await seed(reference)
    let compared = 0
    // Limit this focused walk to the admitted resource; broad coverage is asserted above.
    const spec = structuredClone(document)
    const parameters = spec.paths?.["/v1/runs/{run_id}"]?.get?.parameters
    if (!parameters) throw new Error("Missing poll parameters")
    for (const parameter of parameters) {
      if (!("$ref" in parameter) && parameter.name === "run_id")
        parameter.schema = { type: "string", const: run.run.run_id }
    }
    const outcome = await parity({
      provider: "hermes",
      spec,
      only: ["RunGet"],
      real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
      mock: {
        baseUrl: `http://${host}`,
        create: async () => {
          const api = create()
          await seed(api)
          return {
            fetch: async (request: Request) => {
              const response = await api.fetch(request)
              if (response.status !== 200) return response
              compared++
              const body = await response.json()
              if (divergent) body.status = "running"
              return Response.json(body, { status: response.status, headers: response.headers })
            },
          }
        },
      },
      cleanup: async () => {
        await reference.reset()
        await seed(reference)
      },
      numRuns: 10,
      maxCommands: 3,
      invalidProbability: 0,
      seed: params.seed ?? 42,
      latencyToleranceMs: 1000,
      sleep: async () => {},
      log: () => {},
    }).then(
      (report) => ({ report, error: undefined }),
      (error: unknown) => ({ report: undefined, error }),
    )
    expect(compared).toBeGreaterThan(0)
    if (divergent) {
      expect(outcome.error).toBeInstanceOf(ParityError)
      if (!(outcome.error instanceof ParityError)) throw new Error("Expected parity failure")
      expect(outcome.error.details.kind).toBe("mismatch")
    } else {
      expect(outcome.error).toBeUndefined()
      expect(outcome.report?.exercised.RunGet).toBeGreaterThan(0)
    }
  })
}
