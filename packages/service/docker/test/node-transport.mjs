import assert from "node:assert/strict"
import { lstat, mkdir } from "node:fs/promises"
import { Agent, request } from "node:http"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { createServer } from "../dist/server.js"

const dir = resolve(import.meta.dirname, "../../../../.mockingbird/docker-sockets")
await mkdir(dir, { recursive: true })
const socketPath = `${dir}/${crypto.randomUUID().slice(0, 8)}.sock`
const server = await createServer({ socketPath, maxBodyBytes: 32, bodyTimeoutMs: 50 })
const agent = new Agent({ keepAlive: true, maxSockets: 1 })
let connections = 0
server.server.on("connection", () => connections++)
const ping = () =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/_ping", agent }, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => resolve({ status: res.statusCode, body: data }))
    })
    req.on("error", reject)
    req.end()
  })
try {
  assert.deepEqual(await ping(), { status: 200, body: "OK" })
  assert.deepEqual(await ping(), { status: 200, body: "OK" })
  assert.equal(connections, 1)
  await assert.rejects(createServer({ socketPath }), /existing/)
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let data = ""
    socket.on("data", (chunk) => (data += chunk))
    socket.on("close", () => resolve(data))
    socket.on("error", reject)
    socket.setTimeout(2000, () => socket.destroy(new Error("fixture timeout")))
    socket.write(
      "POST /containers/create HTTP/1.1\r\nHost: docker.mock\r\nContent-Length: 20\r\n\r\nx",
    )
  })
  assert.match(response, /408/)
  assert.equal(server.runtime.journal.list({ operationId: "ContainerCreate" }).length, 0)
  const id = "a".repeat(64)
  server.runtime.instance().state.seed({
    images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
    containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
  })
  const before = server.runtime.journal.list({ operationId: "SystemPing" }).length
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once("data", () =>
      socket.write("GET /_ping HTTP/1.1\r\nHost: docker.mock\r\n\r\n".repeat(8)),
    )
    socket.once("close", resolve)
    socket.once("error", reject)
    socket.setTimeout(2000, () => {
      reject(new Error("pipelining timeout"))
      socket.destroy()
    })
    socket.write(
      `POST /containers/${id}/wait HTTP/1.1\r\nHost: docker.mock\r\nContent-Length: 0\r\n\r\n`,
    )
  })
  assert.equal(server.runtime.journal.list({ operationId: "SystemPing" }).length, before)
  assert.equal(server.runtime.instance().lifecycle.pending, 0)
} finally {
  agent.destroy()
  await server.close()
}
assert.equal(
  await lstat(socketPath).then(
    () => true,
    () => false,
  ),
  false,
)
console.log("Node Unix transport: retained connection, owned cleanup, refusal, body timeout passed")
