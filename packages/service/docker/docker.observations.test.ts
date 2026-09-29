import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createRuntime, type DockerRuntime, document } from "./src/index.js"

const imageId = `sha256:${"a".repeat(64)}`
const runningId = "b".repeat(64)
const stoppedId = "c".repeat(64)
const call = (runtime: DockerRuntime, path: string, body?: unknown, namespace = "a") =>
  runtime.fetch(
    new Request(`http://docker.local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const seed = (runtime: DockerRuntime) =>
  call(runtime, "/__admin/docker/seed", {
    images: [{ id: imageId, tags: ["synthetic:latest"] }],
    containers: [
      {
        id: runningId,
        name: "worker",
        image: "synthetic:latest",
        status: "running",
        labels: { suite: "one", role: "worker" },
      },
      {
        id: stoppedId,
        name: "retired",
        image: "synthetic:latest",
        status: "exited",
        exitCode: 17,
        labels: { suite: "one" },
      },
    ],
    daemon: { rootless: true },
  })

test("seeded image and container identities agree across inspect, list and info", async () => {
  const runtime = createRuntime()
  expect((await seed(runtime)).status).toBe(201)
  const inspect = await call(runtime, "/v1.52/containers/worker/json?size=1")
  expect(inspect.status).toBe(200)
  expect(await inspect.json()).toMatchObject({
    Id: runningId,
    Image: imageId,
    Name: "/worker",
    Config: { Image: "synthetic:latest" },
    State: { Running: true, Status: "running" },
    SizeRw: 0,
  })
  expect(await (await call(runtime, "/containers/json")).json()).toMatchObject([
    { Id: runningId, ImageID: imageId },
  ])
  expect(await (await call(runtime, "/info")).json()).toMatchObject({
    Containers: 2,
    ContainersRunning: 1,
    ContainersStopped: 1,
    Images: 1,
    SecurityOptions: ["name=rootless"],
  })
  expect(await (await call(runtime, "/version")).json()).toMatchObject({
    Version: "29.1.0",
    ApiVersion: "1.52",
    MinAPIVersion: "1.44",
  })
  expect(runtime.journal.list({ namespace: "a" })[0]).toMatchObject({
    operationId: "ContainerInspect",
  })
  expect(await (await call(runtime, "/containers/json?all=1", undefined, "b")).json()).toEqual([])
})

test("filters, ordering, size and lookup errors obey the bounded observation contract", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  const list = async (filters: unknown, extra = "") =>
    (
      await call(
        runtime,
        `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}${extra}`,
      )
    ).json()
  expect(await list({ status: ["exited"] })).toMatchObject([{ Id: stoppedId }])
  expect(await list({ label: ["suite=one", "role=worker"] }, "&all=1")).toMatchObject([
    { Id: runningId },
  ])
  expect(await list({ name: ["^/worker$"] })).toMatchObject([{ Id: runningId }])
  expect(await list({ exited: ["17"] }, "&all=1")).toMatchObject([{ Id: stoppedId }])
  expect(await (await call(runtime, "/containers/json?limit=1")).json()).toMatchObject([
    { Id: stoppedId },
  ])
  expect((await call(runtime, "/containers/absent/json")).status).toBe(404)
  expect((await call(runtime, "/containers/json?filters=bad")).status).toBe(400)
  expect(await (await call(runtime, "/containers/json?all=invalid")).json()).toHaveLength(2)
  expect(await list({ status: { exited: false } })).toMatchObject([{ Id: stoppedId }])
  expect(await (await call(runtime, "/containers/json?filters=null")).json()).toHaveLength(1)
  expect(
    (
      await call(
        runtime,
        `/containers/json?filters=${encodeURIComponent('{"ancestor":["synthetic"]}')}`,
      )
    ).status,
  ).toBe(501)
})

test("version policy distinguishes provider rejection from unsupported mock versions", async () => {
  const runtime = createRuntime()
  for (const [version, status] of [
    ["1.53", 400],
    ["1.43", 400],
    ["1.45", 501],
    ["1.52", 200],
  ] as const) {
    expect((await call(runtime, `/v${version}/version`)).status).toBe(status)
  }
  const old = await call(runtime, "/v1.23/info")
  expect(old.status).toBe(400)
  expect(old.headers.get("content-type")).toContain("text/plain")
})

test("seed is atomic and daemon availability does not change stored execution state", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  const bad = await call(runtime, "/__admin/docker/seed", {
    images: [{ id: `sha256:${"d".repeat(64)}`, tags: ["bad:latest"] }],
    containers: [{ id: "e".repeat(64), name: "worker", image: "bad:latest" }],
  })
  expect(bad.status).toBe(409)
  expect(await (await call(runtime, "/info")).json()).toMatchObject({ Images: 1, Containers: 2 })
  const checkpoint = (await (await call(runtime, "/__admin/checkpoints", {})).json()) as {
    id: string
  }
  expect((await call(runtime, "/__admin/docker/daemon", { available: false })).status).toBe(200)
  await expect(call(runtime, "/_ping")).rejects.toThrow()
  expect((await call(runtime, "/health")).status).toBe(200)
  await call(runtime, "/__admin/docker/daemon", { available: true })
  expect(await (await call(runtime, "/containers/worker/json")).json()).toMatchObject({
    State: { Running: true },
  })
  await call(runtime, "/__admin/docker/daemon", { rootless: false })
  expect(
    (await call(runtime, "/__admin/branches/main/checkout", { checkpoint: checkpoint.id })).status,
  ).toBe(200)
  expect(await (await call(runtime, "/info")).json()).toMatchObject({
    ContainersRunning: 1,
    SecurityOptions: ["name=rootless"],
  })
  await call(runtime, "/__admin/reset", {})
  expect(await (await call(runtime, "/containers/json?all=1")).json()).toEqual([])
  // Reset invalidates history rather than allowing removed state to reappear.
  expect(
    (await call(runtime, "/__admin/branches/main/checkout", { checkpoint: checkpoint.id })).status,
  ).toBe(409)
})

test("malformed seed and query values cannot partially modify synthetic records", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  for (const body of [
    null,
    [],
    { containers: "bad" },
    { daemon: { available: "false" } },
    { daemon: { arbitrary: true } },
    {
      containers: [
        { id: "f".repeat(64), name: "valid", image: "synthetic:latest", labels: { unsafe: 1 } },
      ],
    },
  ]) {
    expect((await call(runtime, "/__admin/docker/seed", body)).status).toBe(400)
  }
  expect(await (await call(runtime, "/info")).json()).toMatchObject({ Images: 1, Containers: 2 })
  for (const query of [
    "filters=[]",
    "limit=1.5",
    `filters=${encodeURIComponent('{"status":["unknown"]}')}`,
    `filters=${encodeURIComponent('{"exited":["oops"]}')}`,
  ]) {
    expect((await call(runtime, `/containers/json?${query}`)).status).toBe(400)
  }
  const unsupported = await call(
    runtime,
    `/containers/json?filters=${encodeURIComponent('{"name":["(a+)+$"]}')}`,
  )
  expect(unsupported.status).toBe(501)
})

test("successful seeded observations conform to their declared response schemas", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  for (const [path, id] of [
    ["/containers/worker/json", "ContainerInspect"],
    ["/containers/json?all=1&size=1", "ContainerList"],
    ["/info", "SystemInfo"],
    ["/version", "SystemVersion"],
  ] as const) {
    const response = await call(runtime, path)
    expect(response.status).toBe(200)
    const operation = findOperation(document, id)
    if (!operation) throw new Error(`Missing operation: ${path}`)
    const schema = responseForStatus(operation.responses, 200)?.content?.["application/json"]
      ?.schema
    if (!schema) throw new Error(`Missing response schema: ${path}`)
    expect(validateValue(document, schema, await response.json())).toEqual([])
  }
})

test("versioned namespaced requests retain fault matching and isolated reset", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  expect(
    (
      await call(
        runtime,
        "/__admin/docker/seed",
        { images: [{ id: imageId, tags: ["other:latest"] }] },
        "b",
      )
    ).status,
  ).toBe(201)
  await call(runtime, "/__admin/faults", { operationId: "SystemInfo", status: 500, count: 1 })
  expect((await runtime.fetch(new Request("http://docker.local/ns/a/v1.52/info"))).status).toBe(500)
  expect((await call(runtime, "/v1.52/info", undefined, "b")).status).toBe(200)
  await call(runtime, "/__admin/reset", {})
  expect(await (await call(runtime, "/info")).json()).toMatchObject({
    Containers: 0,
    Images: 0,
    SecurityOptions: [],
  })
  expect(await (await call(runtime, "/info", undefined, "b")).json()).toMatchObject({ Images: 1 })
})

test("full IDs and names win over prefixes; ambiguous prefixes are rejected", async () => {
  const runtime = createRuntime()
  await seed(runtime)
  expect(
    (
      await call(runtime, "/__admin/docker/seed", {
        containers: [{ id: `b${"d".repeat(63)}`, name: "second", image: "synthetic:latest" }],
      })
    ).status,
  ).toBe(201)
  const ambiguous = await call(runtime, "/containers/b/json")
  expect(ambiguous.status).toBe(400)
  expect(await ambiguous.json()).toEqual({ message: "multiple IDs found with provided prefix: b" })
  expect(await (await call(runtime, `/containers/${runningId}/json`)).json()).toMatchObject({
    Id: runningId,
  })
  expect(await (await call(runtime, "/containers/worker/json")).json()).toMatchObject({
    Id: runningId,
  })
  expect(await (await call(runtime, "/containers/cc/json")).json()).toMatchObject({ Id: stoppedId })
})

test("list status text follows seeded lifecycle and the controlled clock", async () => {
  const runtime = createRuntime()
  await call(runtime, "/__admin/clock", { set: 1700000000000, freeze: true })
  await seed(runtime)
  expect(await (await call(runtime, "/containers/json")).json()).toMatchObject([
    { State: "running", Status: "Up Less than a second" },
  ])
  await call(runtime, "/__admin/clock", { advance: 60000 })
  expect(await (await call(runtime, "/containers/json?all=1")).json()).toMatchObject([
    { State: "exited", Status: "Exited (17) About a minute ago" },
    { State: "running", Status: "Up About a minute" },
  ])
})

test("ID list filters exclude empty and ambiguous prefixes but retain unique matches", async () => {
  const runtime = createRuntime()
  await call(runtime, "/__admin/docker/seed", {
    images: [{ id: imageId, tags: ["synthetic:latest"] }],
    containers: [{ id: runningId, name: "only", image: "synthetic:latest", status: "running" }],
  })
  const byId = async (id: string) =>
    (
      await call(
        runtime,
        `/containers/json?filters=${encodeURIComponent(JSON.stringify({ id: [id] }))}`,
      )
    ).json()
  expect(await byId("")).toEqual([])
  expect(await byId("b")).toMatchObject([{ Id: runningId }])
  await call(runtime, "/__admin/docker/seed", {
    containers: [
      { id: `b${"d".repeat(63)}`, name: "second", image: "synthetic:latest", status: "running" },
    ],
  })
  expect(await byId("b")).toEqual([])
  expect(await byId("bb")).toMatchObject([{ Id: runningId }])
})
