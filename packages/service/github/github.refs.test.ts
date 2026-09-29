import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  d = "d".repeat(40)
const fixture = {
  owner: "synthetic-org",
  name: "example",
  commits: [
    { sha: a, parents: [] },
    { sha: b, parents: [a] },
    { sha: c, parents: [b] },
    { sha: d, parents: [a] },
  ],
  branches: { main: a, "topic/nested": b, topicTwo: c },
}
const setup = () => {
  const runtime = createRuntime()
  runtime.instance("a").state.seed(fixture)
  const request = (path: string, method = "GET", body?: unknown, namespace = "a") =>
    runtime.fetch(
      new Request(`http://github.mock${path}`, {
        method,
        headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, request }
}
const root = "/repos/synthetic-org/example/git"

test("ref reads preserve nested names, prefix matching, empty prefix and case", async () => {
  const { request } = setup()
  for (const ref of ["heads/topic/nested", "heads%2Ftopic%2Fnested"]) {
    const response = await request(`${root}/ref/${ref}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ref: "refs/heads/topic/nested",
      object: { type: "commit", sha: b },
    })
  }
  expect((await request(`${root}/ref/heads/topic`)).status).toBe(404)
  expect((await request(`${root}/ref/heads/MAIN`)).status).toBe(404)
  const matches = await (await request(`${root}/matching-refs/heads/topic`)).json()
  expect(matches.map((ref: { ref: string }) => ref.ref)).toEqual([
    "refs/heads/topic/nested",
    "refs/heads/topicTwo",
  ])
  for (const ending of ["", "/"])
    expect((await (await request(`${root}/matching-refs${ending}`)).json()).length).toBe(3)
  expect(await (await request(`${root}/matching-refs/heads/missing`)).json()).toEqual([])
})

test("ref creation validates object, names and directory collisions atomically", async () => {
  const { request } = setup()
  const create = (ref: string, sha = a) => request(`${root}/refs`, "POST", { ref, sha })
  const created = await create("refs/heads/new/nested")
  expect(created.status).toBe(201)
  const identity = await created.json()
  expect(identity).toMatchObject({ ref: "refs/heads/new/nested", object: { sha: a } })
  expect((await create("refs/heads/new/nested")).status).toBe(422)
  expect((await create("refs/heads/new")).status).toBe(422)
  expect((await create("refs/heads/main/child")).status).toBe(422)
  for (const name of [
    "heads/bad",
    "refs/heads/bad..name",
    "refs/heads/.hidden",
    "refs/heads/a.lock",
    "refs/heads/a//b",
    "refs/heads/a b",
    "refs/heads/a@{b",
    "refs/heads/a.",
  ])
    expect((await create(name)).status).toBe(422)
  expect((await create("refs/heads/missing-object", "e".repeat(40))).status).toBe(422)
  expect((await request(`${root}/ref/heads/missing-object`)).status).toBe(404)
  expect(await (await request(`${root}/ref/heads/new/nested`)).json()).toEqual(identity)
})

test("updates check the current head, reject divergence, and model synthetic force", async () => {
  const { request } = setup()
  const update = (sha: string, extra = {}) =>
    request(`${root}/refs/heads/main`, "PATCH", { sha, ...extra })
  const original = await (await request(`${root}/ref/heads/main`)).json()
  expect((await update(b)).status).toBe(200)
  // A stale client may still advance if the new head is an ancestor; REST has no expected-old-SHA lease.
  expect((await update(c, { expected_sha: a })).status).toBe(200)
  expect((await update(d)).status).toBe(422)
  expect((await update(a, { force: false })).status).toBe(422)
  expect((await update(a, { force: "true" })).status).toBe(422)
  expect((await update("e".repeat(40), { force: true })).status).toBe(422)
  const forced = await update(d, { force: true })
  expect(forced.status).toBe(200)
  expect(await forced.json()).toMatchObject({ node_id: original.node_id, object: { sha: d } })
  expect((await request(`${root}/refs/heads/missing`, "PATCH", { sha: a })).status).toBe(422)
})

test("concurrent divergent updates cannot both overwrite the same current head", async () => {
  const { request } = setup()
  const results = await Promise.all(
    [b, d].map((sha) => request(`${root}/refs/heads/main`, "PATCH", { sha })),
  )
  expect(results.map((r) => r.status).sort()).toEqual([200, 422])
  const winner = results[0]?.status === 200 ? b : d
  expect(await (await request(`${root}/ref/heads/main`)).json()).toMatchObject({
    object: { sha: winner },
  })
})

test("ref operations retain namespace, history, fault matching and metadata journal", async () => {
  const { runtime, request } = setup()
  const checkpoint = await (await request("/__admin/checkpoints", "POST", {})).json()
  expect((await request(`${root}/refs/heads/topic/nested`, "PATCH", { sha: c })).status).toBe(200)
  expect((await request(`${root}/ref/heads/topic/nested`, "GET", undefined, "b")).status).toBe(404)
  await request("/__admin/faults", "POST", { operationId: "git/get-ref", status: 503, count: 1 })
  expect((await request(`${root}/ref/heads/topic/nested`)).status).toBe(503)
  expect((await request(`${root}/ref/heads/topic/nested`)).status).toBe(200)
  expect(
    runtime.journal
      .list({ namespace: "a" })
      .some((entry) => entry.operationId === "git/update-ref"),
  ).toBe(true)
  await request("/__admin/branches/main/checkout", "POST", { checkpoint: checkpoint.id })
  expect(await (await request(`${root}/ref/heads/topic/nested`)).json()).toMatchObject({
    object: { sha: b },
  })
})

test("empty repository ref creation fails without constructing missing history", async () => {
  const { runtime, request } = setup()
  runtime.instance("a").state.seed({ ...fixture, name: "empty", branches: {} })
  expect(
    (
      await request("/repos/synthetic-org/empty/git/refs", "POST", {
        ref: "refs/heads/main",
        sha: a,
      })
    ).status,
  ).toBe(409)
  expect((await request("/repos/synthetic-org/missing/git/ref/heads/main")).status).toBe(404)
})
