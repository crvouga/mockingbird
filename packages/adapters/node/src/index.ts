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
    const request = new Request(url, init)
    const response = await api.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host, resolve)
  })
  return server
}
