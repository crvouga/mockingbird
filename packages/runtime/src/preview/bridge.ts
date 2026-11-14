import type { FetchHandler, WebFetch } from "./types.js"

/** MessagePort subset shared by browsers and node:worker_threads. */
export type PreviewPort = Pick<
  MessagePort,
  "postMessage" | "addEventListener" | "removeEventListener" | "start" | "close"
>
const protocol = "mockingbird-preview/1"
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One channel per request; response chunks are pulled, never buffered without bound. */
export function createPreviewClient(port: PreviewPort, options: { timeoutMs?: number } = {}) {
  const pending = new Set<(reason: Error) => void>()
  let disposed = false
  port.start()
  const fetch: WebFetch = async (input, init) => {
    if (disposed) throw new Error("Preview client disposed")
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    // Browser cookies are intentionally not inherited. Applications own cookie jars.
    const body = request.body ? await request.arrayBuffer() : undefined
    request.signal.throwIfAborted()
    if (disposed) throw new Error("Preview client disposed")
    return new Promise<Response>((resolve, reject) => {
      const channel = new MessageChannel()
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        pending.delete(fail)
        request.signal.removeEventListener("abort", abort)
        channel.port1.close()
        channel.port2.close()
      }
      const fail = (reason: Error) => {
        if (done) return
        channel.port1.postMessage({ type: "cancel", error: reason.message })
        stream?.error(reason)
        reject(reason)
        finish()
      }
      const abort = () => fail(new Error(message(request.signal.reason)))
      const timer = setTimeout(
        () => fail(new Error("Preview request deadline exceeded")),
        options.timeoutMs ?? 30_000,
      )
      pending.add(fail)
      request.signal.addEventListener("abort", abort, { once: true })
      channel.port1.onmessage = ({ data }) => {
        if (done) return
        if (data.type === "headers") {
          try {
            const responseBody = data.body
              ? new ReadableStream<Uint8Array>(
                  {
                    start(controller) {
                      stream = controller
                    },
                    pull() {
                      channel.port1.postMessage({ type: "pull" })
                    },
                    cancel(reason) {
                      fail(new Error(message(reason ?? "Response cancelled")))
                    },
                  },
                  { highWaterMark: 0 },
                )
              : null
            resolve(
              new Response(responseBody, {
                status: data.status,
                statusText: data.statusText,
                headers: data.headers,
              }),
            )
            if (!data.body) finish()
          } catch (error) {
            fail(new Error(message(error)))
          }
        } else if (data.type === "chunk") stream?.enqueue(new Uint8Array(data.bytes))
        else if (data.type === "end") {
          stream?.close()
          finish()
        } else if (data.type === "error") fail(new Error(data.error))
      }
      channel.port1.onmessageerror = () => fail(new Error("Invalid preview response"))
      try {
        port.postMessage(
          {
            protocol,
            type: "fetch",
            url: request.url,
            method: request.method,
            headers: [...request.headers],
            body,
            port: channel.port2,
          },
          body ? [channel.port2, body] : [channel.port2],
        )
      } catch (error) {
        fail(new Error(message(error)))
      }
    })
  }
  return {
    fetch,
    dispose(reason = new Error("Preview client disposed")) {
      if (disposed) return
      disposed = true
      for (const fail of pending) fail(reason)
      port.postMessage({ protocol, type: "disconnect" })
      port.close()
    },
  }
}

/** Attach each dedicated-worker or SharedWorker client port to the same handler. */
export function attachPreviewHost(
  port: PreviewPort,
  fetch: FetchHandler,
  options: { onDisconnect?: () => void } = {},
) {
  let disposed = false
  const active = new Set<() => void>()
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (data?.protocol !== protocol) return
    if (data.type === "disconnect") {
      dispose()
      return
    }
    if (data.type !== "fetch" || !data.port) return
    const reply = data.port as MessagePort
    const abort = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let ended = false
    const stop = (cancel = true) => {
      if (ended) return
      ended = true
      if (cancel) {
        reply.postMessage({ type: "error", error: "Preview request disconnected" })
        abort.abort(new Error("Preview request disconnected"))
        void reader?.cancel().catch(() => undefined)
      } else reader?.releaseLock()
      active.delete(stop)
      reply.close()
    }
    active.add(stop)
    const fail = (error: unknown) => {
      if (!ended) reply.postMessage({ type: "error", error: message(error) })
      stop()
    }
    reply.onmessage = ({ data: command }) => {
      if (command.type === "cancel") stop()
      if (command.type === "pull" && reader && !ended) {
        void reader.read().then(({ done, value }) => {
          if (ended) return
          if (done) {
            reply.postMessage({ type: "end" })
            stop(false)
          } else {
            const bytes = new Uint8Array(value).buffer
            reply.postMessage({ type: "chunk", bytes }, [bytes])
          }
        }, fail)
      }
    }
    reply.onmessageerror = () => fail(new Error("Invalid preview request"))
    void Promise.resolve()
      .then(() =>
        fetch(
          new Request(data.url, {
            method: data.method,
            headers: data.headers,
            ...(data.body ? { body: data.body } : {}),
            signal: abort.signal,
            redirect: "manual",
            credentials: "omit",
          }),
        ),
      )
      .then(async (response) => {
        if (ended) {
          await response.body?.cancel()
          return
        }
        reader = response.body?.getReader()
        reply.postMessage({
          type: "headers",
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body: !!reader,
        })
        if (!reader) stop(false)
      })
      .catch(fail)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    port.removeEventListener("message", receive as EventListener)
    for (const stop of active) stop()
    port.close()
    options.onDisconnect?.()
  }
  port.addEventListener("message", receive as EventListener)
  port.start()
  return { dispose }
}
