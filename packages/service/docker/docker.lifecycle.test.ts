import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, type DockerRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const id = "a".repeat(64)
const call = (
  r: DockerRuntime,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  namespace = "default",
) =>
  r.fetch(
    new Request(`http://docker.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    }),
  )
const seed = (r: DockerRuntime, status = "created", autoRemove = false, namespace = "default") =>
  call(
    r,
    "/__admin/docker/seed",
    {
      images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
      containers: [
        { id, name: "example", image: "synthetic", status, hostConfig: { AutoRemove: autoRemove } },
      ],
    },
    undefined,
    namespace,
  )
const inspect = async (r: DockerRuntime) =>
  (await r.fetch(new Request(`http://docker.local/containers/${id}/json`))).json()
const wait = (r: DockerRuntime, condition = "", signal?: AbortSignal, namespace = "default") =>
  call(r, `/containers/${id}/wait?condition=${condition}`, undefined, signal, namespace)
const complete = (r: DockerRuntime, exitCode = 7, namespace = "default") =>
  call(r, `/__admin/docker/containers/${id}/complete`, { exitCode }, undefined, namespace)
const pending = async (r: DockerRuntime, namespace = "default") =>
  (
    await r.fetch(
      new Request("http://docker.local/__admin/docker/waits", {
        headers: { "x-mockingbird-namespace": namespace },
      }),
    )
  ).json()

test("start persists one transition and rejects incompatible states", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const r = createRuntime({ clock })
  await seed(r)
  expect((await call(r, `/containers/${id}/start`)).status).toBe(204)
  expect(await inspect(r)).toMatchObject({
    State: { Status: "running", Running: true, ExitCode: 0, StartedAt: "2023-11-14T22:13:20.000Z" },
  })
  expect((await call(r, `/containers/${id}/start`)).status).toBe(304)
  for (const status of ["paused", "dead", "removing"]) {
    await r.reset()
    await seed(r, status)
    expect((await call(r, `/containers/${id}/start`)).status).toBe(409)
  }
})

test("wait headers arrive immediately; next-exit waits across start and completion", async () => {
  const r = createRuntime()
  await seed(r)
  expect(await (await wait(r)).json()).toEqual({ StatusCode: 0 })
  const next = await wait(r, "next-exit")
  expect(next.status).toBe(200)
  expect(await pending(r)).toEqual({ pending: 1 })
  const result = next.json()
  expect((await call(r, `/containers/${id}/start`)).status).toBe(204)
  const running = await wait(r)
  expect(await pending(r)).toEqual({ pending: 2 })
  expect((await complete(r, 23)).status).toBe(200)
  expect(await result).toEqual({ StatusCode: 23 })
  expect(await running.json()).toEqual({ StatusCode: 23 })
  expect(await (await wait(r)).json()).toEqual({ StatusCode: 23 })
  expect(await inspect(r)).toMatchObject({
    State: { Status: "exited", Running: false, ExitCode: 23 },
  })
  expect(await pending(r)).toEqual({ pending: 0 })
})

test("wait cancellation and reset release handles without completing containers", async () => {
  const r = createRuntime()
  await seed(r, "running")
  await seed(r, "running", false, "other")
  const controller = new AbortController()
  const canceled = (await wait(r, "next-exit", controller.signal)).json()
  const failed = canceled.then(
    () => null,
    (error) => error,
  )
  controller.abort()
  expect(await failed).toBeInstanceOf(Error)
  expect(await pending(r)).toEqual({ pending: 0 })
  const body = await wait(r)
  await body.body?.cancel()
  expect(await pending(r)).toEqual({ pending: 0 })
  const resetWait = (await wait(r)).json()
  const resetFailed = resetWait.then(
    () => null,
    (error) => error,
  )
  const otherWait = await wait(r, "", undefined, "other")
  await r.reset()
  expect(await resetFailed).toBeInstanceOf(Error)
  expect(await pending(r)).toEqual({ pending: 0 })
  expect(await pending(r, "other")).toEqual({ pending: 1 })
  await complete(r, 9, "other")
  expect(await otherWait.json()).toEqual({ StatusCode: 9 })
})

test("removed waits only complete after automatic removal; invalid conditions fail before headers", async () => {
  const r = createRuntime()
  await seed(r, "running", true)
  expect((await wait(r, "invalid")).status).toBe(400)
  expect((await call(r, "/containers/missing/wait")).status).toBe(404)
  const removed = await wait(r, "removed")
  await complete(r, 13)
  expect(await removed.json()).toEqual({ StatusCode: 13 })
  expect((await r.fetch(new Request(`http://docker.local/containers/${id}/json`))).status).toBe(404)
})

test("restart resets exit code and keeps the previous finished time until the next completion", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const r = createRuntime({ clock })
  await seed(r, "running")
  await complete(r, 11)
  clock.advance(1000)
  expect((await call(r, `/containers/${id}/start`)).status).toBe(204)
  expect(await inspect(r)).toMatchObject({
    State: {
      ExitCode: 0,
      StartedAt: "2023-11-14T22:13:21.000Z",
      FinishedAt: "2023-11-14T22:13:20.000Z",
    },
  })
  const a = await wait(r, "next-exit")
  const b = await wait(r, "next-exit")
  clock.advance(1000)
  await complete(r, 2)
  expect(await a.json()).toEqual({ StatusCode: 2 })
  expect(await b.json()).toEqual({ StatusCode: 2 })
  expect(await inspect(r)).toMatchObject({ State: { FinishedAt: "2023-11-14T22:13:22.000Z" } })
  expect((await complete(r, 3)).status).toBe(409)
})

test("removed stays pending after ordinary exit; shutdown releases it", async () => {
  const r = createRuntime()
  await seed(r, "running")
  const removed = await wait(r, "removed")
  await complete(r)
  expect(await pending(r)).toEqual({ pending: 1 })
  const failure = removed.json().then(
    () => null,
    (error) => error,
  )
  r.close()
  expect(await failure).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(0)
  await expect(wait(r)).rejects.toThrow("closed")
})

test("start validates body and unsupported options; completion rejects malformed data", async () => {
  const r = createRuntime()
  await seed(r)
  expect((await call(r, `/containers/${id}/start`, { unsupported: true })).status).toBe(400)
  expect((await call(r, `/containers/${id}/start?checkpoint=x`)).status).toBe(501)
  expect((await call(r, "/containers/missing/start")).status).toBe(404)
  for (const body of [{}, { exitCode: 1.2 }, { exitCode: "1" }, { exitCode: 0, invalid: true }])
    expect((await call(r, `/__admin/docker/containers/${id}/complete`, body)).status).toBe(400)
  expect(await inspect(r)).toMatchObject({ State: { Status: "created" } })
  expect((await call(r, `/containers/${id}/start`, {})).status).toBe(204)
})

test("Node transport flushes wait headers and cleans waits on disconnect and server close", async () => {
  const server = await createServer()
  try {
    await seed(server.runtime, "running")
    const aborted = new AbortController()
    const disconnected = new Promise<void>((resolve) => {
      server.server.once("request", (_req, res) => res.once("close", resolve))
    })
    const response = await fetch(`${server.url}/v1.52/containers/${id}/wait`, {
      method: "POST",
      signal: aborted.signal,
    })
    expect(response.status).toBe(200)
    expect(server.runtime.instance().lifecycle.pending).toBe(1)
    const failed = response.text().then(
      () => null,
      (error) => error,
    )
    aborted.abort()
    expect(await failed).toBeInstanceOf(Error)
    await disconnected
    expect(server.runtime.instance().lifecycle.pending).toBe(0)
    const closing = await fetch(`${server.url}/containers/${id}/wait`, { method: "POST" })
    const closeFailure = closing.text().then(
      () => null,
      (error) => error,
    )
    await server.close()
    expect(await closeFailure).toBeInstanceOf(Error)
    expect(server.runtime.instance().lifecycle.pending).toBe(0)
  } finally {
    await server.close()
  }
})

test("scripted completion creates a shared checkpoint with inspectable exit state", async () => {
  const r = createRuntime()
  await seed(r)
  const started = await call(r, `/containers/${id}/start`)
  const at = started.headers.get("x-mockingbird-checkpoint")
  expect(at).toBeString()
  await complete(r, 42)
  const head = r.timeline().head("main")
  expect(head?.id).not.toBe(at)
  const stopped = r.snapshot()
  r.checkout(at as string)
  expect(await inspect(r)).toMatchObject({ State: { Running: true, ExitCode: 0 } })
  r.restore(stopped)
  expect(await inspect(r)).toMatchObject({ State: { Running: false, ExitCode: 42 } })
})

test("already-aborted and concurrently closed waits cannot register leaked handles", async () => {
  const r = createRuntime()
  await seed(r, "running")
  const aborted = new AbortController()
  aborted.abort()
  const failure = await wait(r, "", aborted.signal).then(
    () => null,
    (error) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(0)
  const inFlight = wait(r).then(
    (response) => response.text(),
    (error) => error,
  )
  r.close()
  expect(await inFlight).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(0)
})

test("restarting starts are idempotent and wildcard reset cancels every namespace", async () => {
  const r = createRuntime()
  await seed(r, "restarting")
  await seed(r, "running", false, "other")
  expect((await call(r, `/containers/${id}/start`)).status).toBe(304)
  expect(await inspect(r)).toMatchObject({ State: { Status: "restarting", Running: true } })
  const a = (await wait(r)).text().then(
    () => null,
    (error) => error,
  )
  const b = (await wait(r, "removed", undefined, "other")).text().then(
    () => null,
    (error) => error,
  )
  expect((await call(r, "/__admin/reset?all=1", {})).status).toBe(200)
  expect(await a).toBeInstanceOf(Error)
  expect(await b).toBeInstanceOf(Error)
  expect(await pending(r)).toEqual({ pending: 0 })
  expect(await pending(r, "other")).toEqual({ pending: 0 })
})

test("chunked start rejects before consuming an open body", async () => {
  const r = createRuntime()
  await seed(r)
  for (const headers of [{ "transfer-encoding": "chunked" }, { "content-length": "100" }, {}]) {
    const controller = new AbortController()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        bodyController = value
        if (Object.keys(headers).length === 0) value.enqueue(new Uint8Array(8))
      },
    })
    const request = new Request(`http://docker.local/containers/${id}/start`, {
      method: "POST",
      headers: headers as HeadersInit,
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit)
    const started = r.fetch(request)
    // A deadline detects premature buffering; it does not drive lifecycle behavior.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("start buffered an open invalid body")), 1000)
        }),
      ])
      expect(response.status).toBe(400)
      expect(await inspect(r)).toMatchObject({ State: { Status: "created" } })
    } finally {
      clearTimeout(timer)
      controller.abort()
      try {
        bodyController?.close()
      } catch {
        /* already canceled */
      }
      await started.catch(() => {})
    }
  }
  r.close()
})
