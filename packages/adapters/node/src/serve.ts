import { createServer, type Server } from "node:http"
import { Readable } from "node:stream"
import type { FetchAPI } from "@crvouga/mockingbird-core"

/** Limits apply incrementally, including chunked uploads. Bodies reach fetch as a stream. */
export type NodeServeOptions = {
  port?: number
  host?: string
  maxBodyBytes?: number
  requestTimeoutMs?: number
}

/** Serve a FetchAPI with bounded streaming uploads and disconnect-aware response backpressure. */
export const serve = async (api: FetchAPI, options: NodeServeOptions = {}): Promise<Server> => {
  const maxBytes = options.maxBodyBytes ?? 16 * 1024 * 1024
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new Error("invalid request limits")
  const server = createServer(async (req, res) => {
    const aborted = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      aborted.abort()
      void reader?.cancel().catch(() => {})
    }
    const fail = (status: number, message: string) => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { "content-type": "application/json", connection: "close" })
        res.end(JSON.stringify({ error: { type: "mockingbird_transport", message } }))
      }
      abort()
    }
    req.once("aborted", abort)
    res.once("close", abort)
    res.once("error", abort)
    try {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 80
      const url = new URL(
        (req.url ?? "/").replace(/^\/+/, "/"),
        `http://${req.headers.host ?? `localhost:${port}`}`,
      )
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
      }
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method ?? "GET",
        headers,
        signal: aborted.signal,
      }
      if (init.method !== "GET" && init.method !== "HEAD") {
        if (Number(req.headers["content-length"]) > maxBytes) {
          fail(413, "request body exceeds byte limit")
          return
        }
        let bytes = 0
        const source = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
        init.body = source.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength
              if (bytes > maxBytes) {
                fail(413, "request body exceeds byte limit")
                controller.error(new Error("request body exceeds byte limit"))
              } else controller.enqueue(chunk)
            },
          }),
        )
        init.duplex = "half"
        timer = setTimeout(() => fail(408, "request body timed out"), timeoutMs)
        req.once("end", () => clearTimeout(timer))
      }
      const response = await api.fetch(new Request(url, init))
      if (aborted.signal.aborted || res.destroyed) {
        await response.body?.cancel()
        return
      }
      const output: Record<string, string | string[]> = Object.fromEntries(response.headers)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) output["set-cookie"] = cookies
      res.writeHead(response.status, output)
      if (!response.body) {
        res.end()
        return
      }
      res.flushHeaders()
      reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done || aborted.signal.aborted) break
        if (!res.write(value)) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              res.off("drain", finish)
              res.off("close", finish)
              res.off("error", finish)
              resolve()
            }
            res.once("drain", finish)
            res.once("close", finish)
            res.once("error", finish)
            if (res.destroyed || aborted.signal.aborted) finish()
          })
        }
      }
      if (!aborted.signal.aborted) res.end()
    } catch (error) {
      if ((error as { code?: string }).code === "MOCKINGBIRD_DROP") req.socket.destroy()
      else if (!aborted.signal.aborted && !res.destroyed) {
        if (res.headersSent) res.destroy()
        else {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: {
                type: "mockingbird_internal",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          )
        }
      }
    } finally {
      clearTimeout(timer)
      reader?.releaseLock()
      req.off("aborted", abort)
      res.off("close", abort)
      res.off("error", abort)
      if (!req.complete) req.resume()
    }
  })
  server.requestTimeout = timeoutMs
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host, resolve)
  })
  return server
}
