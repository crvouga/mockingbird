import { createConnection } from "node:net"
import type { DockerServer } from "../src/server.js"

/** Independent raw consumer: parse arbitrary splits without importing the encoder. */
export const attachClient = async (
  server: DockerServer,
  id: string,
  query = "stdout=1&stderr=1",
  input = Buffer.alloc(0),
  headers = "",
) => {
  const socket = createConnection({ host: server.host, port: server.port, allowHalfOpen: true })
  let bytes = Buffer.alloc(0),
    upgraded = false,
    ended = false
  const frames: { channel: number; data: Buffer }[] = []
  const pending: {
    resolve: (frame: { channel: number; data: Buffer }) => void
    reject: (error: Error) => void
  }[] = []
  let readyResolve = () => {},
    readyReject = (_error: Error) => {}
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const endedPromise = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  const fail = (error: Error) => {
    readyReject(error)
    for (const waiter of pending.splice(0)) waiter.reject(error)
  }
  socket.on("error", fail)
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    if (!upgraded) {
      const at = bytes.indexOf("\r\n\r\n")
      if (at < 0) return
      if (!bytes.subarray(0, at).toString().startsWith("HTTP/1.1 101")) {
        fail(new Error("upgrade rejected"))
        socket.destroy()
        return
      }
      bytes = bytes.subarray(at + 4)
      upgraded = true
      readyResolve()
    }
    while (bytes.length >= 8) {
      const length = bytes.readUInt32BE(4)
      if (bytes.length < 8 + length) return
      const frame = { channel: bytes[0] ?? -1, data: Buffer.from(bytes.subarray(8, 8 + length)) }
      if (![1, 2].includes(frame.channel) || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) {
        fail(new Error("invalid frame"))
        socket.destroy()
        return
      }
      bytes = bytes.subarray(8 + length)
      const waiter = pending.shift()
      if (waiter) waiter.resolve(frame)
      else frames.push(frame)
    }
  })
  socket.once("end", () => {
    ended = true
    fail(new Error("EOF"))
    socket.end()
  })
  socket.once("close", () => {
    ended = true
    fail(new Error("closed"))
  })
  socket.write(
    Buffer.concat([
      Buffer.from(
        `POST /v1.52/containers/${id}/attach?stream=1&${query} HTTP/1.1\r\nHost: docker.mock\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n${headers}\r\n`,
      ),
      input,
    ]),
  )
  await ready
  return {
    socket,
    ended: endedPromise,
    read: () =>
      new Promise<{ channel: number; data: Buffer }>((resolve, reject) => {
        const frame = frames.shift()
        if (frame) resolve(frame)
        else if (ended) reject(new Error("EOF"))
        else pending.push({ resolve, reject })
      }),
    close: () => socket.destroy(),
  }
}
