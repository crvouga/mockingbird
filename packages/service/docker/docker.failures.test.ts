import { expect, test } from "bun:test"
import { createRuntime, type DockerRuntime } from "./src/index.js"

const id = "e".repeat(64)
const call = (
  r: DockerRuntime,
  path: string,
  body?: unknown,
  method = "POST",
  namespace = "default",
) =>
  r.fetch(
    new Request(`http://docker.local${path}`, {
      method,
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const seed = (r: DockerRuntime, namespace = "default") =>
  call(
    r,
    "/__admin/docker/seed",
    {
      images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
      containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
    },
    "POST",
    namespace,
  )
const inspect = async (r: DockerRuntime, namespace = "default") =>
  (await call(r, `/containers/${id}/json`, undefined, "GET", namespace)).json()

test("pre-mutation and accepted-drop creation presets distinguish state, journal and Timeline", async () => {
  const r = createRuntime()
  await seed(r)
  const before = r.checkpoint()
  expect((await call(r, "/__admin/faults", { preset: "docker_create_pre_failure" })).status).toBe(
    201,
  )
  expect(
    (await call(r, "/containers/create?name=created", { Image: "synthetic", Cmd: ["worker"] }))
      .status,
  ).toBe(503)
  expect(r.timeline().head("main")?.id).toBe(before.id)
  expect(r.instance().state.containers.count()).toBe(1)
  expect((await call(r, "/__admin/faults", { preset: "docker_create_accepted_drop" })).status).toBe(
    201,
  )
  const error = await call(r, "/containers/create?name=created", {
    Image: "synthetic",
    Cmd: ["worker"],
  }).then(
    () => null,
    (error) => error,
  )
  expect(error).toBeInstanceOf(TypeError)
  expect(r.instance().state.containers.count()).toBe(2)
  const head = r.timeline().head("main")
  if (!head) throw new Error("Missing checkpoint")
  expect(head.id).not.toBe(before.id)
  expect(r.journal.list({ operationId: "ContainerCreate" })).toMatchObject([
    { status: 503 },
    { status: 0, accepted: true, checkpoint: head.id, ids: { containerId: expect.any(String) } },
  ])
  r.checkout(before.id)
  expect(r.instance().state.containers.count()).toBe(1)
  r.checkout(head.id)
  expect(r.instance().state.find("created").status).toBe("created")
})

test("logical restart explicitly preserves or terminates execution and records history", async () => {
  const r = createRuntime()
  await seed(r)
  await call(r, "/__admin/docker/daemon", { available: false })
  await expect(call(r, "/info", undefined, "GET")).rejects.toThrow()
  expect((await call(r, "/__admin/docker/restart", { containers: "preserve" })).status).toBe(200)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
  const preserved = r.timeline().head("main")
  if (!preserved) throw new Error("Missing checkpoint")
  expect(
    (await call(r, "/__admin/docker/restart", { containers: "terminate", exitCode: 137 })).status,
  ).toBe(200)
  expect(await inspect(r)).toMatchObject({ State: { Running: false, ExitCode: 137 } })
  r.checkout(preserved.id)
  expect(await inspect(r)).toMatchObject({ State: { Running: true } })
})

test("checkout cancels old wait handles before restoring a namespace", async () => {
  const r = createRuntime()
  await seed(r)
  const before = r.checkpoint()
  const waiting = await call(r, `/containers/${id}/wait`)
  const failed = waiting.json().then(
    () => null,
    (error) => error,
  )
  r.checkout(before.id)
  expect(r.instance().lifecycle.pending).toBe(0)
  expect(await failed).toBeInstanceOf(Error)
  await call(r, `/__admin/docker/containers/${id}/complete`, { exitCode: 2 })
  expect(await inspect(r)).toMatchObject({ State: { ExitCode: 2 } })
})

for (const operation of ["start", "stop", "kill", "remove"] as const) {
  test(`${operation}: pre-failure leaves state unchanged, accepted drop survives checkout`, async () => {
    const r = createRuntime()
    await seed(r)
    if (operation === "start")
      await call(r, `/__admin/docker/containers/${id}/complete`, { exitCode: 0 })
    const path =
      operation === "remove"
        ? `/v1.52/containers/${id}?force=true`
        : `/v1.52/containers/${id}/${operation}`
    const method = operation === "remove" ? "DELETE" : "POST"
    const body = operation === "start" ? {} : undefined
    const initial = r.instance().state.find(id)
    const before = r.checkpoint()
    await call(r, "/__admin/faults", { preset: `docker_${operation}_pre_failure` })
    expect((await call(r, path, body, method)).status).toBe(503)
    expect(r.instance().state.find(id)).toEqual(initial)
    expect(r.timeline().head("main")?.id).toBe(before.id)
    await call(r, "/__admin/faults", { preset: `docker_${operation}_accepted_drop` })
    const error = await call(r, path, body, method).then(
      () => null,
      (error) => error,
    )
    expect(error).toBeInstanceOf(TypeError)
    const accepted = r.instance().state.find(id)
    if (operation === "start") expect(accepted.status).toBe("running")
    else {
      expect(accepted.status).toBe("running")
      expect(accepted.termination?.operation).toBe(operation)
    }
    if (operation === "remove") expect(accepted.removalPending).toBe(true)
    expect(r.instance().lifecycle.pending).toBe(0)
    const head = r.timeline().head("main")
    if (!head) throw new Error("Missing checkpoint")
    r.checkout(before.id)
    expect(r.instance().state.find(id)).toEqual(initial)
    r.checkout(head.id)
    expect(r.instance().state.find(id)).toEqual(accepted)
    if (operation !== "start") {
      expect(
        (await call(r, `/__admin/docker/containers/${id}/complete`, { exitCode: 137 })).status,
      ).toBe(200)
      expect(r.instance().state.containers.has(id)).toBe(operation !== "remove")
    }
    r.close()
  })
}

test("aborted accepted stop is captured before checkout and cannot alter restored execution", async () => {
  const r = createRuntime()
  await seed(r)
  const before = r.checkpoint()
  const controller = new AbortController()
  const stop = r
    .fetch(
      new Request(`http://docker.local/containers/${id}/stop`, {
        method: "POST",
        signal: controller.signal,
      }),
    )
    .then(
      () => null,
      (error) => error,
    )
  // The termination handle is installed after the shared fault matcher yields.
  for (let i = 0; i < 20 && r.instance().lifecycle.pending === 0; i++) await Promise.resolve()
  expect(r.instance().lifecycle.pending).toBe(1)
  const accepted = r.timeline().head("main")
  if (!accepted) throw new Error("Missing checkpoint")
  expect(accepted.id).not.toBe(before.id)
  r.checkout(before.id)
  expect(await stop).toBeInstanceOf(TypeError)
  expect(r.instance().state.find(id).termination).toBeUndefined()
  expect(r.timeline().head("main")?.id).toBe(before.id)
  r.checkout(accepted.id)
  expect(r.instance().state.find(id).termination?.operation).toBe("stop")
  expect(r.journal.list({ operationId: "ContainerStop" })).toMatchObject([
    { status: 0, accepted: true, checkpoint: accepted.id },
  ])
  r.close()
})

test("restart validation is atomic and availability is independent of execution", async () => {
  const r = createRuntime()
  await seed(r)
  await seed(r, "other")
  await call(r, "/__admin/docker/daemon", { available: false })
  const unavailable = r.timeline().head("main")
  if (!unavailable) throw new Error("Missing checkpoint")
  expect(r.instance().state.find(id).status).toBe("running")
  expect(
    (await call(r, "/__admin/docker/restart", { containers: "terminate", exitCode: "invalid" }))
      .status,
  ).toBe(400)
  expect(r.instance().state.daemon().available).toBe(false)
  expect(r.timeline().head("main")?.id).toBe(unavailable.id)
  await call(r, "/__admin/docker/restart", { containers: "terminate", exitCode: 19 })
  expect(r.instance().state.find(id).exitCode).toBe(19)
  expect(r.instance("other").state.find(id).status).toBe("running")
  r.checkout(unavailable.id)
  expect(r.instance().state.daemon().available).toBe(false)
  expect(r.instance().state.find(id).status).toBe("running")
  r.close()
})

test("accepted faults and restore cleanup stay within the selected branch and namespace", async () => {
  const r = createRuntime()
  await seed(r)
  await seed(r, "other")
  const before = r.checkpoint()
  await call(r, "/__admin/faults", { preset: "docker_stop_accepted_drop" })
  const error = await r
    .fetch(
      new Request(`http://docker.local/containers/${id}/stop`, {
        method: "POST",
        headers: { "x-mockingbird-branch": "experiment", "x-mockingbird-at": before.id },
      }),
    )
    .then(
      () => null,
      (error) => error,
    )
  expect(error).toBeInstanceOf(TypeError)
  expect(r.instance().state.find(id).termination).toBeUndefined()
  expect(r.instance("other").state.find(id).termination).toBeUndefined()
  const head = r.timeline().head("experiment")
  if (!head) throw new Error("Missing branch checkpoint")
  const branchRequest = (path: string, method: string) =>
    r.fetch(
      new Request(`http://docker.local${path}`, {
        method,
        headers: { "x-mockingbird-branch": "experiment" },
      }),
    )
  const mainWait = (await call(r, `/containers/${id}/wait`)).json().then(
    () => null,
    (error) => error,
  )
  const branchWait = (await branchRequest(`/containers/${id}/wait`, "POST")).json().then(
    () => null,
    (error) => error,
  )
  r.checkout(before.id, { namespace: "default", branch: "experiment" })
  expect(await branchWait).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(1)
  r.checkout(head.id, { namespace: "default", branch: "experiment" })
  const restored = await (await branchRequest(`/containers/${id}/json`, "GET")).json()
  expect(restored.State.Running).toBe(true)
  const snapshot = r.snapshot()
  r.restore(snapshot)
  expect(await mainWait).toBeInstanceOf(Error)
  expect(r.instance().lifecycle.pending).toBe(0)
  r.close()
})
