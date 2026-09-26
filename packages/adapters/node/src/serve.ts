import { createServer } from "node:http"
import type { FetchAPI } from "@crvouga/mockingbird-core"

/** Options for {@link serve}. */
export type NodeServeOptions = {
  port?: number
  host?: string
}

/**
 * Serve any Mockingbird {@link FetchAPI} over `node:http`.
 * Port defaults to `0`, so the OS assigns an ephemeral port (read from `server.address()`).
 */
export const serve = async (api: FetchAPI, options: NodeServeOptions = {}) => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : undefined
    const base = `http://${req.headers.host ?? `localhost:${port ?? 80}`}`
    const raw = req.url ?? "/"
    const url = new URL(raw.replace(/^\/+/, "/"), base)
    const method = req.method ?? "GET"
    const init: RequestInit = { method, headers: req.headers as Record<string, string> }
    if (method !== "GET" && method !== "HEAD" && body.length > 0) {
      init.body = body
    }
    const aborted = new AbortController()
    res.once("close", () => {
      if (!res.writableFinished) aborted.abort()
    })
    init.signal = aborted.signal
    const request = new Request(url, init)
    let response: Response
    try {
      response = await api.fetch(request)
    } catch (error) {
      // A `drop` fault: destroy the socket so the client sees the connection die.
      if ((error as { code?: string }).code === "MOCKINGBIRD_DROP") {
        req.socket.destroy()
        return
      }
      res.writeHead(500, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            type: "mockingbird_internal",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      return
    }
    // Headers#entries() joins repeated headers; Set-Cookie must stay one header per cookie.
    const headers: Record<string, string | string[]> = Object.fromEntries(response.headers)
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) headers["set-cookie"] = cookies
    if (!response.body) {
      res.writeHead(response.status, headers)
      res.end()
      return
    }
    // Stream the body chunk by chunk: event streams and long-polls must not be buffered.
    res.writeHead(response.status, headers)
    res.flushHeaders()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve))
      }
      res.end()
    } catch {
      res.destroy()
    } finally {
      reader.releaseLock()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host, resolve)
  })
  return server
}
