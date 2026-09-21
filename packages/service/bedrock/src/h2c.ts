/// <reference types="node" />
/**
 * One port that speaks both cleartext HTTP/2 (prior knowledge, "h2c") and HTTP/1.1.
 *
 * AWS SDK v3 clients for Bedrock Runtime, Polly and Transcribe Streaming default to
 * `NodeHttp2Handler`, so against an `http://` endpoint they open an h2c connection and
 * send the HTTP/2 connection preface straight away; bidirectional operations (Nova Sonic,
 * `StartSpeechSynthesisStream`, `StartStreamTranscription`) need HTTP/2 duplex. The AI SDK,
 * AgentCore and Transcribe batch clients speak HTTP/1.1. A front `node:net` server reads
 * the first bytes of each connection and hands it to an internal HTTP/2 or HTTP/1.1
 * server; both turn requests into Fetch `Request`s whose bodies stream in as they arrive,
 * and stream responses back chunk by chunk.
 */
import {
  createServer as createHttp1Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import {
  createServer as createHttp2Server,
  constants as http2Constants,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2"
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from "node:net"
import { Readable } from "node:stream"
import type { FetchAPI } from "@crvouga/mockingbird-core"

export type H2cListenOptions = {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

/** A running dual-protocol listener. */
export type H2cListening = {
  url: string
  port: number
  host: string
  close(): Promise<void>
}

const PREFACE = "PRI * HTTP/2.0"

/** Headers HTTP/2 forbids on a response (RFC 9113 §8.2.2). */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
])

const toWebBody = (stream: Readable): ReadableStream<Uint8Array> =>
  Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>

const isDrop = (error: unknown) => (error as { code?: string } | null)?.code === "MOCKINGBIRD_DROP"

const internalError = (error: unknown) =>
  JSON.stringify({
    error: {
      type: "mockingbird_internal",
      message: error instanceof Error ? error.message : String(error),
    },
  })

/** Write a Fetch response body to a Node writable, respecting backpressure. */
const pump = async (
  body: ReadableStream<Uint8Array>,
  write: (chunk: Uint8Array) => boolean,
  drained: () => Promise<void>,
  closed: () => boolean,
): Promise<void> => {
  const reader = body.getReader()
  try {
    for (;;) {
      if (closed()) {
        await reader.cancel().catch(() => undefined)
        return
      }
      const { done, value } = await reader.read()
      if (done) return
      if (!write(value)) await drained()
    }
  } finally {
    reader.releaseLock()
  }
}

const handleHttp1 = async (
  api: FetchAPI,
  base: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const method = req.method ?? "GET"
  const url = new URL((req.url ?? "/").replace(/^\/+/, "/"), `http://${req.headers.host ?? base}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each)
  }
  const aborted = new AbortController()
  res.once("close", () => {
    if (!res.writableFinished) aborted.abort()
  })
  const hasBody = method !== "GET" && method !== "HEAD"
  const request = new Request(url, {
    method,
    headers,
    signal: aborted.signal,
    ...(hasBody ? { body: toWebBody(req), duplex: "half" } : {}),
  } as RequestInit)
  let response: Response
  try {
    response = await api.fetch(request)
  } catch (error) {
    if (isDrop(error)) {
      req.socket.destroy()
      return
    }
    res.writeHead(500, { "content-type": "application/json" })
    res.end(internalError(error))
    return
  }
  const out: Record<string, string | string[]> = Object.fromEntries(response.headers)
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) out["set-cookie"] = cookies
  res.writeHead(response.status, out)
  if (!response.body) {
    res.end()
    return
  }
  res.flushHeaders()
  try {
    await pump(
      response.body,
      (chunk) => res.write(chunk),
      () => new Promise((resolve) => res.once("drain", resolve)),
      () => res.destroyed,
    )
    res.end()
  } catch {
    res.destroy()
  }
}

const handleHttp2 = async (
  api: FetchAPI,
  base: string,
  stream: ServerHttp2Stream,
  incoming: IncomingHttpHeaders,
): Promise<void> => {
  const method = String(incoming[":method"] ?? "GET")
  const authority = String(incoming[":authority"] ?? incoming.host ?? base)
  const url = new URL(String(incoming[":path"] ?? "/").replace(/^\/+/, "/"), `http://${authority}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (name.startsWith(":") || value === undefined) continue
    for (const each of Array.isArray(value) ? value : [value]) headers.append(name, String(each))
  }
  const aborted = new AbortController()
  stream.once("close", () => {
    if (!stream.writableFinished) aborted.abort()
  })
  stream.on("error", () => undefined)
  const hasBody = method !== "GET" && method !== "HEAD"
  const request = new Request(url, {
    method,
    headers,
    signal: aborted.signal,
    ...(hasBody ? { body: toWebBody(stream), duplex: "half" } : {}),
  } as RequestInit)
  let response: Response
  try {
    response = await api.fetch(request)
  } catch (error) {
    if (isDrop(error)) {
      stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR)
      return
    }
    if (stream.destroyed) return
    stream.respond({ ":status": 500, "content-type": "application/json" })
    stream.end(internalError(error))
    return
  }
  if (stream.destroyed || stream.closed) return
  const out: Record<string, string | string[] | number> = { ":status": response.status }
  for (const [name, value] of response.headers) {
    if (!CONNECTION_HEADERS.has(name)) out[name] = value
  }
  if (!response.body) {
    stream.respond(out, { endStream: true })
    return
  }
  stream.respond(out)
  try {
    await pump(
      response.body,
      (chunk) => stream.write(chunk),
      () => new Promise((resolve) => stream.once("drain", resolve)),
      () => stream.destroyed || stream.closed,
    )
    if (!stream.destroyed) stream.end()
  } catch {
    if (!stream.destroyed) stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR)
  }
}

const listenInternal = (server: {
  listen: (...args: unknown[]) => unknown
  once: (...args: never[]) => unknown
  address(): AddressInfo | string | null
}) =>
  new Promise<number>((resolve, reject) => {
    ;(server.once as (event: string, listener: (error: Error) => void) => void)("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  })

/**
 * Serve `api` over h2c and HTTP/1.1 on one port. Each accepted connection is sniffed for
 * the HTTP/2 preface and relayed to an internal loopback server for that protocol.
 */
export const listenH2c = async (
  api: FetchAPI,
  options: H2cListenOptions = {},
): Promise<H2cListening> => {
  const host = options.host ?? "127.0.0.1"
  const shown = host.includes(":") ? `[${host}]` : host
  let base = `${shown}:${options.port ?? 0}`
  const h1 = createHttp1Server((req, res) => {
    void handleHttp1(api, base, req, res)
  })
  const h2 = createHttp2Server()
  h2.on("stream", (stream, headers) => {
    void handleHttp2(api, base, stream, headers)
  })
  h2.on("sessionError", () => undefined)
  const h1Port = await listenInternal(h1 as never)
  const h2Port = await listenInternal(h2 as never)
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  const front = createNetServer((socket) => {
    track(socket)
    socket.setNoDelay(true)
    let seen = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk])
      // "PRI" opens only the HTTP/2 preface; no HTTP/1.1 method starts that way.
      if (seen.length < 3) return
      socket.off("data", onData)
      socket.pause()
      const http2 = seen.subarray(0, 3).toString("latin1") === PREFACE.slice(0, 3)
      const upstream = connect(http2 ? h2Port : h1Port, "127.0.0.1")
      track(upstream)
      upstream.setNoDelay(true)
      const destroy = () => {
        socket.destroy()
        upstream.destroy()
      }
      socket.on("error", destroy)
      upstream.on("error", destroy)
      socket.once("close", () => upstream.destroy())
      upstream.once("close", () => socket.destroy())
      upstream.write(seen)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    }
    socket.on("data", onData)
    socket.on("error", () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    front.once("error", reject)
    front.listen(options.port ?? 0, host, () => resolve())
  })
  const port = (front.address() as AddressInfo).port
  base = `${shown}:${port}`
  const closeServer = (server: { close: (cb: (error?: Error) => void) => unknown }) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  return {
    url: `http://${shown}:${port}`,
    port,
    host,
    close: async () => {
      const closing = [
        closeServer(front as never),
        closeServer(h1 as never),
        closeServer(h2 as never),
      ]
      for (const socket of sockets) socket.destroy()
      h1.closeAllConnections?.()
      await Promise.all(closing)
    },
  }
}
