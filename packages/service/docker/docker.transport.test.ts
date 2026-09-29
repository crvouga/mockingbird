import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { Agent, request } from "node:http"
import { createConnection, type Socket } from "node:net"
import { resolve } from "node:path"
import { createServer } from "./src/server.js"

const socketPath = async () => {
  const dir = resolve(import.meta.dir, "../../../.mockingbird/docker-sockets")
  await mkdir(dir, { recursive: true })
  return `${dir}/${crypto.randomUUID().slice(0, 8)}.sock`
}
const ping = (path: string, agent: Agent) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: path, path: "/_ping", agent }, (res) => {
      let body = ""
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })

test("Unix socket retains sequential connections and closes owned socket", async () => {
  const path = await socketPath()
  const server = await createServer({ socketPath: path })
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  let connections = 0
  server.server.on("connection", () => connections++)
  try {
    expect(await ping(path, agent)).toEqual({ status: 200, body: "OK" })
    expect(await ping(path, agent)).toEqual({ status: 200, body: "OK" })
    expect(connections).toBe(1)
  } finally {
    agent.destroy()
    await server.close()
  }
  expect(
    await lstat(path).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("refuse an existing unowned path without changing its contents", async () => {
  const path = await socketPath()
  await writeFile(path, "owned elsewhere")
  try {
    const result = await createServer({ socketPath: path }).then(
      (server) => server,
      (error) => error,
    )
    if (result?.close) await result.close()
    expect(result).toBeInstanceOf(Error)
    expect(await readFile(path, "utf8")).toBe("owned elsewhere")
  } finally {
    await unlink(path)
  }
  expect(
    await lstat(path).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("oversized HTTP input rejects before provider mutation", async () => {
  const server = await createServer({ maxBodyBytes: 32 })
  try {
    const result = await fetch(`${server.url}/containers/create`, {
      method: "POST",
      body: "x".repeat(33),
    })
    expect(result.status).toBe(413)
    expect(server.runtime.journal.list()).toHaveLength(0)
  } finally {
    await server.close()
  }
})

const raw = (socket: Socket, input: string) =>
  new Promise<string>((resolve, reject) => {
    let out = ""
    socket.on("data", (chunk) => {
      out += chunk.toString()
    })
    socket.once("close", () => resolve(out))
    socket.once("error", reject)
    socket.setTimeout(1500, () => {
      socket.destroy(new Error("fixture timeout"))
    })
    socket.write(input)
  })

test("chunked requests have the same size bound and incomplete bodies expire", async () => {
  const path = await socketPath()
  const server = await createServer({ socketPath: path, maxBodyBytes: 32, bodyTimeoutMs: 30 })
  try {
    const oversized = await raw(
      createConnection(path),
      "POST /containers/create HTTP/1.1\r\nHost: docker.mock\r\nTransfer-Encoding: chunked\r\n\r\n21\r\n" +
        "x".repeat(33) +
        "\r\n0\r\n\r\n",
    )
    expect(oversized).toContain("413")
    const stalled = await raw(
      createConnection(path),
      "POST /containers/create HTTP/1.1\r\nHost: docker.mock\r\nContent-Length: 30\r\n\r\nx",
    )
    expect(stalled).toContain("408")
    expect(server.runtime.journal.list()).toHaveLength(0)
  } finally {
    await server.close()
  }
})

test("deliberate drop closes one connection without implicit reconnection", async () => {
  const path = await socketPath()
  const server = await createServer({ socketPath: path })
  let connections = 0
  server.server.on("connection", () => connections++)
  server.runtime.faults.add({ id: "disconnect", operationId: "SystemPing", drop: true, count: 1 })
  try {
    expect(
      await raw(createConnection(path), "GET /_ping HTTP/1.1\r\nHost: docker.mock\r\n\r\n"),
    ).toBe("")
    expect(connections).toBe(1)
    expect(server.runtime.journal.list()).toMatchObject([{ status: 0 }])
    const agent = new Agent({ keepAlive: true })
    try {
      expect((await ping(path, agent)).status).toBe(200)
    } finally {
      agent.destroy()
    }
    expect(connections).toBe(2)
  } finally {
    await server.close()
  }
})

test("server shutdown destroys incomplete owned connections and is idempotent", async () => {
  const path = await socketPath()
  const server = await createServer({ socketPath: path })
  const socket = createConnection(path)
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write(
    "POST /containers/create HTTP/1.1\r\nHost: docker.mock\r\nContent-Length: 20\r\n\r\nx",
  )
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  await Promise.all([server.close(), server.close(), closed])
  expect(socket.destroyed).toBe(true)
  expect(
    await lstat(path).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("refuse a live unowned socket and conflicting transport options", async () => {
  const path = await socketPath()
  const owner = await createServer({ socketPath: path })
  try {
    await expect(createServer({ socketPath: path })).rejects.toThrow("existing")
    await expect(createServer({ socketPath: path, port: 0 })).rejects.toThrow("combined")
    const agent = new Agent()
    try {
      expect((await ping(path, agent)).body).toBe("OK")
    } finally {
      agent.destroy()
    }
  } finally {
    await owner.close()
  }
})

test("built Node entry uses Unix sockets under Node itself", async () => {
  const child = Bun.spawn(["node", "test/node-transport.mjs"], {
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
  expect(out).toContain("owned cleanup")
})

test("TCP retains sequential HTTP requests on one connection", async () => {
  const server = await createServer()
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  let connections = 0
  server.server.on("connection", () => connections++)
  const call = () =>
    new Promise<number>((resolve, reject) => {
      const req = request(`${server.url}/_ping`, { agent }, (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      })
      req.on("error", reject)
      req.end()
    })
  try {
    expect(await call()).toBe(200)
    expect(await call()).toBe(200)
    expect(connections).toBe(1)
  } finally {
    agent.destroy()
    await server.close()
  }
})

test("pipelining cannot accumulate pending handlers on one connection", async () => {
  const path = await socketPath()
  const server = await createServer({ socketPath: path })
  const id = "a".repeat(64)
  server.runtime.instance().state.seed({
    images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
    containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
  })
  const socket = createConnection(path)
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  let timedOut = false
  socket.setTimeout(1500, () => {
    timedOut = true
    socket.destroy()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve())
      socket.once("error", reject)
      socket.write(
        `POST /containers/${id}/wait HTTP/1.1\r\nHost: docker.mock\r\nContent-Length: 0\r\n\r\n`,
      )
    })
    expect(server.runtime.instance().lifecycle.pending).toBe(1)
    socket.write("GET /_ping HTTP/1.1\r\nHost: docker.mock\r\n\r\n".repeat(8))
    await closed
    expect(timedOut).toBe(false)
    expect(server.runtime.journal.list({ operationId: "SystemPing" })).toHaveLength(0)
    expect(server.runtime.instance().lifecycle.pending).toBe(0)
  } finally {
    socket.destroy()
    await server.close()
  }
})
