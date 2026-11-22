import type { SignalPeer } from "./browser.js"

/** WebSocket-shaped in-page transport. The caller decides which origin uses this fixture. */
type SignalServer = { accept(peer: SignalPeer): Promise<void> }
export class BrowserSignalSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: BinaryType = "blob"
  readonly protocol = ""
  readonly extensions = ""
  bufferedAmount = 0
  readonly url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private readonly messages = new Set<(bytes: Uint8Array) => void>()
  private readonly closed = new Set<() => void>()
  private queued = Promise.resolve()
  constructor(server: SignalServer, url: string | URL) {
    super()
    this.url = String(url)
    const peer: SignalPeer = {
      url: new URL(url),
      accept: () => {
        if (this.readyState !== 0) return
        this.readyState = 1
        const event = new Event("open")
        this.onopen?.(event)
        this.dispatchEvent(event)
      },
      refuse: () => {
        const event = new Event("error")
        this.onerror?.(event)
        this.dispatchEvent(event)
        this.close(1006, "Refused")
      },
      deliver: (bytes) => {
        if (this.readyState !== 1) return
        const data = bytes.slice()
        const event = new MessageEvent("message", {
          data: this.binaryType === "arraybuffer" ? data.buffer : new Blob([data]),
        })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      },
      close: (code, reason) => this.close(code, reason),
      drop: () => this.close(1006, "Signal connection lost"),
      onMessage: (listener) => {
        this.messages.add(listener)
      },
      onClose: (listener) => {
        if (this.readyState === 3) listener()
        else this.closed.add(listener)
      },
    }
    queueMicrotask(() => {
      void server.accept(peer).catch(() => peer.refuse())
    })
  }
  send(data: string | Blob | ArrayBufferLike | ArrayBufferView) {
    if (this.readyState === 0)
      throw new DOMException("WebSocket is connecting", "InvalidStateError")
    if (this.readyState !== 1) return
    this.queued = this.queued
      .then(async () => {
        const bytes =
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data)
        if (this.readyState === 1) for (const listener of this.messages) listener(bytes)
      })
      .catch(() => this.close(1011, "Message failed"))
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return
    this.readyState = 3
    for (const listener of this.closed) listener()
    this.closed.clear()
    this.messages.clear()
    const event = new CloseEvent("close", { code, reason, wasClean: code === 1000 })
    this.onclose?.(event)
    this.dispatchEvent(event)
  }
}

export function createSignalWebSocket(server: SignalServer): {
  new (url: string | URL): BrowserSignalSocket
} {
  return class extends BrowserSignalSocket {
    constructor(url: string | URL) {
      super(server, url)
    }
  }
}
