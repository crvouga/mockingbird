import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { createServer, type DockerServer } from "./src/server.js"

const id = "a".repeat(64)
const seed = (server: DockerServer) =>
  server.runtime.instance().state.seed({
    images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
    containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
  })
const request = (path = `/v1.52/containers/${id}/attach?stream=1&stdout=1&stderr=1`) =>
  `POST ${path} HTTP/1.1\r\nHost: docker.mock\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`
// Independent consumer splits at CRLFCRLF and retains everything after it.
const exchange = (server: DockerServer, input: string, firstBytes = 0) =>
  new Promise<{ header: string; tail: Buffer }>((resolve, reject) => {
    const socket = createConnection({ port: server.port, host: server.host })
    let bytes = Buffer.alloc(0)
    let finished = false
    const finish = () => {
      if (finished) return
      const boundary = bytes.indexOf("\r\n\r\n")
      if (boundary < 0 || bytes.length < boundary + 4 + firstBytes) return
      finished = true
      resolve({
        header: bytes.subarray(0, boundary).toString(),
        tail: bytes.subarray(boundary + 4),
      })
      socket.destroy()
    }
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      finish()
    })
    socket.once("error", reject)
    socket.once("close", () => {
      if (!finished) reject(new Error("closed before complete handshake"))
    })
    socket.setTimeout(1500, () => socket.destroy(new Error("handshake fixture timeout")))
    socket.write(input)
  })

test("versioned attach upgrades with pinned headers and preserves first stream bytes", async () => {
  const bytes = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 3, 65, 66, 67])
  const server = await createServer({
    attachHandshake: { chunkBytes: 7, initialStreamBytes: bytes },
  })
  seed(server)
  try {
    const response = await exchange(server, request(), bytes.length)
    expect(response.header).toBe(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp",
    )
    expect(response.tail).toEqual(Buffer.from(bytes))
  } finally {
    await server.close()
  }
})

test("missing attach container returns pre-upgrade plaintext error", async () => {
  const server = await createServer()
  try {
    const response = await exchange(
      server,
      request("/v1.52/containers/missing/attach?stream=1&stdout=1"),
    )
    expect(response.header).toContain("404 Not Found")
    expect(response.header).toContain("Content-Type: application/vnd.docker.raw-stream")
  } finally {
    await server.close()
  }
})

test("unsupported attach modes reject before upgrade and Fetch stays explicit", async () => {
  const server = await createServer()
  seed(server)
  try {
    for (const query of ["stream=0", "stream=1&logs=1", "stream=1&detachKeys=ctrl-x"]) {
      expect(
        (await exchange(server, request(`/v1.52/containers/${id}/attach?${query}`))).header,
      ).toContain("501 Not Implemented")
    }
    expect(
      (
        await server.runtime.fetch(
          new Request(`http://docker.mock/v1.52/containers/${id}/attach?stream=1`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(501)
  } finally {
    await server.close()
  }
})

test("attach uses shared namespace, branch, faults and read-only history", async () => {
  const server = await createServer()
  seed(server)
  const before = server.runtime.checkpoint()
  server.runtime.branch("alternate", { at: before.id })
  try {
    const response = await exchange(
      server,
      request().replace(
        "Host: docker.mock",
        "Host: docker.mock\r\nx-mockingbird-branch: alternate",
      ),
    )
    expect(response.header).toContain("101 UPGRADED")
    expect(server.runtime.timeline().head("main")?.id).toBe(before.id)
    expect(server.runtime.timeline().head("alternate")?.id).toBe(before.id)
    expect(server.runtime.journal.list({ operationId: "ContainerAttach" })).toMatchObject([
      { status: 101, ids: { containerId: id } },
    ])
    expect(
      (await exchange(server, request(`/ns/other/v1.52/containers/${id}/attach?stream=1&stdout=1`)))
        .header,
    ).toContain("404")
    server.runtime.faults.add({
      id: "attach-fail",
      operationId: "ContainerAttach",
      status: 503,
      count: 1,
    })
    expect((await exchange(server, request())).header).toContain("503")
    expect(server.runtime.timeline().head("main")?.id).toBe(before.id)
  } finally {
    await server.close()
  }
})

test("paused, restarting and TTY modes reject before upgrade", async () => {
  const server = await createServer()
  seed(server)
  try {
    const api = server.runtime.instance()
    for (const status of ["paused", "restarting"] as const) {
      api.state.containers.update(id, { ...api.state.find(id), status })
      const response = await exchange(server, request())
      expect(response.header).toContain("409 Conflict")
      expect(response.header).toContain("application/vnd.docker.raw-stream")
    }
    api.state.containers.update(id, {
      ...api.state.find(id),
      status: "running",
      config: { Tty: true },
    })
    expect((await exchange(server, request())).header).toContain("501 Not Implemented")
  } finally {
    await server.close()
  }
})

test("aborting a fragmented handshake closes the owned socket without ending execution", async () => {
  const server = await createServer({ attachHandshake: { chunkBytes: 1 } })
  seed(server)
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port: server.port, host: server.host })
      socket.once("data", (chunk) => {
        expect(chunk.indexOf("\r\n\r\n")).toBe(-1)
        socket.destroy()
      })
      socket.once("error", reject)
      socket.once("close", () => resolve())
      socket.setTimeout(1500, () => socket.destroy(new Error("fixture timeout")))
      socket.write(request())
    })
    for (let i = 0; i < 20; i++) {
      const count = await new Promise<number>((resolve, reject) =>
        server.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      )
      if (count === 0) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(
      await new Promise<number>((resolve, reject) =>
        server.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      ),
    ).toBe(0)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    await server.close()
  }
})

test("daemon unavailability drops attach and upgrade cannot dispatch admin mutations", async () => {
  const server = await createServer()
  seed(server)
  try {
    expect((await exchange(server, request("/__admin/reset"))).header).toContain("404")
    expect(server.runtime.instance().state.containers.count()).toBe(1)
    server.runtime.instance().state.updateDaemon({ available: false })
    await expect(exchange(server, request())).rejects.toThrow("closed")
  } finally {
    await server.close()
  }
})

test("built Node attach handshake preserves first bytes under Node itself", async () => {
  const child = Bun.spawn(["node", "test/node-attach.mjs"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, err }).toEqual({ code: 0, err: "" })
  expect(out).toContain("first bytes passed")
})
