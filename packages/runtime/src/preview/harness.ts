import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { WebFetch } from "./types.js"

/** Expose the same page-to-worker client to Node E2E clients; no emulator duplication. */
export async function startPreviewHarness(
  fetch: WebFetch,
  options: { origin: string; port?: number },
) {
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    outgoing.on("close", () => controller.abort())
    try {
      const url = new URL(options.origin)
      const path = new URL(incoming.url ?? "/", "http://harness.invalid")
      url.pathname = path.pathname
      url.search = path.search
      const headers = new Headers()
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        headers.append(incoming.rawHeaders[i] ?? "", incoming.rawHeaders[i + 1] ?? "")
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const response = await fetch(url, {
        method: incoming.method ?? "GET",
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        signal: controller.signal,
        redirect: "manual",
      })
      outgoing.statusCode = response.status
      for (const [key, value] of response.headers)
        if (key !== "set-cookie") outgoing.setHeader(key, value)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) outgoing.setHeader("set-cookie", cookies)
      outgoing.setHeader("cache-control", "no-store")
      outgoing.flushHeaders()
      if (response.body)
        await pipeline(
          Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          outgoing,
        )
      else outgoing.end()
    } catch (error) {
      if (outgoing.headersSent)
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
      else {
        outgoing.statusCode = 502
        outgoing.end("Preview request failed")
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Preview harness has no address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
