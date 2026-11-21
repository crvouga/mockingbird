import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import type { PreviewFetch } from "./bridge.js"

/** Use the same Fetch bridge in Node runners. The caller owns routing and static assets. */
export function previewNodeHandler(fetch: PreviewFetch) {
  return (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const abort = new AbortController()
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort()
    })
    const run = async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const response = await fetch(
        new Request(new URL(incoming.url ?? "/", "http://preview.local"), {
          method: incoming.method ?? "GET",
          headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : Array.isArray(value)
                ? value.map((item) => [key, item] as [string, string])
                : [[key, value]],
          ),
          body: ["GET", "HEAD"].includes(incoming.method ?? "GET") ? null : Buffer.concat(chunks),
          signal: abort.signal,
          redirect: "manual",
        }),
      )
      outgoing.statusCode = response.status
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") outgoing.setHeader(key, value)
      })
      if (response.headers.getSetCookie().length)
        outgoing.setHeader("set-cookie", response.headers.getSetCookie())
      outgoing.setHeader("cache-control", "no-store")
      if (!response.body || incoming.method === "HEAD") {
        await response.body?.cancel()
        outgoing.end()
        return
      }
      outgoing.flushHeaders()
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        outgoing,
      )
    }
    void run().catch(() => {
      if (outgoing.headersSent) outgoing.destroy()
      else {
        outgoing.writeHead(502)
        outgoing.end("Preview request failed")
      }
    })
  }
}
export async function listenPreview(
  fetch: PreviewFetch,
  options: { port?: number; hostname?: string } = {},
) {
  const server = createServer(previewNodeHandler(fetch))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Preview listener has no TCP address")
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
export {
  type BuildPreviewPartsOptions,
  type BuiltPreviewParts,
  buildPreviewPartSet,
  buildPreviewParts,
  type PreviewPartSource,
  type PreviewPartsWatcher,
  watchPreviewParts,
} from "./parts-build.js"
