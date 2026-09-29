import { expect, test } from "bun:test"
import { createRuntime, type DockerRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const id = "d".repeat(64)
const call = (
  r: Pick<DockerRuntime, "fetch">,
  path: string,
  method = "POST",
  body?: unknown,
  signal?: AbortSignal,
) =>
  r.fetch(
    new Request(`http://docker.local${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    }),
  )
const seed = (r: DockerRuntime, status = "running") =>
  call(r, "/__admin/docker/seed", "POST", {
    images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
    containers: [{ id, name: "worker", image: "synthetic", status }],
  })
const inspect = async (r: DockerRuntime) => (await call(r, `/containers/${id}/json`, "GET")).json()
const complete = (r: DockerRuntime, exitCode = 17) =>
  call(r, `/__admin/docker/containers/${id}/complete`, "POST", { exitCode })
const accepted = async (
  r: Pick<DockerRuntime, "fetch">,
  operation: string,
  expectedSignal?: number,
) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(r, `/__admin/docker/containers/${id}/termination`, "GET")
    expect(response.status).toBe(200)
    const data = (await response.json()) as {
      request?: { operation: string; signal: number; timeout?: number }
    }
    if (
      data.request?.operation === operation &&
      (expectedSignal === undefined || data.request.signal === expectedSignal)
    )
      return data
  }
  throw new Error("termination was not accepted")
}

test("accepted stop stays running until explicit completion; repeated stopped stop is304", async () => {
  const r = createRuntime()
  await seed(r)
  const stop = call(r, `/containers/${id}/stop?t=-1`)
  let replied = false
  void stop.then(() => {
    replied = true
  })
  expect(await accepted(r, "stop")).toMatchObject({ request: { signal: 15, timeout: -1 } })
  expect(replied).toBe(false)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
  const waiting = await call(r, `/containers/${id}/wait`)
  await complete(r, 17)
  expect((await stop).status).toBe(204)
  expect(await waiting.json()).toEqual({ StatusCode: 17 })
  expect(await inspect(r)).toMatchObject({ State: { Running: false, ExitCode: 17 } })
  expect((await call(r, `/containers/${id}/stop`)).status).toBe(304)
})

test("SIGKILL waits for completion; other signals acknowledge without claiming exit", async () => {
  const r = createRuntime()
  await seed(r)
  expect((await call(r, `/containers/${id}/kill?signal=TERM`)).status).toBe(204)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
  const kill = call(r, `/containers/${id}/kill?signal=9`)
  expect(await accepted(r, "kill", 9)).toMatchObject({ request: { signal: 9 } })
  await complete(r, 137)
  expect((await kill).status).toBe(204)
  expect((await call(r, `/containers/${id}/kill`)).status).toBe(409)
})

test("forced removal waits for exit, conflicts with another removal and wakes removed waits", async () => {
  const r = createRuntime()
  await seed(r)
  expect((await call(r, `/containers/${id}`, "DELETE")).status).toBe(409)
  const removed = await call(r, `/containers/${id}/wait?condition=removed`)
  const remove = call(r, `/containers/${id}?force=1`, "DELETE")
  expect(await accepted(r, "remove")).toMatchObject({ removalPending: true })
  expect((await call(r, `/containers/${id}?force=1`, "DELETE")).status).toBe(409)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
  await complete(r, 137)
  expect((await remove).status).toBe(204)
  expect(await removed.json()).toEqual({ StatusCode: 137 })
  expect((await call(r, `/containers/${id}/json`, "GET")).status).toBe(404)
  expect((await call(r, `/containers/${id}`, "DELETE")).status).toBe(404)
})

test("canceling a pending stop reply retains accepted intent and running state", async () => {
  const r = createRuntime()
  await seed(r)
  const aborted = new AbortController()
  const stop = call(r, `/containers/${id}/stop`, "POST", undefined, aborted.signal).then(
    () => null,
    (error) => error,
  )
  await accepted(r, "stop")
  aborted.abort()
  expect(await stop).toBeInstanceOf(Error)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
  expect(await accepted(r, "stop")).toMatchObject({ request: { operation: "stop" } })
  const waiting = await call(r, `/containers/${id}/wait`)
  await complete(r, 0)
  expect(await waiting.json()).toEqual({ StatusCode: 0 })
})

test("removing stopped/created records releases the name and wakes next-exit too", async () => {
  const r = createRuntime()
  await seed(r, "created")
  const removed = await call(r, `/containers/${id}/wait?condition=removed`)
  const next = await call(r, `/containers/${id}/wait?condition=next-exit`)
  expect((await call(r, `/containers/${id}?v=1`, "DELETE")).status).toBe(204)
  expect(await removed.json()).toEqual({ StatusCode: 0 })
  expect(await next.json()).toEqual({ StatusCode: 0 })
  expect(
    (
      await call(r, "/containers/create?name=worker", "POST", {
        Image: "synthetic",
        Cmd: ["worker"],
      })
    ).status,
  ).toBe(201)
})

test("signals, timeout parsing and seeded removal conflicts follow the pinned envelopes", async () => {
  const r = createRuntime()
  await seed(r)
  for (const signal of ["0", "32", "33", "65", "garbage"])
    expect((await call(r, `/containers/${id}/kill?signal=${signal}`)).status).toBe(400)
  for (const signal of ["sigterm", "SIGRTMIN%2B1", "64"])
    expect((await call(r, `/containers/${id}/kill?signal=${signal}`)).status).toBe(204)
  for (const suffix of ["stop?t=bad", "stop?signal=bad"])
    expect((await call(r, `/containers/${id}/${suffix}`)).status).toBe(500)
  expect((await call(r, `/containers/${id}?link=true`, "DELETE")).status).toBe(501)
  expect((await call(r, "/containers/missing/kill")).status).toBe(404)
  await r.reset()
  await seed(r, "removing")
  expect((await call(r, `/containers/${id}?force=1`, "DELETE")).status).toBe(409)
  await r.reset()
  await seed(r, "paused")
  expect((await call(r, `/containers/${id}`, "DELETE")).status).toBe(409)
})

test("concurrent stops finish together; resetting cancels replies and accepted intent", async () => {
  const r = createRuntime()
  await seed(r)
  const a = call(r, `/containers/${id}/stop`)
  const b = call(r, `/containers/${id}/stop`)
  await accepted(r, "stop")
  await complete(r, 0)
  expect((await a).status).toBe(204)
  expect([204, 304]).toContain((await b).status)
  await call(r, `/containers/${id}/start`)
  const kill = call(r, `/containers/${id}/kill`).then(
    () => null,
    (error) => error,
  )
  await accepted(r, "kill", 9)
  await r.reset()
  expect(await kill).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(0)
  expect((await call(r, `/containers/${id}/json`, "GET")).status).toBe(404)
})

test("socket loss after stop acceptance does not imply exit; later completion resolves a new wait", async () => {
  const server = await createServer()
  const remote = {
    fetch: (request: Request) =>
      fetch(
        new Request(
          new URL(new URL(request.url).pathname + new URL(request.url).search, server.url),
          request,
        ),
      ),
  }
  try {
    await seed(server.runtime)
    const aborted = new AbortController()
    const stop = call(remote, `/containers/${id}/stop?t=0`, "POST", undefined, aborted.signal).then(
      () => null,
      (error) => error,
    )
    await accepted(remote, "stop")
    aborted.abort()
    expect(await stop).toBeInstanceOf(Error)
    expect(await inspect(server.runtime)).toMatchObject({ State: { Running: true } })
    const waiting = await call(remote, `/containers/${id}/wait`)
    await complete(server.runtime, 137)
    expect(await waiting.json()).toEqual({ StatusCode: 137 })
    expect(await inspect(server.runtime)).toMatchObject({
      State: { Running: false, ExitCode: 137 },
    })
  } finally {
    await server.close()
  }
})

test("kill errors include the route's container context", async () => {
  const r = createRuntime()
  const invalid = await call(r, "/containers/missing/kill?signal=bad")
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toEqual({
    message: "cannot kill container: missing: invalid signal: bad",
  })
  const missing = await call(r, "/containers/missing/kill")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({
    message: "cannot kill container: missing: No such container: missing",
  })
})
