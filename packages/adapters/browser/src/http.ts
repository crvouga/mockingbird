import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { Buffer } from "buffer"
import { browserRuntime, UnsupportedRuntimeError } from "./runtime.js"

const noBody = new Set([204, 205, 304])
type HeaderValue = string | number | readonly string[]
const abortError = () =>
  Object.assign(new Error("Request aborted"), { name: "AbortError", code: "ECONNRESET" })
const socket = () =>
  Object.assign(new EventEmitter(), {
    remoteAddress: "127.0.0.1",
    remotePort: 0,
    localAddress: "127.0.0.1",
    localPort: 0,
    encrypted: false,
    writable: true,
    readable: true,
    setTimeout() {
      return this
    },
    setNoDelay() {
      return this
    },
    setKeepAlive() {
      return this
    },
    cork() {},
    uncork() {},
    ref() {
      return this
    },
    unref() {
      return this
    },
  })

export class IncomingMessage extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly rawHeaders: string[]
  readonly httpVersion = "1.1"
  readonly httpVersionMajor = 1
  readonly httpVersionMinor = 1
  readonly trailers = {}
  readonly rawTrailers: string[] = []
  readonly socket = socket()
  readonly connection = this.socket
  complete = false
  aborted = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private reading = false
  constructor(request: Request) {
    super({ autoDestroy: true })
    const url = new URL(request.url)
    this.method = request.method
    this.url = url.pathname + url.search
    this.headers = Object.fromEntries(request.headers)
    this.rawHeaders = [...request.headers].flat()
    this.reader = request.body?.getReader()
  }
  override _read() {
    if (this.reading) return
    const reader = this.reader
    if (!reader) {
      this.complete = true
      this.push(null)
      return
    }
    this.reading = true
    void reader.read().then(
      ({ done, value }) => {
        this.reading = false
        if (this.destroyed) return
        if (done) {
          this.complete = true
          this.reader = undefined
          this.push(null)
        } else if (this.push(Buffer.from(value))) this._read()
      },
      (error) => this.destroy(error),
    )
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (!this.complete) {
      this.aborted = true
      this.emit("aborted")
      void this.reader?.cancel(error).catch(() => undefined)
    }
    this.reader = undefined
    callback(error)
  }
  setTimeout() {
    return this
  }
}

export class ServerResponse extends Writable {
  statusCode = 200
  statusMessage = ""
  headersSent = false
  finished = false
  sendDate = false
  readonly socket = socket()
  readonly connection = this.socket
  req?: IncomingMessage
  private readonly headers = new Map<string, { name: string; value: HeaderValue }>()
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private blocked: ((error?: Error | null) => void) | undefined
  constructor(
    private readonly respond: (response: Response) => void,
    private readonly method: string,
  ) {
    super({ autoDestroy: true })
  }
  setHeader(name: string, value: HeaderValue) {
    if (this.headersSent) throw new Error("Headers already sent")
    new Headers({ [name]: String(value) })
    this.headers.set(name.toLowerCase(), { name, value })
    return this
  }
  appendHeader(name: string, value: string | readonly string[]) {
    return this.setHeader(name, [this.getHeader(name) ?? [], value].flat().map(String))
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase())?.value
  }
  getHeaders() {
    return Object.fromEntries([...this.headers].map(([name, entry]) => [name, entry.value]))
  }
  getHeaderNames() {
    return [...this.headers.keys()]
  }
  hasHeader(name: string) {
    return this.headers.has(name.toLowerCase())
  }
  removeHeader(name: string) {
    if (this.headersSent) throw new Error("Headers already sent")
    this.headers.delete(name.toLowerCase())
  }
  writeHead(
    status: number,
    statusOrHeaders?: string | Record<string, HeaderValue>,
    headers?: Record<string, HeaderValue>,
  ) {
    this.statusCode = status
    if (typeof statusOrHeaders === "string") this.statusMessage = statusOrHeaders
    for (const [name, value] of Object.entries(
      typeof statusOrHeaders === "object" ? statusOrHeaders : (headers ?? {}),
    ))
      this.setHeader(name, value)
    this.flushHeaders()
    return this
  }
  flushHeaders() {
    if (this.headersSent) return
    const headers = new Headers()
    for (const { name, value } of this.headers.values())
      for (const part of Array.isArray(value) ? value : [value]) headers.append(name, String(part))
    const body =
      this.method === "HEAD" || noBody.has(this.statusCode)
        ? null
        : new ReadableStream<Uint8Array>({
            start: (controller) => {
              this.controller = controller
            },
            pull: () => {
              const blocked = this.blocked
              this.blocked = undefined
              blocked?.()
            },
            cancel: () => {
              this.req?.destroy(abortError())
              this.destroy(abortError())
            },
          })
    const response = new Response(body, {
      status: this.statusCode,
      statusText: this.statusMessage,
      headers,
    })
    this.headersSent = true
    this.respond(response)
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    try {
      this.emit("preview:activity")
      this.flushHeaders()
      if (!this.controller || chunk.byteLength === 0) return callback()
      this.controller.enqueue(new Uint8Array(chunk))
      if ((this.controller.desiredSize ?? 0) > 0) callback()
      else this.blocked = callback
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
  override _final(callback: (error?: Error | null) => void) {
    try {
      this.flushHeaders()
      this.finished = true
      this.controller?.close()
      this.controller = undefined
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (!this.finished) this.controller?.error(error ?? abortError())
    this.controller = undefined
    const blocked = this.blocked
    this.blocked = undefined
    blocked?.(error ?? abortError())
    callback(error)
  }
  setTimeout() {
    return this
  }
}
export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void

export type HttpServer = EventEmitter & {
  listening: boolean
  listen(
    port: number,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): HttpServer
  address(): { address: string; family: string; port: number } | null
  close(callback?: (error?: Error) => void): HttpServer
  setTimeout(ms: number, callback?: () => void): HttpServer
  closeAllConnections(): void
  closeIdleConnections(): void
}
export type HttpAdapter = {
  Server: new (
    optionsOrHandler?: RequestListener | Record<string, unknown>,
    handler?: RequestListener,
  ) => HttpServer
  createServer(
    optionsOrHandler?: RequestListener | Record<string, unknown>,
    handler?: RequestListener,
  ): HttpServer
  IncomingMessage: typeof IncomingMessage
  ServerResponse: typeof ServerResponse
}

/** Bind Node HTTP handlers to an explicitly selected browser world. */
export function createHttpAdapter(runtime: Pick<typeof browserRuntime, "bun">): HttpAdapter {
  class Server extends EventEmitter {
    listening = false
    timeout = 0
    setTimeout(ms: number, callback?: () => void) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError("Invalid timeout")
      this.timeout = ms
      if (callback) this.on("timeout", callback)
      return this
    }
    closeAllConnections() {
      for (const response of this.responses) response.destroy(abortError())
    }
    closeIdleConnections() {}
    private listener: ReturnType<typeof browserRuntime.bun.serve> | undefined
    private responses = new Set<ServerResponse>()
    constructor(
      optionsOrHandler?: RequestListener | Record<string, unknown>,
      handler?: RequestListener,
    ) {
      super()
      if (typeof optionsOrHandler === "object" && Object.keys(optionsOrHandler).length)
        throw new UnsupportedRuntimeError("http.createServer options")
      const listener = typeof optionsOrHandler === "function" ? optionsOrHandler : handler
      if (listener) this.on("request", listener)
    }
    listen(
      port: number | { port?: number; host?: string },
      hostnameOrCallback?: string | (() => void),
      callback?: () => void,
    ) {
      if (this.listener) throw new Error("Server is already listening")
      const selectedPort = typeof port === "object" ? (port.port ?? 0) : port
      const hostname =
        typeof port === "object"
          ? (port.host ?? "localhost")
          : typeof hostnameOrCallback === "string"
            ? hostnameOrCallback
            : "localhost"
      this.listener = runtime.bun.serve({
        port: selectedPort,
        hostname,
        fetch: (request) =>
          new Promise<Response>((resolve, reject) => {
            const incoming = new IncomingMessage(request)
            const response = new ServerResponse(resolve, request.method)
            response.req = incoming
            this.responses.add(response)
            let timer: ReturnType<typeof setTimeout> | undefined
            const activity = () => {
              if (timer) clearTimeout(timer)
              if (this.timeout > 0)
                timer = setTimeout(() => {
                  if (!this.emit("timeout", response.socket)) response.destroy(abortError())
                }, this.timeout)
            }
            activity()
            response.on("preview:activity", activity)
            const abort = () => {
              incoming.destroy(abortError())
              response.destroy(abortError())
            }
            request.signal.addEventListener("abort", abort, { once: true })
            response.on("error", reject)
            incoming.on("error", (error) => {
              response.destroy(error)
              reject(error)
            })
            response.once("close", () => {
              this.responses.delete(response)
              if (timer) clearTimeout(timer)
              request.signal.removeEventListener("abort", abort)
              if (!incoming.complete) incoming.destroy()
            })
            if (request.signal.aborted) {
              abort()
              return
            }
            try {
              this.emit("request", incoming, response)
            } catch (error) {
              response.destroy(error instanceof Error ? error : new Error(String(error)))
            }
          }),
      })
      void this.listener.finished.then(() => {
        this.listening = false
        for (const response of this.responses) response.destroy(abortError())
      })
      this.listening = true
      queueMicrotask(() => {
        this.emit("listening")
        ;(typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback)?.()
      })
      return this
    }
    address() {
      return this.listener
        ? { address: "127.0.0.1", family: "IPv4", port: this.listener.port }
        : null
    }
    close(callback?: (error?: Error) => void) {
      this.listener?.stop()
      this.listener = undefined
      this.listening = false
      for (const response of this.responses) response.destroy(abortError())
      queueMicrotask(() => {
        this.emit("close")
        callback?.()
      })
      return this
    }
  }
  return {
    Server,
    createServer: (
      optionsOrHandler?: RequestListener | Record<string, unknown>,
      handler?: RequestListener,
    ) => new Server(optionsOrHandler, handler),
    IncomingMessage,
    ServerResponse,
  }
}
export const { Server, createServer } = createHttpAdapter(browserRuntime)
export const unsupportedHttp = (name: string): never => {
  throw new UnsupportedRuntimeError(`http.${name}`)
}
