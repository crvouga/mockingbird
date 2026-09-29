import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { SqliteStatement } from "@crvouga/mockingbird-sqlite"
import { createRuntime } from "./src/index.js"

const seed = {
  owner: "synthetic-org",
  name: "example",
  default_branch: "main",
  commits: [
    { sha: "a".repeat(40), parents: [] },
    { sha: "b".repeat(40), parents: ["a".repeat(40)] },
  ],
  branches: { main: "a".repeat(40), topic: "b".repeat(40) },
}
const request = (
  runtime: ReturnType<typeof createRuntime>,
  path: string,
  body?: unknown,
  namespace = "a",
) =>
  runtime.fetch(
    new Request(`http://github.mock${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

test("seeded repository identity is stable and case-insensitive, default branch remains a name", async () => {
  const runtime = createRuntime()
  expect((await request(runtime, "/__admin/github/repositories", seed)).status).toBe(201)
  const response = await request(runtime, "/repos/SYNTHETIC-ORG/EXAMPLE")
  expect(response.status).toBe(200)
  expect(response.headers.get("x-github-api-version-selected")).toBe("2026-03-10")
  const repo = await response.json()
  expect(repo).toMatchObject({
    name: "example",
    full_name: "synthetic-org/example",
    default_branch: "main",
    owner: { login: "synthetic-org" },
  })
  expect(typeof repo.id).toBe("number")
  expect(typeof repo.node_id).toBe("string")
  expect(await (await request(runtime, "/repos/synthetic-org/example")).json()).toEqual(repo)
  expect(
    runtime
      .instance("a")
      .state.isAncestor("synthetic-org", "example", "a".repeat(40), "b".repeat(40)),
  ).toBe(true)
  expect(
    runtime
      .instance("a")
      .state.isAncestor("synthetic-org", "example", "b".repeat(40), "a".repeat(40)),
  ).toBe(false)
})
test("missing repositories and unsupported routes are explicit; namespace reset is isolated", async () => {
  const runtime = createRuntime()
  await request(runtime, "/__admin/github/repositories", seed)
  const missing = await request(runtime, "/repos/synthetic-org/example", undefined, "b")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ message: "Not Found", status: "404" })
  const path = await runtime.fetch(
    new Request("http://github.mock/ns/a/repos/synthetic-org/example"),
  )
  expect(path.status).toBe(200)
  expect((await request(runtime, "/repos/synthetic-org/example/pulls")).status).toBe(200)
  await request(runtime, "/__admin/github/repositories", seed, "b")
  await request(runtime, "/__admin/reset", {}, "a")
  expect((await request(runtime, "/repos/synthetic-org/example")).status).toBe(404)
  expect((await request(runtime, "/repos/synthetic-org/example", undefined, "b")).status).toBe(200)
})
test("invalid ancestry and duplicate seeding never partially change stored repository", async () => {
  const runtime = createRuntime()
  for (const invalid of [
    { ...seed, commits: [{ sha: "b".repeat(40), parents: ["c".repeat(40)] }] },
    { ...seed, commits: [{ sha: "a".repeat(40), parents: ["a".repeat(40)] }] },
    { ...seed, branches: { main: "c".repeat(40) } },
    {
      ...seed,
      commits: [
        { sha: "a".repeat(40), parents: ["b".repeat(40)] },
        { sha: "b".repeat(40), parents: ["a".repeat(40)] },
      ],
    },
  ]) {
    expect((await request(runtime, "/__admin/github/repositories", invalid)).status).toBe(400)
    expect((await request(runtime, "/repos/synthetic-org/example")).status).toBe(404)
  }
  expect((await request(runtime, "/__admin/github/repositories", seed)).status).toBe(201)
  expect(
    (await request(runtime, "/__admin/github/repositories", { ...seed, default_branch: "topic" }))
      .status,
  ).toBe(409)
  expect(
    (await (await request(runtime, "/repos/synthetic-org/example")).json()).default_branch,
  ).toBe("main")
})
test("Timeline restores repository and ancestry, journal omits synthetic body and headers", async () => {
  const runtime = createRuntime()
  const cp = await (await request(runtime, "/__admin/checkpoints", {})).json()
  await request(runtime, "/__admin/github/repositories", seed)
  await runtime.fetch(
    new Request("http://github.mock/repos/synthetic-org/example?secret=synthetic-query", {
      headers: { authorization: "Bearer synthetic-key", "x-mockingbird-namespace": "a" },
    }),
  )
  const journal = JSON.stringify(runtime.journal.list({ namespace: "a" }))
  expect(journal).not.toContain("synthetic-key")
  expect(journal).not.toContain("synthetic-query")
  expect(journal).not.toContain("parents")
  expect(journal).toContain("repos/get")
  expect(
    (await request(runtime, "/__admin/branches/main/checkout", { checkpoint: cp.id })).status,
  ).toBe(200)
  expect((await request(runtime, "/repos/synthetic-org/example")).status).toBe(404)
  expect(
    runtime
      .instance("a")
      .state.isAncestor("synthetic-org", "example", "a".repeat(40), "b".repeat(40)),
  ).toBe(false)
})

test("owner identity is shared and version limitations remain explicit", async () => {
  const runtime = createRuntime()
  await request(runtime, "/__admin/github/repositories", seed)
  await request(runtime, "/__admin/github/repositories", {
    ...seed,
    owner: "SYNTHETIC-ORG",
    name: "second",
  })
  const first = await (await request(runtime, "/repos/synthetic-org/example")).json()
  const second = await (await request(runtime, "/repos/synthetic-org/second")).json()
  expect(second.owner).toEqual(first.owner)
  expect(second.full_name).toBe("synthetic-org/second")
  expect(second.id).not.toBe(first.id)
  const unsupported = await runtime.fetch(
    new Request("http://github.mock/repos/synthetic-org/example", {
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    }),
  )
  expect(unsupported.status).toBe(501)
  expect(await unsupported.json()).toMatchObject({ code: "mockingbird_unsupported" })
  const health = await request(runtime, "/health")
  expect(health.status).toBe(200)
  expect(await health.json()).toMatchObject({ service: "github" })
})

test("deep valid ancestry seeds without relying on the JavaScript call stack", async () => {
  // Native SQLite keeps this large graph test focused on ancestry, not the in-memory SQL engine.
  const database = new Database(":memory:")
  try {
    const runtime = createRuntime({
      sqlite: {
        exec: (sql) => {
          database.exec(sql)
        },
        prepare: (sql) => {
          const statement = database.prepare(sql) as unknown as SqliteStatement
          return {
            run: (...params) => statement.run(...params),
            all: <T>(...params: Parameters<SqliteStatement["all"]>) => statement.all<T>(...params),
            get: <T>(...params: Parameters<SqliteStatement["get"]>) =>
              statement.get<T>(...params) ?? undefined,
          }
        },
        transaction: (fn) => database.transaction(fn)(),
      },
    })
    const id = (n: number) => n.toString(16).padStart(40, "0")
    const commits = Array.from({ length: 100000 }, (_, index) => {
      const n = 100000 - index
      return { sha: id(n), parents: n === 1 ? [] : [id(n - 1)] }
    })
    const response = await request(runtime, "/__admin/github/repositories", {
      ...seed,
      commits,
      branches: { main: id(100000) },
    })
    expect(response.status).toBe(201)
    expect(runtime.instance("a").state.isAncestor(seed.owner, seed.name, id(1), id(100000))).toBe(
      true,
    )
  } finally {
    database.close()
  }
}, 30000)

test("deep cyclic ancestry returns a structured error without partial state", async () => {
  const runtime = createRuntime()
  const id = (n: number) => n.toString(16).padStart(40, "0")
  const commits = Array.from({ length: 100000 }, (_, index) => {
    const n = 100000 - index
    return { sha: id(n), parents: [id(n === 1 ? 100000 : n - 1)] }
  })
  const response = await request(runtime, "/__admin/github/repositories", {
    ...seed,
    commits,
    branches: { main: id(100000) },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: "mockingbird_seed_invalid" })
  expect((await request(runtime, "/repos/synthetic-org/example")).status).toBe(404)
})
