import { AsyncLocalStorage } from "node:async_hooks"
import type { IncomingMessage } from "node:http"
import { STATUS_CODES } from "node:http"
import type { Duplex } from "node:stream"
import { annotateResponse, jsonRes } from "@crvouga/mockingbird-service"
import type { DockerAPI } from "./index.js"
import { booleanQuery } from "./observations.js"
import type { DockerRuntime } from "./runtime.js"
import { DockerInputError } from "./state.js"
import { type AttachSelection, type AttachStreamOptions, createAttachStreams } from "./streams.js"

export type AttachHandshakeOptions = {
  /** Deterministic mock writes; network packet boundaries remain OS-controlled. */
  chunkBytes?: number
  /** Synthetic already-framed output delivered with the final header fragment. */
  initialStreamBytes?: Uint8Array
}
type Admission = { selection?: AttachSelection }
const header = Buffer.from(
  "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
)

export const createAttachHandshake = (
  options: AttachHandshakeOptions = {},
  streamOptions: AttachStreamOptions = {},
) => {
  const streams = createAttachStreams(streamOptions)
  const chunkBytes = options.chunkBytes ?? header.length
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 4096)
    throw new RangeError("attach chunkBytes must be 1..4096")
  if ((options.initialStreamBytes?.byteLength ?? 0) > 1024 * 1024)
    throw new RangeError("initialStreamBytes exceeds 1 MiB")
  const first = Buffer.from(options.initialStreamBytes ?? [])
  const admission = new AsyncLocalStorage<Admission>()
  const prepare = (api: DockerAPI, request: Request): Response => {
    const context = admission.getStore()
    if (!context) return jsonRes(501, { message: "Mockingbird: attach requires Node HTTP upgrade" })
    const url = new URL(request.url)
    if (
      !booleanQuery(url, "stream") ||
      booleanQuery(url, "logs") ||
      url.searchParams.has("detachKeys") ||
      [...url.searchParams.keys()].some(
        (key) => !["stream", "logs", "stdin", "stdout", "stderr"].includes(key),
      )
    )
      return jsonRes(501, { message: "Mockingbird: attach mode is not implemented" })
    const match = /^\/containers\/([^/]+)\/attach$/.exec(url.pathname)
    if (!match?.[1]) return jsonRes(404, { message: "page not found" })
    let name: string
    try {
      name = decodeURIComponent(match[1])
    } catch {
      return jsonRes(400, { message: "invalid container name encoding" })
    }
    try {
      const c = api.state.find(name)
      if (c.status === "paused")
        throw new DockerInputError(
          409,
          `container ${name} is paused, unpause the container before attach`,
        )
      if (c.status === "restarting")
        throw new DockerInputError(
          409,
          `container ${name} is restarting, wait until the container is running`,
        )
      if (c.config?.Tty === true)
        return jsonRes(501, { message: "Mockingbird: TTY attach is not implemented" })
      context.selection = {
        api,
        generation: api.generation,
        containerId: c.id,
        namespace: request.headers.get("x-mockingbird-namespace") ?? "default",
        branch: request.headers.get("x-mockingbird-branch") ?? "main",
        stdin: booleanQuery(url, "stdin") && c.config?.OpenStdin === true,
        stdinOnce: c.config?.StdinOnce === true,
        stdout: booleanQuery(url, "stdout"),
        stderr: booleanQuery(url, "stderr"),
      }
      return annotateResponse(new Response(null), { wireStatus: 101, ids: { containerId: c.id } })
    } catch (error) {
      if (error instanceof DockerInputError)
        return new Response(`${error.message}\r\n`, {
          status: error.status,
          headers: { "content-type": "application/vnd.docker.raw-stream" },
        })
      throw error
    }
  }
  const write = (socket: Duplex, bytes: Uint8Array) =>
    new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        socket.off("close", closed)
        resolve(ok)
      }
      const closed = () => finish(false)
      socket.once("close", closed)
      if (socket.destroyed) {
        finish(false)
        return
      }
      socket.write(bytes, (error) => finish(!error))
    })
  const upgrade = async (
    runtime: DockerRuntime,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    socket.on("error", () => socket.destroy())
    socket.pause()
    try {
      if (
        req.method !== "POST" ||
        req.headers.upgrade?.toLowerCase() !== "tcp" ||
        !req.headers.connection
          ?.toLowerCase()
          .split(/\s*,\s*/)
          .includes("upgrade") ||
        Number(req.headers["content-length"] ?? 0) !== 0 ||
        req.headers["transfer-encoding"] !== undefined
      ) {
        await write(
          socket,
          Buffer.from(
            "HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          ),
        )
        socket.end()
        return
      }
      const target = new URL((req.url ?? "/").replace(/^\/+/, "/"), "http://docker.mock")
      if (
        !/^(?:\/ns\/[^/]+)?(?:\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+\/attach$/.test(target.pathname)
      ) {
        await write(
          socket,
          Buffer.from("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
        )
        socket.end()
        return
      }
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i],
          value = req.rawHeaders[i + 1]
        if (name && value !== undefined) headers.append(name, value)
      }
      const request = new Request(
        new URL((req.url ?? "/").replace(/^\/+/, "/"), "http://docker.mock"),
        { method: "POST", headers },
      )
      const context: Admission = {}
      const response = await admission.run(context, () => runtime.fetch(request))
      if (socket.destroyed) return
      if (!context.selection || response.status !== 200) {
        const body = Buffer.from(await response.arrayBuffer())
        const type = response.headers.get("content-type") ?? "application/json"
        await write(
          socket,
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? "Error"}\r\nContent-Type: ${type}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`,
            ),
            body,
          ]),
        )
        socket.end()
        return
      }
      const session = streams.connect(context.selection, socket, runtime)
      for (let offset = 0; offset < header.length; offset += chunkBytes) {
        const end = Math.min(offset + chunkBytes, header.length)
        const chunk = header.subarray(offset, end)
        if (!(await write(socket, end === header.length ? Buffer.concat([chunk, first]) : chunk)))
          return
        if (end < header.length) await new Promise<void>((resolve) => setImmediate(resolve))
      }
      session.start(head)
    } catch {
      socket.destroy()
    }
  }
  return { prepare, upgrade, attachments: streams.list }
}
