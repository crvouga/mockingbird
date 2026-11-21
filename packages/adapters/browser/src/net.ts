import { EventEmitter } from "node:events"
import { Duplex } from "node:stream"

const hosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])
type Address = { port?: number; host?: string | undefined; allowHalfOpen?: boolean }
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

export type VirtualSocket = Duplex & {
  connecting: boolean
  remoteAddress: string
  remotePort: number
  localAddress: string
  localPort: number
  bytesRead: number
  bytesWritten: number
  connect(...args: unknown[]): VirtualSocket
  setNoDelay(): VirtualSocket
  setKeepAlive(): VirtualSocket
  setTimeout(ms: number, callback?: () => void): VirtualSocket
  ref(): VirtualSocket
  unref(): VirtualSocket
  address(): { address: string; family: string; port: number }
  readonly readyState: string
}
export type VirtualServer = EventEmitter & {
  listening: boolean
  listen(...args: unknown[]): VirtualServer
  address(): { address: string; family: string; port: number } | null
  close(callback?: (error?: Error) => void): VirtualServer
  ref(): VirtualServer
  unref(): VirtualServer
  getConnections(callback: (error: Error | null, count: number) => void): void
}
export type VirtualNetwork = {
  Socket: new (options?: Address) => VirtualSocket
  Server: new (...args: unknown[]) => VirtualServer
  createServer(listener?: (socket: VirtualSocket) => void): VirtualServer
  connect(...args: unknown[]): VirtualSocket
  createConnection(...args: unknown[]): VirtualSocket
  isIPv4(value: string): boolean
  isIPv6(value: string): boolean
  isIP(value: string): number
  hasListener(port: number): boolean
  dispose(): void
}

/** A world-local byte transport. No operation opens an operating-system socket. */
export function createVirtualNetwork(
  networkOptions: { isPortReserved?: (port: number) => boolean } = {},
): VirtualNetwork {
  const listeners = new Map<number, Server>()
  const sockets = new Set<Socket>()
  let nextPort = 40000
  let disposed = false
  const port = (value: number, ephemeral = false) => {
    if (!Number.isInteger(value) || value < 0 || value > 65535 || (!ephemeral && value === 0))
      throw new RangeError("Invalid virtual TCP port")
    if (value) return value
    for (let count = 0; count < 25536; count++) {
      const candidate = nextPort++
      if (nextPort > 65535) nextPort = 40000
      if (!listeners.has(candidate) && !networkOptions.isPortReserved?.(candidate)) return candidate
    }
    throw failure("EADDRINUSE", "No virtual TCP ports available")
  }
  class Socket extends Duplex {
    connecting = false
    remoteAddress = "127.0.0.1"
    remotePort = 0
    localAddress = "127.0.0.1"
    localPort = 0
    remoteFamily = "IPv4"
    pending = true
    bytesRead = 0
    bytesWritten = 0
    private peer: Socket | undefined
    private blocked: ((error?: Error | null) => void) | undefined
    private timeout?: ReturnType<typeof setTimeout>
    private timeoutMs = 0
    constructor(options: Address = {}) {
      super({ allowHalfOpen: options.allowHalfOpen ?? false, autoDestroy: true })
      sockets.add(this)
      this.once("close", () => sockets.delete(this))
    }
    connect(...args: unknown[]) {
      const first = args[0]
      const options: Address =
        typeof first === "object" && first !== null
          ? (first as Address)
          : { port: Number(first), host: typeof args[1] === "string" ? args[1] : undefined }
      const callback = args.find((arg): arg is () => void => typeof arg === "function")
      if (callback) this.once("connect", callback)
      if (this.connecting || this.peer) throw failure("EISCONN", "Socket is already connected")
      this.connecting = true
      queueMicrotask(() => {
        if (this.destroyed) return
        try {
          if (disposed) throw failure("ECONNREFUSED", "Virtual network is disposed")
          if (!hosts.has(options.host ?? "localhost"))
            throw failure("ENETUNREACH", "Only virtual loopback connections are supported")
          const destination = port(Number(options.port))
          const server = listeners.get(destination)
          if (!server) throw failure("ECONNREFUSED", `No virtual TCP server on port ${destination}`)
          const remote = new Socket({ allowHalfOpen: server.allowHalfOpen })
          this.peer = remote
          remote.peer = this
          this.remotePort = destination
          this.localPort = port(0, true)
          remote.localPort = destination
          remote.remotePort = this.localPort
          this.connecting = false
          this.pending = remote.pending = false
          server.attach(remote)
          this.touch()
          this.emit("connect")
          this.emit("ready")
        } catch (error) {
          this.connecting = false
          this.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      })
      return this
    }
    private touch() {
      if (this.timeout) clearTimeout(this.timeout)
      if (this.timeoutMs > 0) this.timeout = setTimeout(() => this.emit("timeout"), this.timeoutMs)
    }
    override _read() {
      const unblock = this.blocked
      this.blocked = undefined
      unblock?.()
    }
    override _write(
      chunk: Uint8Array,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) {
      if (this.connecting) {
        const ready = () => {
          this.off("close", closed)
          this._write(chunk, _encoding, callback)
        }
        const closed = () => {
          this.off("connect", ready)
          callback(failure("ECONNRESET", "Socket closed during connect"))
        }
        this.once("connect", ready)
        this.once("close", closed)
        return
      }
      const peer = this.peer
      if (!peer || peer.destroyed) return callback(failure("EPIPE", "Virtual socket is closed"))
      this.bytesWritten += chunk.byteLength
      peer.bytesRead += chunk.byteLength
      this.touch()
      peer.touch()
      if (peer.push(new Uint8Array(chunk))) callback()
      else peer.blocked = callback
    }
    override _final(callback: (error?: Error | null) => void) {
      this.peer?.push(null)
      callback()
    }
    override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      if (this.timeout) clearTimeout(this.timeout)
      const peer = this.peer
      this.peer = undefined
      const blocked = this.blocked
      this.blocked = undefined
      blocked?.(error ?? failure("ECONNRESET", "Virtual socket closed"))
      if (peer) {
        peer.peer = undefined
        if (!peer.destroyed) peer.destroy()
      }
      callback(error)
    }
    setNoDelay() {
      return this
    }
    setKeepAlive() {
      return this
    }
    setTimeout(ms: number, callback?: () => void) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError("Invalid timeout")
      if (callback) this.once("timeout", callback)
      this.timeoutMs = ms
      this.touch()
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
    address() {
      return { address: this.localAddress, family: "IPv4", port: this.localPort }
    }
    get readyState() {
      return this.connecting ? "opening" : this.destroyed ? "closed" : "open"
    }
  }
  class Server extends EventEmitter {
    listening = false
    allowHalfOpen = false
    private port = 0
    private connections = new Set<Socket>()
    constructor(...args: unknown[]) {
      super()
      const options = args[0]
      if (typeof options === "object" && options !== null)
        this.allowHalfOpen = (options as Address).allowHalfOpen ?? false
      const callback = args.find(
        (arg): arg is (socket: Socket) => void => typeof arg === "function",
      )
      if (callback) this.on("connection", callback)
    }
    attach(socket: Socket) {
      this.connections.add(socket)
      socket.once("close", () => this.connections.delete(socket))
      this.emit("connection", socket)
    }
    listen(...args: unknown[]) {
      if (disposed) throw failure("ERR_SERVER_NOT_RUNNING", "Virtual network is disposed")
      if (this.listening) throw failure("ERR_SERVER_ALREADY_LISTEN", "Server is already listening")
      const first = args[0]
      const options: Address =
        typeof first === "object" && first !== null
          ? (first as Address)
          : { port: Number(first ?? 0), host: typeof args[1] === "string" ? args[1] : undefined }
      if (!hosts.has(options.host ?? "localhost"))
        throw failure("EADDRNOTAVAIL", "Only loopback listeners are supported")
      this.port = port(options.port ?? 0, true)
      if (listeners.has(this.port) || networkOptions.isPortReserved?.(this.port))
        throw failure("EADDRINUSE", `Virtual TCP port ${this.port} is in use`)
      listeners.set(this.port, this)
      this.listening = true
      const callback = args.find((arg): arg is () => void => typeof arg === "function")
      if (callback) this.once("listening", callback)
      queueMicrotask(() => {
        if (this.listening) this.emit("listening")
      })
      return this
    }
    address() {
      return this.listening ? { address: "127.0.0.1", family: "IPv4", port: this.port } : null
    }
    close(callback?: (error?: Error) => void) {
      if (listeners.get(this.port) === this) listeners.delete(this.port)
      this.listening = false
      for (const socket of this.connections) socket.destroy()
      queueMicrotask(() => {
        this.emit("close")
        callback?.()
      })
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
    getConnections(callback: (error: Error | null, count: number) => void) {
      callback(null, this.connections.size)
    }
  }
  const connect = (...args: unknown[]) => new Socket().connect(...args)
  const isIPv4 = (value: string) =>
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 255 && (part === "0" || !part.startsWith("0")))
  const isIPv6 = (value: string) => {
    try {
      return new URL(`http://[${value}]/`).hostname.startsWith("[")
    } catch {
      return false
    }
  }
  return {
    Socket,
    Server,
    connect,
    createConnection: connect,
    createServer: (...args: unknown[]) => new Server(...args),
    isIPv4,
    isIPv6,
    isIP: (value: string) => (isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0),
    hasListener: (port: number) => listeners.has(port),
    dispose() {
      if (disposed) return
      disposed = true
      for (const server of listeners.values()) server.close()
      for (const socket of sockets) socket.destroy()
    },
  }
}
