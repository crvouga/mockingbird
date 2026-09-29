import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, GitHubAPI, supportedOperationIds } from "./src/index.js"

const host = "github.mock.local"
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40)
const params = fcParameters(process.env)
const seed = (api: GitHubAPI) => {
  const repo = api.state.seed({
    owner: "synthetic-org",
    name: "example",
    commits: [
      { sha: a, parents: [] },
      { sha: b, parents: [a] },
      { sha: c, parents: [b] },
    ],
    branches: { main: a, topic: b, other: c },
  })
  api.pulls.create(repo, { title: "Seeded PR", head: "topic", base: "main" })
}
const create = () => {
  const api = new GitHubAPI({ now: () => 1700000000000 })
  seed(api)
  return api
}
const seededSpec = () => {
  const spec = structuredClone(document)
  for (const item of Object.values(spec.paths ?? {}))
    for (const method of ["get", "post", "patch"] as const) {
      const op = item?.[method]
      if (!op) continue
      for (const parameter of op.parameters ?? [])
        if (!("$ref" in parameter) && parameter.in === "path") {
          const value = {
            owner: "synthetic-org",
            repo: "example",
            ref: "heads/topic",
            pull_number: 1,
          }[parameter.name]
          if (value !== undefined)
            parameter.schema =
              typeof value === "number"
                ? { type: "integer", const: value }
                : { type: "string", const: value }
        }
    }
  return spec
}

// CI runs 40 walks on shared runners; give this test a bounded 30-second budget.
test("seeded self-parity plans and exercises every GitHub operation", async () => {
  const reference = create()
  const report = await parity({
    provider: "github",
    spec: seededSpec(),
    includeUnsafe: true,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: { create, baseUrl: `http://${host}` },
    cleanup: async () => {
      await reference.reset()
      seed(reference)
    },
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
}, 30_000)

for (const divergent of [false, true])
  test(`repository parity ${divergent ? "detects schema-valid divergence" : "compares successful seeded reads"}`, async () => {
    const reference = create()
    let successes = 0
    const result = await parity({
      provider: "github",
      spec: seededSpec(),
      only: ["repos/get"],
      real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
      mock: {
        baseUrl: `http://${host}`,
        create: () => {
          const api = create()
          return {
            fetch: async (request: Request) => {
              const response = await api.fetch(request)
              if (response.status !== 200) return response
              successes++
              const body = await response.json()
              if (divergent) body.private = !body.private
              return Response.json(body, { status: response.status, headers: response.headers })
            },
          }
        },
      },
      cleanup: async () => {
        await reference.reset()
        seed(reference)
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
    expect(successes).toBeGreaterThan(0)
    if (divergent) {
      expect(result.error).toBeInstanceOf(ParityError)
      if (!(result.error instanceof ParityError)) throw new Error("Expected divergence")
      expect(result.error.details.kind).toBe("mismatch")
    } else {
      expect(result.error).toBeUndefined()
      expect(result.report?.exercised["repos/get"]).toBeGreaterThan(0)
    }
  })

for (const operationId of supportedOperationIds)
  test(`successful seeded parity covers ${operationId}`, async () => {
    const spec = seededSpec()
    const bodies: Record<string, Record<string, string>> = {
      "git/create-ref": { ref: "refs/heads/new", sha: b },
      "git/update-ref": { sha: c },
      "pulls/create": { title: "Additional", head: "other", base: "main" },
      "pulls/update": { title: "Updated" },
    }
    for (const item of Object.values(spec.paths ?? {}))
      for (const method of ["get", "post", "patch"] as const) {
        const op = item?.[method]
        if (op?.operationId !== operationId) continue
        op.parameters = (op.parameters ?? []).filter((p) => !("$ref" in p) && p.in === "path")
        if (bodies[operationId])
          op.requestBody = {
            required: true,
            content: {
              "application/json": { schema: { type: "object", const: bodies[operationId] } },
            },
          }
      }
    const reference = create()
    let successful = 0
    const report = await parity({
      provider: "github",
      spec,
      only: [operationId],
      includeUnsafe: true,
      real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
      mock: {
        baseUrl: `http://${host}`,
        create: () => {
          const api = create()
          return {
            fetch: async (r: Request) => {
              const response = await api.fetch(r)
              if (response.status >= 200 && response.status < 300) {
                successful++
                const body = await response.clone().json()
                const expected: Record<string, object> = {
                  "repos/get": { full_name: "synthetic-org/example" },
                  "git/get-ref": { ref: "refs/heads/topic", object: { sha: b } },
                  "git/list-matching-refs": [{ ref: "refs/heads/topic", object: { sha: b } }],
                  "git/create-ref": { ref: "refs/heads/new", object: { sha: b } },
                  "git/update-ref": { ref: "refs/heads/topic", object: { sha: c } },
                  "pulls/list": [{ number: 1, title: "Seeded PR" }],
                  "pulls/get": { number: 1, title: "Seeded PR" },
                  "pulls/create": { title: "Additional", head: { ref: "other", sha: c } },
                  "pulls/update": { number: 1, title: "Updated" },
                }
                const observation = expected[operationId]
                if (!observation) throw new Error("Missing expected operation observation")
                expect(body).toMatchObject(observation)
              }
              return response
            },
          }
        },
      },
      cleanup: async () => {
        await reference.reset()
        seed(reference)
      },
      numRuns: 5,
      maxCommands: 1,
      invalidProbability: 0,
      seed: 42,
      latencyToleranceMs: 1000,
      sleep: async () => {},
      log: () => {},
    })
    expect(successful).toBeGreaterThan(0)
    expect(report.exercised[operationId]).toBeGreaterThan(0)
  })
