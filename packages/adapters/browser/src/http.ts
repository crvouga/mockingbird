import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { Buffer } from "buffer"
import { browserRuntime, UnsupportedRuntimeError } from "./runtime.js"

/** HTTP/1 request/response adapter for browser-local Node handlers. No socket is opened. */
export class IncomingMessage extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly rawHeaders: string[]
  readonly httpVersion = "1.1"
  constructor(request: Request) {
    super({ read() {} })
    const url = new URL(request.url)
    this.method = request.method
    this.url = url.pathname + url.search
    this.headers = Object.fromEntries(request.headers)
    this.rawHeaders = [...request.headers].flat()
    void request.arrayBuffer().then(
      (body) => {
        this.push(Buffer.from(body))
        this.push(null)
      },
      (error) => this.destroy(error),
    )
  }
}
export class ServerResponse extends Writable {
  statusCode = 200
  statusMessage = ""
  headersSent = false
  private readonly headers = new Headers()
  private readonly chunks: Uint8Array[] = []
  constructor(
    private readonly respond: (response: Response) => void,
    private readonly method: string,
  ) {
    super()
    this.on("finish", () => {
      const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of this.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const body =
        this.method === "HEAD" || [204, 205, 304].includes(this.statusCode) ? null : bytes
      this.respond(new Response(body, { status: this.statusCode, headers: this.headers }))
    })
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    if (this.headersSent) throw new Error("Headers already sent")
    this.headers.delete(name)
    for (const part of Array.isArray(value) ? value : [value])
      this.headers.append(name, String(part))
    return this
  }
  getHeader(name: string) {
    return this.headers.get(name) ?? undefined
  }
  getHeaders() {
    return Object.fromEntries(this.headers)
  }
  hasHeader(name: string) {
    return this.headers.has(name)
  }
  removeHeader(name: string) {
    if (this.headersSent) throw new Error("Headers already sent")
    this.headers.delete(name)
  }
  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>) {
    this.statusCode = status
    for (const [key, value] of Object.entries(headers ?? {})) this.setHeader(key, value)
    this.headersSent = true
    return this
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.headersSent = true
    this.chunks.push(new Uint8Array(chunk))
    callback()
  }
}
export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void
export class Server extends EventEmitter {
  private listener: ReturnType<typeof browserRuntime.bun.serve> | undefined
  constructor(handler?: RequestListener) {
    super()
    if (handler) this.on("request", handler)
  }
  listen(port: number, hostnameOrCallback?: string | (() => void), callback?: () => void) {
    if (this.listener) throw new Error("Server is already listening")
    this.listener = browserRuntime.bun.serve({
      port,
      hostname: typeof hostnameOrCallback === "string" ? hostnameOrCallback : "localhost",
      fetch: (request) =>
        new Promise<Response>((resolve, reject) => {
          const incoming = new IncomingMessage(request)
          const response = new ServerResponse(resolve, request.method)
          response.on("error", reject)
          incoming.on("error", reject)
          this.emit("request", incoming, response)
        }),
    })
    queueMicrotask(() => {
      this.emit("listening")
      ;(typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback)?.()
    })
    return this
  }
  address() {
    return this.listener
      ? { address: this.listener.hostname, family: "IPv4", port: this.listener.port }
      : null
  }
  close(callback?: (error?: Error) => void) {
    this.listener?.stop()
    this.listener = undefined
    queueMicrotask(() => {
      this.emit("close")
      callback?.()
    })
    return this
  }
}
export const createServer = (handler?: RequestListener) => new Server(handler)
export const unsupportedHttp = (name: string): never => {
  throw new UnsupportedRuntimeError(`http.${name}`)
}
