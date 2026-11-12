/**
 * The client connection a listener-free server accepts. The same shape is used by
 * `@crvouga/mockingbird-service-postgres/transport`, so one in-memory or worker transport serves both.
 *
 * No `node:` import here: this file is part of the browser-safe `/transport` entry.
 *
 * @module
 */

/**
 * One client connection as a pair of web byte streams: what a WebSocket bridge, a `MessagePort`
 * bridge, a Deno / Bun / Cloudflare socket or a unit test can hand over.
 */
export type ByteStreamPair = {
  /** Bytes from the client to the server. Its end (`done`) is the client hanging up. */
  readable: ReadableStream<Uint8Array>
  /** Bytes from the server to the client, written in the order the server produced them. */
  writable: WritableStream<Uint8Array>
}

/** The part of a Node `Duplex` (a `net.Socket`, a `tls.TLSSocket`, …) a server uses. */
export interface DuplexLike {
  on(event: string, listener: (...args: never[]) => void): unknown
  write(chunk: Uint8Array): unknown
  end(): unknown
  destroy(): unknown
}

/** One accepted client connection: web streams, or a Node `Duplex`. */
export type ClientStream = ByteStreamPair | DuplexLike

/** What a server sees of an accepted connection, whatever carried it. */
export interface StreamSocket {
  on(event: "data", listener: (chunk: Uint8Array) => void): void
  on(event: "close" | "error", listener: () => void): void
  write(chunk: Uint8Array): void
  /** Flush what was written, then close the connection. */
  end(): void
  /** Close the connection now, dropping anything not yet written. */
  destroy(): void
  readonly destroyed: boolean
  /** Resolves once the connection is closed, from either side. */
  readonly closed: Promise<void>
}

const isDuplex = (stream: ClientStream): stream is DuplexLike =>
  typeof (stream as { on?: unknown }).on === "function"

/** Adapt an accepted connection to the socket a server reads and writes. */
export const toSocket = (stream: ClientStream): StreamSocket =>
  isDuplex(stream) ? fromDuplex(stream) : fromWebStreams(stream)

const fromDuplex = (duplex: DuplexLike): StreamSocket => {
  let destroyed = false
  let markClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const settle = () => {
    destroyed = true
    markClosed()
  }
  duplex.on("close", settle)
  return {
    on: (event: string, listener: (chunk: Uint8Array) => void) => {
      duplex.on(event, listener as (...args: never[]) => void)
    },
    write: (chunk) => {
      if (!destroyed) duplex.write(chunk)
    },
    end: () => {
      duplex.end()
    },
    destroy: () => {
      destroyed = true
      duplex.destroy()
    },
    get destroyed() {
      return destroyed || (duplex as { destroyed?: boolean }).destroyed === true
    },
    closed,
  }
}

/**
 * Web streams in the shape of a socket. Reads are delivered as they arrive, writes are queued on
 * the writer so they reach the client in the order they were made, and the client ending its
 * `readable` closes the connection the way a TCP FIN does (Node's default `allowHalfOpen: false`).
 */
const fromWebStreams = ({ readable, writable }: ByteStreamPair): StreamSocket => {
  const reader = readable.getReader()
  const writer = writable.getWriter()
  const data: Array<(chunk: Uint8Array) => void> = []
  const gone: Array<() => void> = []
  let destroyed = false
  let ending = false
  let markClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const close = () => {
    if (destroyed) return
    destroyed = true
    reader.cancel().catch(() => undefined)
    markClosed()
    for (const listener of gone) listener()
  }
  const end = () => {
    if (destroyed || ending) return
    ending = true
    // `close()` is queued behind every pending write, so the last reply is delivered first.
    writer.close().then(close, close)
  }
  const destroy = () => {
    if (destroyed) return
    writer.abort().catch(() => undefined)
    close()
  }
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || destroyed) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike)
        for (const listener of data) listener(chunk)
      }
    } catch {
      destroy()
      return
    }
    end()
  })()
  return {
    on: (event: string, listener: (chunk: Uint8Array) => void) => {
      if (event === "data") data.push(listener)
      // A web stream failing is the connection closing; it has no separate "error" event.
      else if (event === "close") gone.push(listener as () => void)
    },
    write: (chunk) => {
      if (destroyed || ending) return
      writer.write(chunk).catch(destroy)
    },
    end,
    destroy,
    get destroyed() {
      return destroyed
    },
    closed,
  }
}
