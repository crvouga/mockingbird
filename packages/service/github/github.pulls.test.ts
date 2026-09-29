import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime } from "./src/index.js"

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40)
const fixture = {
  owner: "synthetic-org",
  name: "example",
  commits: [
    { sha: a, parents: [] },
    { sha: b, parents: [a] },
    { sha: c, parents: [b] },
  ],
  branches: { main: a, topic: b, other: c, release: a },
}
const root = "/repos/synthetic-org/example"
const input = {
  title: "Synthetic change",
  head: "topic",
  base: "main",
  body: "Synthetic description",
}
const setup = () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const runtime = createRuntime({ clock })
  runtime.instance("a").state.seed(fixture)
  const request = (path: string, method = "GET", body?: unknown, namespace = "a", extra = {}) =>
    runtime.fetch(
      new Request(path.startsWith("http") ? path : `http://github.mock${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-mockingbird-namespace": namespace,
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, clock, request }
}

test("PR identity relates repository, branch names and current SHAs without merge claims", async () => {
  const { request } = setup()
  const response = await request(`${root}/pulls`, "POST", {
    ...input,
    head: "SYNTHETIC-ORG:topic",
    draft: true,
  })
  expect(response.status).toBe(201)
  const pr = await response.json()
  expect(pr).toMatchObject({
    number: 1,
    state: "open",
    draft: true,
    merged: false,
    mergeable: null,
    merge_commit_sha: null,
    head: { ref: "topic", sha: b, repo: { full_name: "synthetic-org/example" } },
    base: { ref: "main", sha: a },
  })
  expect(typeof pr.id).toBe("number")
  expect(typeof pr.node_id).toBe("string")
  expect(await (await request(`${root}/pulls/1`)).json()).toEqual(pr)
  expect((await request(`${root}/git/refs/heads/topic`, "PATCH", { sha: c })).status).toBe(200)
  expect(await (await request(`${root}/pulls/1`)).json()).toMatchObject({
    node_id: pr.node_id,
    head: { sha: c },
    base: { sha: a },
  })
  expect((await request(`${root}/pulls/999`)).status).toBe(404)
  expect((await request(`${root}/pulls/1`, "GET", undefined, "b")).status).toBe(404)
})

test("duplicate creates return an observed validation envelope, not idempotent replay", async () => {
  const { request } = setup()
  const create = () =>
    request(`${root}/pulls`, "POST", { ...input, publication_operation_id: "synthetic-op" }, "a", {
      "Idempotency-Key": "synthetic-op",
    })
  expect((await create()).status).toBe(201)
  const duplicate = await create()
  expect(duplicate.status).toBe(422)
  expect(await duplicate.json()).toMatchObject({
    message: "Validation Failed",
    errors: [
      {
        resource: "PullRequest",
        code: "custom",
        message: "A pull request already exists for synthetic-org:topic.",
      },
    ],
  })
  const different = await request(`${root}/pulls`, "POST", { ...input, head: "other" }, "a", {
    "Idempotency-Key": "synthetic-op",
  })
  expect(different.status).toBe(201)
  expect((await different.json()).number).toBe(2)
})

test("updates validate atomically, close/reopen, and cannot replace head", async () => {
  const { request, clock } = setup()
  await request(`${root}/pulls`, "POST", input)
  clock.advance(1000)
  const changed = await request(`${root}/pulls/1`, "PATCH", {
    title: "Updated",
    body: "",
    base: "release",
    head: "other",
    state: "closed",
  })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({
    title: "Updated",
    body: null,
    head: { ref: "topic" },
    base: { ref: "release" },
    state: "closed",
    closed_at: "2023-11-14T22:13:21.000Z",
  })
  expect((await (await request(`${root}/pulls`)).json()).length).toBe(0)
  expect((await (await request(`${root}/pulls?state=closed`)).json()).length).toBe(1)
  const before = await (await request(`${root}/pulls/1`)).json()
  expect(
    (await request(`${root}/pulls/1`, "PATCH", { title: "Must not persist", base: "missing" }))
      .status,
  ).toBe(422)
  expect(await (await request(`${root}/pulls/1`)).json()).toEqual(before)
  expect((await request(`${root}/pulls/1`, "PATCH", { state: "open" })).status).toBe(200)
  expect(await (await request(`${root}/pulls/1`)).json()).toMatchObject({ closed_at: null })
})

test("clearing a PR body returns null and persists across get, list and omitted-body edits", async () => {
  const { request } = setup()
  expect((await request(`${root}/pulls`, "POST", input)).status).toBe(201)
  const cleared = await request(`${root}/pulls/1`, "PATCH", { body: "" })
  expect(cleared.status).toBe(200)
  expect((await cleared.json()).body).toBeNull()
  expect((await (await request(`${root}/pulls/1`)).json()).body).toBeNull()
  expect((await (await request(`${root}/pulls`)).json())[0].body).toBeNull()
  const renamed = await request(`${root}/pulls/1`, "PATCH", { title: "Renamed" })
  expect((await renamed.json()).body).toBeNull()
  const restored = await request(`${root}/pulls/1`, "PATCH", { body: input.body })
  expect((await restored.json()).body).toBe(input.body)
})

test("list filters precede pagination and links retain filters and namespace paths", async () => {
  const { runtime, request, clock } = setup()
  for (let i = 0; i < 4; i++) {
    await request(`${root}/git/refs`, "POST", { ref: `refs/heads/topic-${i}`, sha: b })
    await request(`${root}/pulls`, "POST", {
      ...input,
      head: `topic-${i}`,
      base: i === 0 ? "release" : "main",
    })
    clock.advance(1000)
  }
  const first = await request(`${root}/pulls?base=main&per_page=1&direction=asc`)
  expect((await first.json()).map((pr: { number: number }) => pr.number)).toEqual([2])
  const link = first.headers.get("link") ?? ""
  expect(link).toContain('rel="next"')
  expect(link).toContain("base=main")
  const next = /<([^>]+)>; rel="next"/.exec(link)?.[1]
  if (!next) throw new Error("Missing next link")
  expect((await (await request(next)).json()).map((pr: { number: number }) => pr.number)).toEqual([
    3,
  ])
  const last = await request(`${root}/pulls?base=main&per_page=1&page=3&direction=asc`)
  expect(last.headers.get("link")).not.toContain('rel="next"')
  const filtered = await request(`${root}/pulls?head=SYNTHETIC-ORG:topic-2&base=main`)
  expect((await filtered.json()).map((pr: { number: number }) => pr.number)).toEqual([3])
  expect(filtered.headers.get("link")).toBeNull()
  const scoped = await runtime.fetch(new Request(`http://github.mock/ns/a${root}/pulls?per_page=1`))
  const scopedNext = /<([^>]+)>; rel="next"/.exec(scoped.headers.get("link") ?? "")?.[1]
  if (!scopedNext) throw new Error("Missing namespace next link")
  expect(new URL(scopedNext).pathname).toStartWith("/ns/a/")
  expect((await runtime.fetch(new Request(scopedNext))).status).toBe(200)
})

test("lost caller acknowledgement is reconciled by head/base lookup and Timeline", async () => {
  const { runtime, request } = setup()
  const before = await (await request("/__admin/checkpoints", "POST", {})).json()
  const lost = async () => {
    const response = await request(`${root}/pulls`, "POST", input)
    expect(response.status).toBe(201)
    throw new TypeError("Synthetic response loss")
  }
  let error: unknown
  try {
    await lost()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(TypeError)
  const observed = await (await request(`${root}/pulls?head=synthetic-org:topic&base=main`)).json()
  expect(observed).toHaveLength(1)
  expect(observed[0]).toMatchObject({ number: 1, title: input.title })
  expect(JSON.stringify(runtime.journal.list())).not.toContain(input.body)
  await request("/__admin/branches/main/checkout", "POST", { checkpoint: before.id })
  expect(await (await request(`${root}/pulls`)).json()).toEqual([])
})

test("missing branches and unchanged ancestry reject; unsupported features stay explicit", async () => {
  const { request, runtime } = setup()
  for (const body of [
    { ...input, head: "missing" },
    { ...input, base: "missing" },
    { ...input, head: "main" },
    { ...input, title: "" },
  ])
    expect((await request(`${root}/pulls`, "POST", body)).status).toBe(422)
  for (const body of [
    { ...input, issue: 1 },
    { ...input, head: "another-org:topic" },
    { ...input, head_repo: "another" },
  ])
    expect((await request(`${root}/pulls`, "POST", body)).status).toBe(501)
  expect((await request(`${root}/pulls?sort=popularity`)).status).toBe(501)
  expect((await request(`${root}/pulls?per_page=0`)).status).toBe(422)
  runtime.instance("a").state.seed({ ...fixture, name: "second" })
  const response = await request("/repos/synthetic-org/second/pulls", "POST", input)
  expect(response.status).toBe(201)
  expect((await response.json()).number).toBe(1)
})

test("pagination defaults to30, clamps100, and updated sorting reflects edits", async () => {
  const { runtime, request, clock } = setup()
  runtime.instance("a").state.seed({
    ...fixture,
    name: "pages",
    branches: {
      main: a,
      ...Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`topic-${i}`, b])),
    },
  })
  const path = "/repos/synthetic-org/pages/pulls"
  for (let i = 0; i < 105; i++) {
    const created = await request(path, "POST", { ...input, head: `topic-${i}` })
    expect(created.status).toBe(201)
    clock.advance(1000)
  }
  expect(await (await request(path)).json()).toHaveLength(30)
  expect(await (await request(`${path}?per_page=1000`)).json()).toHaveLength(100)
  expect(await (await request(`${path}?per_page=1000&page=2`)).json()).toHaveLength(5)
  await request(`${path}/1`, "PATCH", { title: "Newest update" })
  const sorted = await (await request(`${path}?sort=updated&direction=desc&per_page=1`)).json()
  expect(sorted[0].number).toBe(1)
})

test("closed duplicates can be recreated, but reopening cannot create two open pairs", async () => {
  const { request } = setup()
  await request(`${root}/pulls`, "POST", input)
  await request(`${root}/pulls/1`, "PATCH", { state: "closed" })
  const second = await request(`${root}/pulls`, "POST", input)
  expect(second.status).toBe(201)
  expect((await second.json()).number).toBe(2)
  expect((await request(`${root}/pulls/1`, "PATCH", { state: "open" })).status).toBe(422)
  expect(await (await request(`${root}/pulls/1`)).json()).toMatchObject({ state: "closed" })
})

test("invalid JSON and non-object updates do not mutate a PR", async () => {
  const { request, runtime } = setup()
  await request(`${root}/pulls`, "POST", input)
  const before = await (await request(`${root}/pulls/1`)).json()
  expect((await request(`${root}/pulls/1`, "PATCH", [])).status).toBe(422)
  const invalid = await runtime.fetch(
    new Request(`http://github.mock${root}/pulls/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": "a" },
      body: "{",
    }),
  )
  expect(invalid.status).toBe(400)
  expect(await (await request(`${root}/pulls/1`)).json()).toEqual(before)
})
