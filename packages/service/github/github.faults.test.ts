import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createRuntime, document } from "./src/index.js"

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  d = "d".repeat(40)
const root = "/repos/synthetic-org/example"
const input = { title: "Synthetic", head: "topic", base: "main", body: "private-fixture-body" }
const setup = () => {
  const runtime = createRuntime()
  for (const ns of ["a", "other"])
    runtime.instance(ns).state.seed({
      owner: "synthetic-org",
      name: "example",
      commits: [
        { sha: a, parents: [] },
        { sha: b, parents: [a] },
        { sha: c, parents: [b] },
        { sha: d, parents: [a] },
      ],
      branches: { main: a, topic: b },
    })
  const call = (path: string, method = "GET", body?: unknown, ns = "a") =>
    runtime.fetch(
      new Request(`http://github.mock${path}`, {
        method,
        headers: { "content-type": "application/json", "x-mockingbird-namespace": ns },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const preset = async (name: string) =>
    expect((await call("/__admin/faults", "POST", { preset: name })).status).toBe(201)
  return { runtime, call, preset }
}

for (const [operation, presetName, path, method, body] of [
  ["pulls/create", "github_pr_create_accepted_drop", `${root}/pulls`, "POST", input],
  [
    "pulls/update",
    "github_pr_update_accepted_drop",
    `${root}/pulls/1`,
    "PATCH",
    { title: "Changed" },
  ],
  [
    "git/create-ref",
    "github_ref_create_accepted_drop",
    `${root}/git/refs`,
    "POST",
    { ref: "refs/heads/new", sha: b },
  ],
  [
    "git/update-ref",
    "github_ref_update_accepted_drop",
    `${root}/git/refs/heads/topic`,
    "PATCH",
    { sha: c },
  ],
] as const)
  test(`${operation} accepted loss preserves state and restorable metadata-only history`, async () => {
    const { runtime, call, preset } = setup()
    if (operation === "pulls/update") await call(`${root}/pulls`, "POST", input)
    const before = runtime.checkpoint("a")
    await preset(presetName)
    const failure = await call(path, method, body).then(
      () => null,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(TypeError)
    const head = runtime.timeline("a").head("main")
    if (!head) throw new Error("Missing accepted checkpoint")
    expect(head.id).not.toBe(before.id)
    const logs = runtime.journal.list({ operationId: operation }).filter((x) => x.status === 0)
    expect(logs).toMatchObject([{ accepted: true, checkpoint: head.id }])
    expect(JSON.stringify(logs)).not.toContain("private-fixture-body")
    const observe = () =>
      call(
        operation.startsWith("pulls/")
          ? `${root}/pulls`
          : `${root}/git/ref/heads/${operation === "git/create-ref" ? "new" : "topic"}`,
      )
    const accepted = await (await observe()).json()
    if (operation.startsWith("pulls/"))
      expect(accepted).toMatchObject([
        { number: 1, title: operation === "pulls/update" ? "Changed" : "Synthetic" },
      ])
    else expect(accepted.object.sha).toBe(operation === "git/create-ref" ? b : c)
    expect(await (await call(`${root}/pulls`, "GET", undefined, "other")).json()).toEqual([])
    runtime.checkout(before.id, { namespace: "a" })
    if (operation === "pulls/create") expect(await (await observe()).json()).toEqual([])
    if (operation === "pulls/update")
      expect(await (await observe()).json()).toMatchObject([{ title: "Synthetic" }])
    if (operation === "git/create-ref") expect((await observe()).status).toBe(404)
    if (operation === "git/update-ref")
      expect(await (await observe()).json()).toMatchObject({ object: { sha: b } })
    runtime.checkout(head.id, { namespace: "a" })
    expect(await (await observe()).json()).toEqual(accepted)
    const retry = await call(path, method, body)
    expect(retry.status).toBe(
      operation.endsWith("create") || operation === "git/create-ref" ? 422 : 200,
    )
  })

test("pre-mutation unavailable, denied and rate-limit presets leave provider state untouched", async () => {
  for (const [name, status] of [
    ["github_unavailable", 503],
    ["github_denied", 403],
    ["github_rate_limited", 429],
  ] as const) {
    const { runtime, call, preset } = setup()
    const before = runtime.checkpoint("a")
    await preset(name)
    const response = await call(`${root}/pulls`, "POST", input)
    expect(response.status).toBe(status)
    const body = await response.json()
    expect(body.message).toBeString()
    const operation = findOperation(document, "pulls/create")
    if (!operation) throw new Error("Missing PR create contract")
    const schema = responseForStatus(operation.responses, status)?.content?.["application/json"]
      ?.schema
    if (!schema) throw new Error("Missing scripted response schema")
    expect(validateValue(document, schema, body)).toEqual([])
    if (status === 429) {
      expect(response.headers.get("retry-after")).toBe("60")
      expect(response.headers.get("x-ratelimit-remaining")).toBe("1")
    }
    expect(await (await call(`${root}/pulls`)).json()).toEqual([])
    expect(runtime.timeline("a").head("main")?.id).toBe(before.id)
    expect(runtime.journal.list({ operationId: "pulls/create" })).toMatchObject([{ status }])
    expect(runtime.journal.list({ operationId: "pulls/create" })[0]?.accepted).toBeUndefined()
    expect((await call(`${root}/pulls`, "POST", input)).status).toBe(201)
  }
})

test("accepted-drop presets never mark invalid writes accepted", async () => {
  const { runtime, call, preset } = setup()
  const before = runtime.checkpoint("a")
  await preset("github_pr_create_accepted_drop")
  expect((await call(`${root}/pulls`, "POST", { ...input, head: "missing" })).status).toBe(422)
  await preset("github_ref_update_accepted_drop")
  expect(
    (await call(`${root}/git/refs/heads/topic`, "PATCH", { sha: "e".repeat(40) })).status,
  ).toBe(422)
  expect(runtime.timeline("a").head("main")?.id).toBe(before.id)
  expect(runtime.journal.list().every((x) => x.accepted !== true)).toBe(true)
})

test("intervening ref control is separate history and stale divergent updates preserve it", async () => {
  const { runtime, call } = setup()
  const before = runtime.checkpoint("a")
  const stale = await (await call(`${root}/git/ref/heads/main`)).json()
  const move = { owner: "synthetic-org", repo: "example", ref: "refs/heads/main", sha: b }
  const moved = await call("/__admin/github/refs/move", "POST", move)
  expect(moved.status).toBe(200)
  expect(await moved.json()).toMatchObject({ simulated: true, reference: { object: { sha: b } } })
  const intervening = runtime.timeline("a").head("main")
  if (!intervening) throw new Error("Missing movement checkpoint")
  expect(intervening.id).not.toBe(before.id)
  expect(
    (await call(`${root}/git/refs/heads/main`, "PATCH", { sha: d, expected_sha: stale.object.sha }))
      .status,
  ).toBe(422)
  expect(runtime.timeline("a").head("main")?.id).toBe(intervening.id)
  expect(await (await call(`${root}/git/ref/heads/main`)).json()).toMatchObject({
    object: { sha: b },
  })
  expect(
    (await call("/__admin/github/refs/move", "POST", { ...move, sha: "e".repeat(40) })).status,
  ).toBe(422)
  expect(runtime.timeline("a").head("main")?.id).toBe(intervening.id)
  expect(
    await (await call(`${root}/git/ref/heads/main`, "GET", undefined, "other")).json(),
  ).toMatchObject({ object: { sha: a } })
  runtime.checkout(before.id, { namespace: "a" })
  expect(await (await call(`${root}/git/ref/heads/main`)).json()).toMatchObject({
    object: { sha: a },
  })
  runtime.checkout(intervening.id, { namespace: "a" })
  expect(await (await call(`${root}/git/ref/heads/main`)).json()).toMatchObject({
    object: { sha: b },
  })
})

test("served accepted PR response loss closes the connection while lookup recovers the PR", async () => {
  const { createServer } = await import("./src/server.js")
  const server = await createServer()
  try {
    server.runtime.instance().state.seed({
      owner: "synthetic-org",
      name: "example",
      commits: [
        { sha: a, parents: [] },
        { sha: b, parents: [a] },
      ],
      branches: { main: a, topic: b },
    })
    server.runtime.applyPreset("github_pr_create_accepted_drop")
    const error = await fetch(`${server.url}${root}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(
      () => null,
      (error) => error,
    )
    expect(error).toBeInstanceOf(Error)
    const found = await fetch(`${server.url}${root}/pulls?head=synthetic-org:topic&base=main`)
    expect(await found.json()).toMatchObject([{ number: 1, head: { sha: b }, base: { sha: a } }])
    expect(server.runtime.journal.list({ operationId: "pulls/create" })).toMatchObject([
      { status: 0, accepted: true },
    ])
  } finally {
    await server.close()
  }
})
