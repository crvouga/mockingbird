import { lstat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { isAbsolute } from "node:path"
import type { DockerRuntime } from "./runtime.js"

export type TransportOptions = {
  port?: number
  host?: string
  socketPath?: string
  /** Maximum buffered request bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /** Deadline for receiving a body, independent of long-running responses. */
  bodyTimeoutMs?: number
  /** Maximum simultaneous owned connections. Default 128. */
  maxConnections?: number
}
const positive = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`)
  return value
}

export const listenDocker = async (
  runtime: DockerRuntime,
  options: TransportOptions,
  upgrade?: (
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => Promise<void>,
) => {
  const maxBody = positive(options.maxBodyBytes ?? 1024 * 1024, "maxBodyBytes")
  const bodyTimeout = positive(options.bodyTimeoutMs ?? 30_000, "bodyTimeoutMs")
  const maxConnections = positive(options.maxConnections ?? 128, "maxConnections")
  const path = options.socketPath
  if (path !== undefined) {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 103)
      throw new Error("socketPath must be an absolute Unix path of at most 103 bytes")
    if (options.port !== undefined || options.host !== undefined)
      throw new Error("socketPath cannot be combined with port or host")
    const existing = await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (existing) throw new Error("Refusing existing socketPath")
  }
  const sockets = new Set<Socket>()
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) abort.abort()
    }
    res.once("close", onClose)
    const reject = (status: number) => {
      res.writeHead(status, { "content-type": "application/json", connection: "close" })
      res.end(JSON.stringify({ message: `Mockingbird transport rejected request (${status})` }))
    }
    try {
      if (Number(req.headers["content-length"]) > maxBody) {
        reject(413)
        return
      }
      const body = await new Promise<Buffer | undefined>((resolve, rejectBody) => {
        const chunks: Buffer[] = []
        let size = 0
        const cleanup = () => {
          clearTimeout(timer)
          req.off("data", data)
          req.off("end", end)
          req.off("error", error)
          abort.signal.removeEventListener("abort", canceled)
        }
        const canceled = () => {
          cleanup()
          rejectBody(new Error("Request disconnected"))
        }
        const error = (e: Error) => {
          cleanup()
          rejectBody(e)
        }
        const end = () => {
          cleanup()
          resolve(Buffer.concat(chunks, size))
        }
        const data = (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBody) {
            cleanup()
            req.pause()
            reject(413)
            resolve(undefined)
            return
          }
          chunks.push(chunk)
        }
        const timer = setTimeout(() => {
          cleanup()
          req.pause()
          reject(408)
          resolve(undefined)
        }, bodyTimeout)
        req.on("data", data)
        req.once("end", end)
        req.once("error", error)
        abort.signal.addEventListener("abort", canceled, { once: true })
        if (abort.signal.aborted) canceled()
      })
      if (body === undefined || abort.signal.aborted) return
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i],
          value = req.rawHeaders[i + 1]
        if (name !== undefined && value !== undefined) headers.append(name, value)
      }
      const method = req.method ?? "GET"
      const request = new Request(
        new URL((req.url ?? "/").replace(/^\/+/, "/"), "http://docker.mock"),
        {
          method,
          headers,
          signal: abort.signal,
          ...(method !== "GET" && method !== "HEAD" && body.length
            ? { body: new Uint8Array(body) }
            : {}),
        },
      )
      const response = await runtime.fetch(request)
      if (abort.signal.aborted) {
        await response.body?.cancel()
        return
      }
      const outgoing: Record<string, string | string[]> = Object.fromEntries(response.headers)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) outgoing["set-cookie"] = cookies
      res.writeHead(response.status, outgoing)
      if (!response.body) {
        res.end()
        return
      }
      res.flushHeaders()
      const reader = response.body.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      abort.signal.addEventListener("abort", cancel, { once: true })
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          if (!res.write(value))
            await new Promise<void>((resolve) => {
              const finish = () => {
                res.off("drain", finish)
                res.off("close", finish)
                resolve()
              }
              res.once("drain", finish)
              res.once("close", finish)
              if (res.destroyed) finish()
            })
        }
        if (!res.destroyed) res.end()
      } finally {
        abort.signal.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
    } catch (error) {
      if (
        (error as { code?: string })?.code === "MOCKINGBIRD_DROP" ||
        abort.signal.aborted ||
        res.headersSent
      )
        res.destroy()
      else reject(500)
    } finally {
      res.off("close", onClose)
    }
  }
  const busy = new WeakSet<Socket>()
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 30_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 5_000,
    },
    (req, res) => {
      // Sequential keep-alive is supported; pipelining cannot accumulate handlers.
      if (req.socket.destroyed || busy.has(req.socket)) {
        req.socket.destroy()
        return
      }
      busy.add(req.socket)
      const release = () => {
        busy.delete(req.socket)
        res.off("finish", release)
        res.off("close", release)
      }
      res.once("finish", release)
      res.once("close", release)
      void handle(req, res)
    },
  )
  if (upgrade)
    server.on("upgrade", (req, socket, head) => {
      if (socket.destroyed || busy.has(socket as Socket) || !sockets.has(socket as Socket)) {
        socket.destroy()
        return
      }
      busy.add(socket as Socket)
      void upgrade(req, socket, head)
    })
  server.on("connection", (socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  server.once("close", () => runtime.close())
  const host = options.host ?? "127.0.0.1"
  await new Promise<void>((resolve, reject) => {
    const error = (error: Error) => {
      server.off("listening", ready)
      reject(error)
    }
    const ready = () => {
      server.off("error", error)
      resolve()
    }
    server.once("error", error)
    server.once("listening", ready)
    if (path !== undefined) server.listen(path)
    else server.listen(options.port ?? 0, host)
  })
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  let closing: Promise<void> | undefined
  return {
    server,
    host,
    port,
    ...(path !== undefined ? { socketPath: path } : {}),
    url:
      path === undefined
        ? `http://${host.includes(":") ? `[${host}]` : host}:${port}`
        : "http://docker.mock",
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        runtime.close()
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
            reject(error)
          else resolve()
        })
        for (const socket of sockets) socket.destroy()
      })),
  }
}
