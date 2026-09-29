import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, document } from "./src/index.js"
import { createServer } from "./src/server.js"

const fixture = { owner: "synthetic-org", name: "example" }
test("HTTP server exposes repository observations and shared health", async () => {
  const server = await createServer()
  try {
    expect((await fetch(`${server.url}/health`)).status).toBe(200)
    expect(
      (
        await fetch(`${server.url}/__admin/github/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fixture),
        })
      ).status,
    ).toBe(201)
    const response = await fetch(`${server.url}/repos/synthetic-org/example`, {
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      full_name: "synthetic-org/example",
      default_branch: "main",
    })
  } finally {
    await server.close()
  }
})
test("repository responses conform to the declared reduced contract", async () => {
  const runtime = createRuntime()
  const op = findOperation(document, "repos/get")
  if (!op) throw new Error("Missing repository operation")
  for (const exists of [false, true]) {
    if (exists) runtime.instance().state.seed(fixture)
    const response = await runtime.fetch(
      new Request("https://api.github.com/repos/synthetic-org/example"),
    )
    const schema = responseForStatus(op.responses, response.status)?.content?.["application/json"]
      ?.schema
    if (!schema) throw new Error(`Missing schema for ${response.status}`)
    expect(validateValue(document, schema, await response.json())).toEqual([])
  }
})
test("clock and faults preserve repository observations and namespace isolation", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const runtime = createRuntime({ clock })
  const repo = runtime.instance("a").state.seed(fixture)
  expect(repo.created_at).toBe("2023-11-14T22:13:20.000Z")
  const configure = await runtime.fetch(
    new Request("http://github.mock/__admin/faults", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": "a" },
      body: JSON.stringify({
        operationId: "repos/get",
        status: 503,
        count: 1,
        body: { message: "synthetic outage" },
      }),
    }),
  )
  expect(configure.status).toBe(201)
  const read = (namespace: string) =>
    runtime.fetch(
      new Request("http://github.mock/repos/synthetic-org/example", {
        headers: { "x-mockingbird-namespace": namespace },
      }),
    )
  expect((await read("b")).status).toBe(404)
  expect((await read("a")).status).toBe(503)
  expect((await read("a")).status).toBe(200)
  expect(runtime.instance("a").state.repository("synthetic-org", "example")).toEqual(repo)
})
test("CLI help advertises the shared serve command", async () => {
  const child = Bun.spawn(["bun", "src/cli.ts", "--help"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(0)
  expect(err).toBe("")
  expect(out).toContain("mockingbird-github")
  expect(out).toContain("serve")
})
