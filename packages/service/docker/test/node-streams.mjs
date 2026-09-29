import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { createServer } from "../dist/server.js"

const server = await createServer({ attachStreams: { frameChunkBytes: 2 } })
const id = "a".repeat(64)
const api = server.runtime.instance()
api.state.seed({
  images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
  containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
})
api.state.containers.update(id, {
  ...api.state.find(id),
  config: { OpenStdin: true, StdinOnce: true },
})
const socket = createConnection({ host: server.host, port: server.port, allowHalfOpen: true })
let bytes = Buffer.alloc(0),
  closed = false,
  error
socket.on("data", (chunk) => {
  bytes = Buffer.concat([bytes, chunk])
})
socket.on("error", (e) => {
  error = e
})
socket.once("end", () => socket.end())
socket.once("close", () => {
  closed = true
})
const until = async (predicate) => {
  const deadline = performance.now() + 2000
  while (!predicate()) {
    if (error) throw error
    if (performance.now() > deadline) throw new Error("Node stream fixture timeout")
    await new Promise((resolve) => setImmediate(resolve))
  }
}
try {
  socket.write(
    Buffer.concat([
      Buffer.from(
        `POST /v1.52/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker.mock\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`,
      ),
      Buffer.from([0, 255, 65]),
    ]),
  )
  await until(() => bytes.indexOf("\r\n\r\n") >= 0 && server.attachments().length === 1)
  bytes = bytes.subarray(bytes.indexOf("\r\n\r\n") + 4)
  const [session] = server.attachments()
  await until(() => {
    const data = session.takeStdin()
    if (data.length) {
      assert.deepEqual(Buffer.from(data), Buffer.from([0, 255, 65]))
      return true
    }
    return false
  })
  socket.end()
  await until(() => session.stdinClosed)
  assert.equal(api.state.find(id).status, "running")
  assert.equal(closed, false)
  await session.write("stderr", new Uint8Array([0, 255, 2]))
  await until(() => bytes.length >= 11)
  assert.deepEqual(bytes, Buffer.from([2, 0, 0, 0, 0, 0, 0, 3, 0, 255, 2]))
  await session.end()
  assert.equal(closed, false)
  api.lifecycle.complete(id, { exitCode: 7 })
  await until(() => closed)
  assert.equal(api.state.find(id).exitCode, 7)
  console.log("Node stream framing, raw input, half-close and completion passed")
} finally {
  socket.destroy()
  await server.close()
}
