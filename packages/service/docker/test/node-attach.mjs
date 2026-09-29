import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { createServer } from "../dist/server.js"

const first = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 2, 79, 75])
const server = await createServer({ attachHandshake: { chunkBytes: 3, initialStreamBytes: first } })
const id = "a".repeat(64)
server.runtime.instance().state.seed({
  images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
  containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
})
try {
  const result = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: server.host, port: server.port })
    let data = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk])
      const boundary = data.indexOf("\r\n\r\n")
      if (boundary >= 0 && data.length >= boundary + 4 + first.length) {
        resolve({
          header: data.subarray(0, boundary).toString(),
          tail: data.subarray(boundary + 4),
        })
        socket.destroy()
      }
    })
    socket.on("error", reject)
    socket.setTimeout(2000, () => socket.destroy(new Error("fixture timeout")))
    socket.write(
      `POST /v1.52/containers/${id}/attach?stream=1&stdout=1 HTTP/1.1\r\nHost: docker.mock\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`,
    )
  })
  assert.equal(
    result.header,
    "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp",
  )
  assert.deepEqual(result.tail, Buffer.from(first))
  assert.equal(server.runtime.journal.list({ operationId: "ContainerAttach" })[0]?.status, 101)
  console.log("Node attach handshake and first bytes passed")
} finally {
  await server.close()
}
