import { Readable, Writable } from "node:stream"
import { Buffer } from "buffer"
import type { WebFetch } from "./runtime.js"

type RequestOptions = {
  protocol?: string
  hostname?: string
  host?: string
  port?: number | string
  path?: string
  method?: string
  headers?: Record<string, string | number | readonly string[]>
  signal?: AbortSignal
  timeout?: number
  agent?: unknown
}
export class ClientResponse extends Readable {
  readonly statusCode: number
  readonly statusMessage: string
  readonly headers: Record<string, string>
  readonly rawHeaders: string[]
  readonly httpVersion = "1.1"
  complete = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private reading = false
  constructor(
    response: Response,
    private readonly abort: () => void,
  ) {
    super({ autoDestroy: true })
    this.statusCode = response.status
    this.statusMessage = response.statusText
    this.headers = Object.fromEntries(response.headers)
    this.rawHeaders = [...response.headers].flat()
    this.reader = response.body?.getReader()
  }
  override _read() {
    if (this.reading) return
    if (!this.reader) {
      this.complete = true
      this.push(null)
      return
    }
    this.reading = true
    void this.reader.read().then(
      ({ done, value }) => {
        this.reading = false
        if (this.destroyed) return
        if (done) {
          this.reader = undefined
          this.complete = true
          this.push(null)
        } else if (this.push(Buffer.from(value))) this._read()
      },
      (error) => this.destroy(error),
    )
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (!this.complete) {
      this.abort()
      void this.reader?.cancel(error).catch(() => undefined)
    }
    callback(error)
  }
}

/** Explicit outgoing Node HTTP adapter over a host-owned Fetch boundary. */
export function createFetchHttpClient(fetch: WebFetch, protocol = "http:") {
  const request = (
    input: string | URL | RequestOptions,
    optionsOrCallback?: RequestOptions | ((response: ClientResponse) => void),
    callback?: (response: ClientResponse) => void,
  ) => {
    const options =
      typeof input === "object" && !(input instanceof URL)
        ? input
        : typeof optionsOrCallback === "object"
          ? optionsOrCallback
          : {}
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(
            `${options.protocol ?? protocol}//${options.hostname ?? options.host ?? "localhost"}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`,
          )
    const headers = new Headers()
    for (const [name, value] of Object.entries(options.headers ?? {}))
      for (const part of Array.isArray(value) ? value : [value]) headers.append(name, String(part))
    const controller = new AbortController()
    const chunks: Uint8Array[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let responded = false
    let incomingResponse: ClientResponse | undefined
    const incoming = typeof optionsOrCallback === "function" ? optionsOrCallback : callback
    const outgoing = new Writable({
      autoDestroy: false,
      write(chunk: Buffer, _encoding, done) {
        chunks.push(new Uint8Array(chunk))
        done()
      },
      final(done) {
        const method = options.method ?? "GET"
        let body: Uint8Array<ArrayBuffer> | undefined
        if (method !== "GET" && method !== "HEAD") {
          body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
          let offset = 0
          for (const chunk of chunks) {
            body.set(chunk, offset)
            offset += chunk.byteLength
          }
        }
        done()
        let pending: Promise<Response>
        try {
          pending = fetch(url, {
            method,
            headers,
            ...(body ? { body } : {}),
            signal: controller.signal,
            redirect: "manual",
          })
        } catch (error) {
          outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
          return
        }
        void pending.then(
          (response) => {
            if (outgoing.destroyed) {
              void response.body?.cancel().catch(() => undefined)
              return
            }
            responded = true
            if (timer) clearTimeout(timer)
            const stream = new ClientResponse(response, () => controller.abort())
            incomingResponse = stream
            stream.on("error", (error) => outgoing.destroy(error))
            stream.once("close", () => {
              options.signal?.removeEventListener("abort", abort)
              outgoing.emit("close")
            })
            outgoing.emit("response", stream)
          },
          (error) => outgoing.destroy(error instanceof Error ? error : new Error(String(error))),
        )
      },
      destroy(error, done) {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        controller.abort()
        incomingResponse?.destroy(error ?? undefined)
        done(error)
      },
    })
    const abort = () =>
      outgoing.destroy(Object.assign(new Error("Request aborted"), { code: "ECONNRESET" }))
    const configureTimeout = (ms: number, fn?: () => void) => {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError("Invalid request timeout")
      if (timer) globalThis.clearTimeout(timer)
      if (fn) outgoing.once("timeout", fn)
      if (ms && !responded) timer = globalThis.setTimeout(() => outgoing.emit("timeout"), ms)
      return outgoing
    }
    Object.assign(outgoing, {
      setTimeout: configureTimeout,
      abort,
      setHeader(name: string, value: string) {
        headers.set(name, value)
      },
      getHeader(name: string) {
        return headers.get(name)
      },
      removeHeader(name: string) {
        headers.delete(name)
      },
      flushHeaders() {},
    })
    if (incoming) outgoing.once("response", incoming)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) queueMicrotask(abort)
    if (options.timeout) configureTimeout(options.timeout)
    return outgoing as typeof outgoing & {
      setTimeout: typeof configureTimeout
      abort: typeof abort
    }
  }
  return {
    request,
    get: (...args: Parameters<typeof request>) => {
      const req = request(...args)
      req.end()
      return req
    },
  }
}
export const { request, get } = createFetchHttpClient(
  (input, init) => globalThis.fetch(input, init),
  "https:",
)
export class Agent {
  destroy() {}
}
export const globalAgent = new Agent()
export default { request, get, Agent, globalAgent }
