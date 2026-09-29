import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { DockerAPI, document, supportedOperationIds } from "./src/index.js"

const host = "docker.mock.local"
const params = fcParameters(process.env)

test("self-parity exercises each nonblocking implemented operation against the contract", async () => {
  const reference = new DockerAPI()
  const report = await parity({
    provider: "docker",
    spec: document,
    includeUnsafe: true,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: { create: () => new DockerAPI(), baseUrl: `http://${host}` },
    cleanup: () => reference.reset(),
    numRuns: params.numRuns ?? 25,
    maxCommands: 10,
    latencyToleranceMs: 1_000,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    env: process.env,
    sleep: async () => {},
    log: () => {},
  })
  expect(report.walks).toBeGreaterThan(0)
  const eligible = supportedOperationIds
    .filter(
      (id) => !["ContainerWait", "ContainerStop", "ContainerKill", "ContainerDelete"].includes(id),
    )
    .sort()
  expect(report.planned.slice().sort()).toEqual(eligible)
  expect(Object.keys(report.exercised).sort()).toEqual(eligible)
  for (const operation of eligible) expect(report.exercised[operation]).toBeGreaterThan(0)
})

test("the parity oracle rejects a divergent ping response", async () => {
  const reference = new DockerAPI()
  const result = parity({
    provider: "docker",
    spec: document,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: {
      create: () => ({ fetch: async () => new Response("BROKEN") }),
      baseUrl: `http://${host}`,
    },
    only: ["SystemPing"],
    numRuns: 10,
    maxCommands: 3,
    invalidProbability: 0,
    latencyToleranceMs: 1_000,
    seed: params.seed ?? 42,
    cleanup: () => reference.reset(),
    sleep: async () => {},
    log: () => {},
  })
  const failure: unknown = await result.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ParityError)
  if (!(failure instanceof ParityError)) throw new Error("Expected a parity failure")
  expect(failure.details.kind).toBe("mismatch")
})

for (const divergent of [false, true]) {
  test(`seeded list parity ${divergent ? "detects schema-valid execution-state divergence" : "compares nonempty execution state"}`, async () => {
    const instances: DockerAPI[] = []
    const seed = (api: DockerAPI) =>
      api.state.seed({
        images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
        containers: [{ id: "a".repeat(64), name: "worker", image: "synthetic", status: "running" }],
      })
    const create = () => {
      const api = new DockerAPI({ now: () => 1_700_000_000_000 })
      seed(api)
      instances.push(api)
      return api
    }
    const reference = create()
    let compared = 0
    try {
      const outcome = await parity({
        provider: "docker",
        spec: document,
        real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
        mock: {
          create: () => {
            const api = create()
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = await response.json()
                if (Array.isArray(body) && body.length > 0) {
                  compared++
                  if (divergent) body[0].State = "exited"
                }
                return Response.json(body, { status: response.status, headers: response.headers })
              },
            }
          },
          baseUrl: `http://${host}`,
        },
        only: ["ContainerList"],
        numRuns: 10,
        maxCommands: 3,
        invalidProbability: 0,
        latencyToleranceMs: 1_000,
        seed: params.seed ?? 42,
        cleanup: async () => {
          await reference.reset()
          seed(reference)
        },
        sleep: async () => {},
        log: () => {},
      }).then(
        (report) => ({ report, error: undefined }),
        (error: unknown) => ({ report: undefined, error }),
      )
      expect(compared).toBeGreaterThan(0)
      if (divergent) {
        expect(outcome.error).toBeInstanceOf(ParityError)
        if (!(outcome.error instanceof ParityError)) throw new Error("Expected state divergence")
        expect(outcome.error.details.kind).toBe("mismatch")
      } else {
        expect(outcome.error).toBeUndefined()
        expect(outcome.report?.exercised.ContainerList).toBeGreaterThan(0)
      }
    } finally {
      for (const api of instances) api.close()
    }
  })
}
