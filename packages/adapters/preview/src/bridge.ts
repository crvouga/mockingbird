const PROTOCOL = "mockingbird-preview/1"
export type PreviewPort = Pick<
  MessagePort,
  "postMessage" | "addEventListener" | "removeEventListener" | "start" | "close"
>
export type PreviewFetch = (request: Request) => Response | Promise<Response>
type Envelope = { protocol: typeof PROTOCOL; id: number; kind: string; [key: string]: unknown }
const envelope = (data: unknown): data is Envelope => {
  if (!data || typeof data !== "object") return false
  const value = data as Partial<Envelope>
  return (
    value.protocol === PROTOCOL && Number.isSafeInteger(value.id) && typeof value.kind === "string"
  )
}
const failure = (message: string) => new Error(`Preview bridge: ${message}`)
const post = (
  port: PreviewPort,
  id: number,
  kind: string,
  fields: Record<string, unknown> = {},
  transfer: Transferable[] = [],
) => port.postMessage({ protocol: PROTOCOL, id, kind, ...fields }, transfer)
const safeHeaders = (headers: Headers, cookies: boolean) =>
  [...headers].filter(([name]) => cookies || !["cookie", "set-cookie"].includes(name.toLowerCase()))

type Pending = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  cleanup: () => void
}

/** One isolated client per port. Cookies are omitted unless explicitly enabled for virtual origins. */
export function createPreviewClient(
  port: PreviewPort,
  options: {
    timeoutMs?: number
    cookies?: boolean
    allow?: (url: URL) => boolean
    exposeErrors?: boolean
  } = {},
) {
  const pending = new Map<number, Pending>()
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("timeout must be positive")
  let next = 1
  let closed = false
  const finish = (id: number, error?: Error) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.cleanup()
    if (error) {
      entry.reject(error)
      entry.controller?.error(error)
    } else entry.controller?.close()
  }
  const dispose = (reason = failure("connection closed (disconnected)")) => {
    if (closed) return
    closed = true
    try {
      post(port, 0, "disconnect")
    } catch {}
    for (const id of pending.keys()) finish(id, reason)
    port.removeEventListener("message", receive)
    port.removeEventListener("messageerror", broken)
    port.close()
  }
  const broken = () => dispose()
  const receive = (event: MessageEvent<unknown>) => {
    if (!envelope(event.data)) return
    const message = event.data
    if (message.kind === "disconnect") {
      dispose()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    try {
      if (message.kind === "error")
        finish(
          message.id,
          failure(
            options.exposeErrors && typeof message.error === "string"
              ? message.error
              : "remote request failed",
          ),
        )
      else if (message.kind === "end") finish(message.id)
      else if (message.kind === "chunk" && message.bytes instanceof ArrayBuffer) {
        entry.controller?.enqueue(new Uint8Array(message.bytes))
      } else if (message.kind === "response") {
        if (typeof message.status !== "number" || !Array.isArray(message.headers))
          throw failure("invalid response")
        const body =
          message.body === true
            ? new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    entry.controller = controller
                  },
                  pull() {
                    post(port, message.id, "pull")
                  },
                  cancel() {
                    post(port, message.id, "abort")
                    pending.delete(message.id)
                    entry.cleanup()
                  },
                },
                { highWaterMark: 0 },
              )
            : null
        const response = new Response(body, {
          status: message.status,
          statusText: typeof message.statusText === "string" ? message.statusText : "",
          headers: message.headers as [string, string][],
        })
        // Leave the port listener before user code can synchronously wait on body events.
        setTimeout(() => entry.resolve(response), 0)
        if (!body) finish(message.id)
      }
    } catch {
      finish(message.id, failure("invalid response"))
      post(port, message.id, "abort")
    }
  }
  port.addEventListener("message", receive)
  port.addEventListener("messageerror", broken)
  port.start()
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (closed) throw failure("connection closed")
    const request = new Request(input, init)
    if (options.allow && !options.allow(new URL(request.url))) throw failure("target refused")
    request.signal.throwIfAborted()
    const body = request.body ? await request.arrayBuffer() : undefined
    request.signal.throwIfAborted()
    if (closed) throw failure("connection closed")
    const id = next++
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        post(port, id, "abort")
        finish(id, failure("request aborted"))
      }
      const timer = setTimeout(() => {
        post(port, id, "abort")
        finish(id, failure("request deadline exceeded"))
      }, timeoutMs)
      pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          request.signal.removeEventListener("abort", abort)
        },
      })
      request.signal.addEventListener("abort", abort, { once: true })
      try {
        post(
          port,
          id,
          "request",
          {
            url: request.url,
            method: request.method,
            headers: safeHeaders(request.headers, options.cookies === true),
            body,
          },
          body ? [body] : [],
        )
      } catch {
        finish(id, failure("could not send request"))
      }
    })
  }
  return {
    fetch,
    dispose,
    get pending() {
      return pending.size
    },
  }
}

/** Responses are pulled one chunk at a time; a slow client does not cause an unbounded message queue. */
export function servePreviewPort(
  port: PreviewPort,
  fetch: PreviewFetch,
  options: {
    cookies?: boolean
    allow?: (url: URL) => boolean
    maxRequests?: number
    onClose?: () => void
    exposeErrors?: boolean
  } = {},
) {
  const active = new Map<
    number,
    { abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; reading: boolean }
  >()
  let closed = false
  const stop = (id: number) => {
    const entry = active.get(id)
    if (!entry) return
    active.delete(id)
    entry.abort.abort()
    void entry.reader?.cancel().catch(() => {})
  }
  const dispose = () => {
    if (closed) return
    closed = true
    try {
      post(port, 0, "disconnect")
    } catch {}
    for (const id of active.keys()) stop(id)
    port.removeEventListener("message", receive)
    port.removeEventListener("messageerror", broken)
    port.close()
    options.onClose?.()
  }
  const broken = () => dispose()
  const request = async (message: Envelope) => {
    if (active.has(message.id) || active.size >= (options.maxRequests ?? 128)) {
      post(port, message.id, "error")
      return
    }
    const abort = new AbortController()
    const entry: {
      abort: AbortController
      reader?: ReadableStreamDefaultReader<Uint8Array>
      reading: boolean
    } = { abort, reading: false }
    active.set(message.id, entry)
    try {
      if (
        typeof message.url !== "string" ||
        typeof message.method !== "string" ||
        !Array.isArray(message.headers)
      )
        throw failure("invalid request")
      const url = new URL(message.url)
      if (options.allow && !options.allow(url)) throw failure("target refused")
      const headers = new Headers(message.headers as [string, string][])
      if (!options.cookies) headers.delete("cookie")
      const input = new Request(url, {
        method: message.method,
        headers,
        body: message.body instanceof ArrayBuffer ? message.body : null,
        signal: abort.signal,
        redirect: "manual",
        credentials: "omit",
      })
      const response = await fetch(input)
      if (!active.has(message.id)) {
        await response.body?.cancel()
        return
      }
      if (response.body) entry.reader = response.body.getReader()
      post(port, message.id, "response", {
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders(response.headers, options.cookies === true),
        body: !!entry.reader,
      })
      if (!entry.reader) active.delete(message.id)
    } catch (error) {
      stop(message.id)
      if (!closed)
        post(
          port,
          message.id,
          "error",
          options.exposeErrors
            ? { error: error instanceof Error ? error.message : String(error) }
            : {},
        )
    }
  }
  const pull = async (id: number) => {
    const entry = active.get(id)
    if (!entry?.reader || entry.reading) return
    entry.reading = true
    try {
      const chunk = await entry.reader.read()
      if (!active.has(id)) return
      if (chunk.done) {
        active.delete(id)
        entry.reader.releaseLock()
        post(port, id, "end")
      } else {
        const bytes = new Uint8Array(chunk.value).buffer
        post(port, id, "chunk", { bytes }, [bytes])
      }
    } catch (error) {
      stop(id)
      if (!closed)
        post(
          port,
          id,
          "error",
          options.exposeErrors
            ? { error: error instanceof Error ? error.message : String(error) }
            : {},
        )
    } finally {
      entry.reading = false
    }
  }
  const receive = (event: MessageEvent<unknown>) => {
    if (!envelope(event.data)) return
    const message = event.data
    if (message.kind === "disconnect") dispose()
    else if (message.kind === "request") void request(message)
    else if (message.kind === "abort") stop(message.id)
    else if (message.kind === "pull") void pull(message.id)
  }
  port.addEventListener("message", receive)
  port.addEventListener("messageerror", broken)
  port.start()
  return {
    dispose,
    get active() {
      return active.size
    },
  }
}
