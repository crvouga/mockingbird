import { expect, test } from "bun:test"
import { findOperation, responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { createRuntime, type DockerRuntime, document } from "./src/index.js"

const image = `sha256:${"a".repeat(64)}`
const call = (r: DockerRuntime, path: string, body?: unknown, headers = {}) =>
  r.fetch(
    new Request(`http://docker.local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const seed = (r: DockerRuntime) =>
  call(r, "/__admin/docker/seed", {
    images: [
      {
        id: image,
        tags: ["synthetic:latest"],
        config: { Cmd: ["worker"], Env: ["BASE=yes", "OVERRIDE=image"], Labels: { base: "yes" } },
      },
    ],
  })

test("create persists launch metadata while keeping execution stopped", async () => {
  const r = createRuntime()
  expect((await seed(r)).status).toBe(201)
  const response = await call(r, "/v1.52/containers/create?name=launcher", {
    Image: "synthetic",
    Cmd: ["run", "task"],
    Entrypoint: ["entry"],
    Env: ["OVERRIDE=request"],
    Labels: { owner: "suite" },
    WorkingDir: "/work",
    User: "1000",
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    StopSignal: "SIGTERM",
    StopTimeout: 7,
    HostConfig: { ReadonlyRootfs: true, NetworkMode: "none", Memory: 1024 },
    NetworkingConfig: { EndpointsConfig: { isolated: { Aliases: ["worker"] } } },
  })
  expect(response.status).toBe(201)
  const created = (await response.json()) as { Id: string; Warnings: string[] }
  const operation = findOperation(document, "ContainerCreate")
  const schema =
    operation && responseForStatus(operation.responses, 201)?.content?.["application/json"]?.schema
  if (!schema) throw new Error("Missing create response schema")
  expect(validateValue(document, schema, created)).toEqual([])
  expect(created.Id).toMatch(/^[a-f0-9]{64}$/)
  expect(created.Id).not.toBe(image.slice(7))
  const inspect = await (await call(r, `/containers/${created.Id}/json`)).json()
  expect(inspect).toMatchObject({
    Id: created.Id,
    Image: image,
    Name: "/launcher",
    Path: "entry",
    Args: ["run", "task"],
    State: { Status: "created", Running: false, Pid: 0 },
    Config: {
      Image: "synthetic",
      Cmd: ["run", "task"],
      Env: ["OVERRIDE=request", "BASE=yes"],
      Labels: { base: "yes", owner: "suite" },
      OpenStdin: true,
      StdinOnce: true,
      StopSignal: "SIGTERM",
      StopTimeout: 7,
    },
    HostConfig: { ReadonlyRootfs: true, Memory: 1024 },
    NetworkSettings: { Networks: { isolated: { Aliases: ["worker"] } } },
  })
  expect(await (await call(r, "/containers/json")).json()).toEqual([])
})

test("concurrent duplicate names yield one creation and one conflict", async () => {
  const r = createRuntime()
  await seed(r)
  const responses = await Promise.all([
    call(r, "/containers/create?name=same", { Image: "synthetic" }),
    call(r, "/containers/create?name=same", { Image: "synthetic" }),
  ])
  expect(responses.map((x) => x.status).sort()).toEqual([201, 409])
  expect(await (await call(r, "/containers/json?all=1")).json()).toHaveLength(1)
})

test("missing images, invalid inputs and platform mismatch do not persist containers", async () => {
  const r = createRuntime()
  await seed(r)
  expect((await call(r, "/containers/create", { Image: "missing", Cmd: ["run"] })).status).toBe(404)
  expect(
    (await call(r, "/containers/create?platform=linux/arm64", { Image: "synthetic" })).status,
  ).toBe(404)
  for (const body of [
    null,
    [],
    { Image: "synthetic", Cmd: 1 },
    { Image: "synthetic", OpenStdin: "true" },
    { Image: "synthetic", HostConfig: [] },
    { Image: "synthetic", WorkingDir: "relative" },
    { Image: "synthetic", StopSignal: "NOT_A_SIGNAL" },
  ]) {
    expect((await call(r, "/containers/create", body)).status).toBe(400)
  }
  expect((await call(r, "/containers/create?name=invalid!", { Image: "synthetic" })).status).toBe(
    400,
  )
  expect(await (await call(r, "/containers/json?all=1")).json()).toEqual([])
  expect(
    (await call(r, "/containers/create", { Image: "synthetic", Healthcheck: {} })).status,
  ).toBe(501)
  const malformed = await r.fetch(
    new Request("http://docker.local/containers/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  )
  expect(malformed.status).toBe(400)
})

test("created records and ID sequence participate in checkout and reset", async () => {
  const r = createRuntime()
  await seed(r)
  const checkpoint = (await (await call(r, "/__admin/checkpoints", {})).json()) as { id: string }
  const first = await call(r, "/containers/create?name=one", { Image: "synthetic" })
  expect(first.status).toBe(201)
  expect(first.headers.get("x-mockingbird-checkpoint")).toMatch(/^cp_/)
  const id = ((await first.json()) as { Id: string }).Id
  await call(r, "/__admin/branches/main/checkout", { checkpoint: checkpoint.id })
  expect((await call(r, `/containers/${id}/json`)).status).toBe(404)
  expect(
    (
      (await (await call(r, "/containers/create?name=one", { Image: "synthetic" })).json()) as {
        Id: string
      }
    ).Id,
  ).toBe(id)
  await call(r, "/__admin/reset", {})
  expect((await call(r, `/containers/${id}/json`)).status).toBe(404)
  expect((await call(r, "/containers/create", { Image: "synthetic" })).status).toBe(404)
})

test("image defaults, entrypoint clearing, generated names and platform warnings are explicit", async () => {
  const r = createRuntime()
  expect(
    (
      await call(r, "/__admin/docker/seed", {
        images: [
          {
            id: image,
            tags: ["synthetic:latest"],
            platform: "linux/arm64",
            config: { Entrypoint: ["image-entry"], Cmd: ["image-command"] },
          },
        ],
      })
    ).status,
  ).toBe(201)
  expect((await call(r, "/containers/create?name=/", { Image: "synthetic" })).status).toBe(400)
  const create = await call(r, "/containers/create", {
    Image: "synthetic",
    Entrypoint: [""],
    Cmd: ["replacement"],
  })
  expect(create.status).toBe(201)
  const value = (await create.json()) as { Id: string; Warnings: string[] }
  expect(value.Warnings).toHaveLength(1)
  expect(value.Warnings[0]).toContain("linux/arm64")
  expect(await (await call(r, `/containers/${value.Id}/json`)).json()).toMatchObject({
    Name: expect.stringMatching(/^\/mockingbird_/),
    Config: { Entrypoint: [], Cmd: ["replacement"] },
  })
  expect(
    (
      await call(r, "/containers/create?platform=linux/arm64", {
        Image: "synthetic",
        Entrypoint: [""],
      })
    ).status,
  ).toBe(400)
  const exact = await call(r, "/containers/create?platform=linux/arm64", { Image: "synthetic" })
  expect(exact.status).toBe(201)
  expect(await exact.json()).toMatchObject({ Warnings: [] })
})

test("an explicit nonempty entrypoint suppresses the image command default", async () => {
  // Engine29.1.0 daemon/commit.go:72–79 only merges Cmd inside len(Entrypoint)==0.
  const r = createRuntime()
  await seed(r)
  const response = await call(r, "/containers/create", {
    Image: "synthetic",
    Entrypoint: ["entry"],
  })
  expect(response.status).toBe(201)
  const { Id } = (await response.json()) as { Id: string }
  expect(await (await call(r, `/containers/${Id}/json`)).json()).toMatchObject({
    Path: "entry",
    Args: [],
    Config: { Cmd: [], Entrypoint: ["entry"] },
  })
})
