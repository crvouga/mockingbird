import type { Duplex } from "node:stream"
import type { DockerAPI } from "./index.js"
import type { DockerRuntime } from "./runtime.js"
import { isRunning } from "./state.js"

export type AttachStreamOptions = {
  frameChunkBytes?: number
  maxQueuedBytes?: number
  maxStdinBytes?: number
}
export type AttachSelection = {
  api: DockerAPI
  generation: number
  containerId: string
  namespace: string
  branch: string
  stdin: boolean
  stdout: boolean
  stderr: boolean
  stdinOnce: boolean
}
/** Node-owned live handle. Retaining one across restore never addresses a successor. */
export type DockerAttachment = {
  readonly id: number
  readonly containerId: string
  readonly namespace: string
  readonly branch: string
  readonly closed: boolean
  readonly stdinClosed: boolean
  readonly queuedBytes: number
  write(channel: "stdout" | "stderr", data: Uint8Array): Promise<void>
  takeStdin(): Uint8Array
  end(): Promise<void>
  cancel(): void
}
const limit = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024)
    throw new RangeError(`${name} must be 1..16777216`)
  return value
}
export const createAttachStreams = (options: AttachStreamOptions = {}) => {
  const chunkBytes = limit(options.frameChunkBytes ?? 64 * 1024, "frameChunkBytes")
  const maxQueued = limit(options.maxQueuedBytes ?? 1024 * 1024, "maxQueuedBytes")
  const maxStdin = limit(options.maxStdinBytes ?? 1024 * 1024, "maxStdinBytes")
  const sessions = new Set<DockerAttachment>()
  let sequence = 0
  const connect = (selection: AttachSelection, socket: Duplex, runtime: DockerRuntime) => {
    const { api, containerId, namespace, branch } = selection
    let closed = false,
      outputClosed = false,
      retired = false,
      inputEnded = false,
      queuedBytes = 0,
      inputSize = 0
    let input: Buffer[] = []
    let tail: Promise<void> = Promise.resolve()
    let releaseReady = (_ready: boolean) => {}
    const ready = new Promise<boolean>((resolve) => {
      releaseReady = resolve
    })
    const valid = () => !closed && api.generation === selection.generation
    const closeInput = () => {
      inputEnded = true
      if (!valid() || retired || !selection.stdin || !selection.stdinOnce) return
      const c = api.state.containers.get(containerId)
      if (c && !c.stdinClosed) {
        api.state.containers.update(containerId, { ...c, stdinClosed: true })
        runtime.checkpoint(namespace, branch)
      }
    }
    let detachInvalidation = () => {},
      detachExit = () => {}
    const release = () => {
      if (closed) return
      closed = true
      outputClosed = true
      releaseReady(false)
      sessions.delete(handle)
      detachInvalidation()
      detachExit()
      socket.off("data", onData)
      socket.off("end", onEnd)
    }
    const cancel = () => {
      closeInput()
      release()
      input = []
      inputSize = 0
      socket.destroy()
    }
    const send = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        const close = () => {
          socket.off("close", close)
          reject(new Error("Attachment closed"))
        }
        if (!valid() || socket.destroyed) {
          close()
          return
        }
        socket.once("close", close)
        socket.write(bytes, (error) => {
          socket.off("close", close)
          if (error) reject(error)
          else resolve()
        })
      })
    const onData = (chunk: Buffer) => {
      if (!valid() || retired) return
      if (!selection.stdin || api.state.containers.get(containerId)?.stdinClosed) return
      if (inputSize + chunk.length > maxStdin) {
        cancel()
        return
      }
      input.push(Buffer.from(chunk))
      inputSize += chunk.length
    }
    const onEnd = () => {
      closeInput()
      if (selection.stdin && !selection.stdinOnce) void handle.end().catch(cancel)
    }
    const finish = async () => {
      await tail
      if (valid() && !socket.destroyed) socket.end()
    }
    const handle: DockerAttachment = {
      id: ++sequence,
      containerId,
      namespace,
      branch,
      get closed() {
        return closed
      },
      get stdinClosed() {
        return inputEnded || api.state.containers.get(containerId)?.stdinClosed === true
      },
      get queuedBytes() {
        return queuedBytes
      },
      async write(channel, data) {
        if (!valid() || outputClosed) throw new Error("Attachment closed")
        if (channel !== "stdout" && channel !== "stderr")
          throw new TypeError("Unknown output channel")
        if (!selection[channel]) return
        const size = data.byteLength + 8
        if (size + queuedBytes > maxQueued)
          throw new RangeError("Attachment output queue limit exceeded")
        const frame = Buffer.allocUnsafe(size)
        frame[0] = channel === "stdout" ? 1 : 2
        frame.fill(0, 1, 4)
        frame.writeUInt32BE(data.byteLength, 4)
        frame.set(data, 8)
        queuedBytes += size
        const result = tail.then(async () => {
          if (!(await ready) || !valid()) throw new Error("Attachment closed")
          for (let at = 0; at < frame.length; at += chunkBytes)
            await send(frame.subarray(at, at + chunkBytes))
        })
        tail = result.catch(() => {})
        try {
          await result
        } finally {
          queuedBytes -= size
        }
      },
      takeStdin() {
        const result = Buffer.concat(input, inputSize)
        input = []
        inputSize = 0
        return result
      },
      async end() {
        if (!valid() || outputClosed) return
        outputClosed = true
        closeInput()
        const c = api.state.containers.get(containerId)
        if (selection.stdinOnce && c && isRunning(c)) return
        await finish()
      },
      cancel,
    }
    socket.once("close", () => {
      if (valid()) closeInput()
      release()
    })
    detachInvalidation = api.onInvalidate(cancel)
    detachExit = api.lifecycle.onExit((id) => {
      if (id === containerId) {
        retired = true
        input = []
        inputSize = 0
        inputEnded = true
        outputClosed = true
        void finish().catch(cancel)
      }
    })
    sessions.add(handle)
    if (!valid()) {
      cancel()
    }
    return {
      handle,
      start(head: Buffer) {
        if (!valid()) return
        socket.on("data", onData)
        socket.once("end", onEnd)
        if (head.length) onData(head)
        releaseReady(true)
        socket.resume()
        if (!selection.stdin && !selection.stdout && !selection.stderr)
          void handle.end().catch(cancel)
      },
      cancel,
    }
  }
  return { connect, list: () => [...sessions] }
}
