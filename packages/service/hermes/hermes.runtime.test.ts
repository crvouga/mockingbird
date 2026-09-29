import { expect, test } from "bun:test"
import { Collection, createClock } from "@crvouga/mockingbird-service"
import { createRuntime, type HermesRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const request = (runtime: HermesRuntime, path: string, namespace = "a", body?: unknown) =>
  runtime.fetch(
    new Request(`http://hermes.local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-mockingbird-namespace": namespace, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

// Test-owned records independently exercise the shared storage controls.
const records = (runtime: HermesRuntime, namespace: string) => {
  const api = runtime.instance(namespace)
  return new Collection<{ value: string }>(api.sqlite, api.namespace, "scaffold-test")
}

test("health, namespace carriers, scoped faults and reset use the shared runtime", async () => {
  const runtime = createRuntime()
  const health = await request(runtime, "/health")
  expect(health.status).toBe(200)
  expect(await health.json()).toMatchObject({ service: "hermes" })
  records(runtime, "a").insert("same", { value: "a" })
  records(runtime, "b").insert("same", { value: "b" })
  const fault = await request(runtime, "/__admin/faults", "a", {
    operationId: "RunGet",
    status: 503,
    body: { message: "synthetic outage" },
  })
  expect(fault.status).toBe(201)
  expect((await request(runtime, "/v1/runs/example")).status).toBe(503)
  const other = await runtime.fetch(new Request("http://hermes.local/ns/b/v1/runs/example"))
  expect(other.status).toBe(404)
  expect(other.headers.get("x-mockingbird")).toContain("ns=b")
  expect(runtime.journal.list({ namespace: "a" })).toHaveLength(1)
  expect(runtime.journal.list({ namespace: "b" })).toHaveLength(1)
  expect((await request(runtime, "/__admin/reset", "a", {})).status).toBe(200)
  expect(records(runtime, "a").get("same")).toBeUndefined()
  expect(records(runtime, "b").get("same")).toEqual({ value: "b" })
  // Shared reset preserves diagnostic history; DELETE /__admin/requests clears it.
  expect(runtime.journal.list({ namespace: "a" })).toHaveLength(1)
  expect(runtime.journal.list({ namespace: "b" })).toHaveLength(1)
  // Reset clears service state and Timeline, but intentionally retains fault configuration.
  expect((await request(runtime, "/v1/runs/example")).status).toBe(503)
  const cleared = await runtime.fetch(
    new Request("http://hermes.local/__admin/faults", { method: "DELETE" }),
  )
  expect(cleared.status).toBe(200)
  expect((await request(runtime, "/v1/runs/example")).status).toBe(404)
})

test("journal retains operation metadata without bodies, credentials or query values", async () => {
  const runtime = createRuntime()
  await runtime.fetch(
    new Request("http://hermes.local/v1/runs?token=synthetic-query-secret", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-header-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: "synthetic-body-prompt",
        instructions: "synthetic-result-text",
      }),
    }),
  )
  const response = await request(runtime, "/__admin/requests", "default")
  const body = (await response.json()) as { requests: { operationId: string; status: number }[] }
  expect(body.requests).toHaveLength(1)
  expect(body.requests[0]).toMatchObject({ operationId: "RunCreate", status: 202 })
  const serialized = JSON.stringify(body)
  for (const sensitive of [
    "synthetic-query-secret",
    "synthetic-header-secret",
    "synthetic-body-prompt",
    "synthetic-result-text",
  ]) {
    expect(serialized).not.toContain(sensitive)
  }
})

test("shared Timeline checkpoints restore stored records and clock without crossing namespaces", async () => {
  const clock = createClock(() => 1_700_000_000_000)
  clock.freeze()
  const runtime = createRuntime({ clock })
  const a = records(runtime, "a")
  const b = records(runtime, "b")
  a.insert("item", { value: "original" })
  b.insert("item", { value: "other namespace" })
  const response = await request(runtime, "/__admin/checkpoints", "a", {})
  expect(response.status).toBe(201)
  const checkpoint = (await response.json()) as { id: string }
  expect(checkpoint.id).toMatch(/^cp_/)
  a.update("item", { value: "changed" })
  await request(runtime, "/__admin/clock", "a", { advance: 60_000 })
  expect(clock.now()).toBe(1_700_000_060_000)
  expect(
    (await request(runtime, "/__admin/branches/main/checkout", "a", { checkpoint: checkpoint.id }))
      .status,
  ).toBe(200)
  expect(a.get("item")).toEqual({ value: "original" })
  expect(b.get("item")).toEqual({ value: "other namespace" })
  expect(clock.now()).toBe(1_700_000_000_000)
  expect(
    (await request(runtime, "/__admin/branches/main/checkout", "b", { checkpoint: checkpoint.id }))
      .status,
  ).toBe(409)
  expect(b.get("item")).toEqual({ value: "other namespace" })
})

test("Node HTTP entry point serves submission, polling and shared controls", async () => {
  const server = await createServer()
  try {
    expect((await fetch(`${server.url}/v1/runs/example`)).status).toBe(404)
    expect((await fetch(`${server.url}/health`)).status).toBe(200)
    const accepted = await fetch(`${server.url}/v1/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "synthetic" }),
    })
    expect(accepted.status).toBe(202)
    const { run_id } = (await accepted.json()) as { run_id: string }
    const polled = await fetch(`${server.url}/v1/runs/${run_id}`)
    expect(polled.status).toBe(200)
    expect(await polled.json()).toMatchObject({ run_id, status: "queued" })
    const missingStop = await fetch(`${server.url}/v1/runs/example/stop`, { method: "POST" })
    expect(missingStop.status).toBe(404)
  } finally {
    await server.close()
  }
})

test("CLI advertises the shared serve command without starting a server", async () => {
  const process = Bun.spawn(["bun", "src/cli.ts", "--help"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect(exit).toBe(0)
  expect(err).toBe("")
  expect(out).toContain("mockingbird-hermes")
  expect(out).toContain("serve")
})
