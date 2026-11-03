/// <reference types="node" />
/**
 * Node and Bun transports for the broker: a TCP listener, MQTT over WebSocket on an existing
 * `node:http` server, and an in-process stream. The engine itself (`./index.js`) needs none of
 * this and stays portable.
 */
import { createHash } from "node:crypto"
import type { Server as HttpServer, IncomingMessage } from "node:http"
import { createServer, type Socket } from "node:net"
import { Duplex } from "node:stream"
import type { Broker, Connection, Transport, TransportInfo } from "./broker.js"
import { MAX_VARIABLE_BYTE_INTEGER } from "./codec.js"
import { MQTT_WEBSOCKET_PATH } from "./runtime.js"

/** Hand a new transport to a broker (`broker.connect`, or `routeConnection` for tenants). */
export type Attach = (transport: Transport, info: TransportInfo) => Connection

export type TcpListenOptions = {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type TcpListening = {
  host: string
  port: number
  /** `mqtt://host:port`. */
  url: string
  /** Stop listening and drop every connection. */
  close(): Promise<void>
}

const socketTransport = (socket: Socket, encode: (bytes: Uint8Array) => Uint8Array): Transport => ({
  send: (bytes) => {
    if (!socket.destroyed && socket.writable) socket.write(encode(bytes))
  },
  // Once the kernel has what was written, the socket can go: the peer reads it, then the end.
  close: () => {
    if (!socket.destroyed) socket.end(() => socket.destroy())
  },
  destroy: () => socket.destroy(),
})

/** Serve MQTT over TCP. */
export const listenTcp = (
  attach: Attach,
  options: TcpListenOptions = {},
): Promise<TcpListening> => {
  const host = options.host ?? "127.0.0.1"
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    const connection = attach(
      socketTransport(socket, (bytes) => bytes),
      { kind: "tcp" },
    )
    socket.on("data", (chunk: Uint8Array) => connection.receive(chunk))
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      sockets.delete(socket)
      connection.closed()
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject)
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const shown = host.includes(":") ? `[${host}]` : host
      resolve({
        host,
        port,
        url: `mqtt://${shown}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

// ── WebSocket (RFC 6455) ─────────────────────────────────────────────────────

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/**
 * The largest MQTT packet (a 256 MB Remaining Length plus its fixed header): the default cap on
 * one frame and on a whole reassembled message, so a hostile peer cannot grow either past it.
 */
const MAX_MESSAGE_BYTES = MAX_VARIABLE_BYTE_INTEGER + 5

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

const encodeFrame = (opcode: number, payload: Uint8Array): Uint8Array => {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** Why a frame parser gave up: a malformed frame, or a message above its cap. */
type FrameError = "protocol" | "too-big"

/** Splits a byte stream into WebSocket messages; control frames are reported as they come. */
const frameParser = (
  onFrame: (opcode: number, data: Buffer) => void,
  onError: (error: FrameError) => void,
  maxMessageBytes: number,
) => {
  let buffer: Buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  let fragmentOpcode = 0
  let failed = false
  const fail = (error: FrameError): void => {
    failed = true
    fragments = []
    buffer = Buffer.alloc(0)
    onError(error)
  }
  return (chunk: Buffer): void => {
    if (failed) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer[0] ?? 0
      const second = buffer[1] ?? 0
      // No extension is negotiated, so the reserved bits must be clear; a client must mask.
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) {
        fail("protocol")
        return
      }
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const wide = buffer.readBigUInt64BE(2)
        if (wide > BigInt(MAX_MESSAGE_BYTES)) {
          fail("too-big")
          return
        }
        length = Number(wide)
        offset = 10
      }
      // Checked from the header, before the frame is buffered: a message's fragments together
      // stay under the cap, not just each frame.
      if (opcode < 0x8) {
        const total = (opcode === OPCODE.continuation ? fragmentBytes : 0) + length
        if (total > maxMessageBytes) {
          fail("too-big")
          return
        }
      }
      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      const payload = Buffer.alloc(length)
      for (let index = 0; index < length; index++) {
        payload[index] = (buffer[offset + 4 + index] ?? 0) ^ (mask[index % 4] ?? 0)
      }
      buffer = buffer.subarray(offset + 4 + length)
      if (opcode >= 0x8) {
        onFrame(opcode, payload)
        continue
      }
      if (opcode === OPCODE.continuation) {
        if (fragmentOpcode === 0) {
          fail("protocol")
          return
        }
        fragments.push(payload)
        fragmentBytes += length
        if (fin) {
          const message = Buffer.concat(fragments)
          const type = fragmentOpcode
          fragments = []
          fragmentBytes = 0
          fragmentOpcode = 0
          onFrame(type, message)
        }
        continue
      }
      if (fin) onFrame(opcode, payload)
      else {
        fragmentOpcode = opcode
        fragments = [payload]
        fragmentBytes = length
      }
    }
  }
}

const refuse = (socket: Socket, status: number, reason: string): void => {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  )
}

export type WebSocketOptions = {
  /**
   * The broker side for an upgrade request to `pathname`, or `undefined` when that path does
   * not speak MQTT (the upgrade is answered 404).
   */
  route(pathname: string): Attach | undefined
  /** Subprotocols accepted. Default `["mqtt"]` (MQTT 5.0 section 6). */
  subprotocols?: readonly string[]
  /** Answer 400 to an upgrade offering none of them. Default `true`. */
  requireSubprotocol?: boolean
  /**
   * Largest message, all its fragments together, before the connection is closed with 1009
   * (RFC 6455 7.4.1). Default: the largest MQTT packet, 268,435,460 bytes.
   */
  maxMessageBytes?: number
}

export type WebSocketListening = {
  /** Stop accepting upgrades and drop every WebSocket connection. */
  close(): void
}

/** Serve MQTT over WebSocket on a `node:http` server's `upgrade` event. */
export const attachWebSocket = (
  server: HttpServer,
  options: WebSocketOptions,
): WebSocketListening => {
  const supported = options.subprotocols ?? ["mqtt"]
  const sockets = new Set<Socket>()
  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const attach = options.route(pathname)
    if (!attach) {
      refuse(socket, 404, "Not Found")
      return
    }
    const key = request.headers["sec-websocket-key"]
    if (typeof key !== "string" || key === "") {
      refuse(socket, 400, "Bad Request")
      return
    }
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((each) => each.trim())
      .filter(Boolean)
    const subprotocol = offered.find((each) => supported.includes(each))
    if (subprotocol === undefined && options.requireSubprotocol !== false) {
      refuse(socket, 400, "Bad Request")
      return
    }
    socket.setNoDelay(true)
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createHash("sha1")
          .update(key + WEBSOCKET_GUID)
          .digest("base64")}`,
        ...(subprotocol !== undefined ? [`Sec-WebSocket-Protocol: ${subprotocol}`] : []),
        "",
        "",
      ].join("\r\n"),
    )
    sockets.add(socket)
    const transport = socketTransport(socket, (bytes) => encodeFrame(OPCODE.binary, bytes))
    const connection = attach(
      {
        send: transport.send,
        close: () => {
          if (!socket.destroyed && socket.writable) {
            socket.write(encodeFrame(OPCODE.close, Uint8Array.of(0x03, 0xe8)))
          }
          transport.close()
        },
        destroy: transport.destroy,
      },
      { kind: "websocket", path: pathname },
    )
    const parse = frameParser(
      (opcode, data) => {
        if (opcode === OPCODE.binary) connection.receive(data)
        else if (opcode === OPCODE.ping) socket.write(encodeFrame(OPCODE.pong, data))
        else if (opcode === OPCODE.close) {
          if (socket.writable) socket.write(encodeFrame(OPCODE.close, data.subarray(0, 2)))
          socket.end(() => socket.destroy())
        }
        // MQTT 5.0 6.0: control packets travel in binary frames; a text frame ends the connection.
        else if (opcode === OPCODE.text) socket.destroy()
      },
      (error) => {
        if (error === "too-big" && socket.writable) {
          // 1009: the message is too big to process.
          socket.write(encodeFrame(OPCODE.close, Uint8Array.of(0x03, 0xf1)))
          socket.end(() => socket.destroy())
        } else socket.destroy()
      },
      Math.min(options.maxMessageBytes ?? MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES),
    )
    socket.on("data", (chunk: Buffer) => parse(chunk))
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      sockets.delete(socket)
      connection.closed()
    })
    if (head.length > 0) parse(head)
  }
  const listener = (request: IncomingMessage, socket: unknown, head: Buffer) =>
    onUpgrade(request, socket as Socket, head)
  server.on("upgrade", listener)
  return {
    close: () => {
      server.removeListener("upgrade", listener)
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

/**
 * An in-process connection as a Node stream, for a client library that takes one instead of a
 * URL (`new MqttClient(() => memoryStream(attach), options)` with `mqtt`). No socket is opened.
 */
export const memoryStream = (attach: Attach): Duplex => {
  let connection: Connection | undefined
  const stream = new Duplex({
    read() {},
    write(chunk: Uint8Array, _encoding, callback) {
      connection?.receive(chunk)
      callback()
    },
    final(callback) {
      connection?.closed()
      callback()
    },
    destroy(error, callback) {
      connection?.closed()
      callback(error)
    },
  })
  connection = attach(
    {
      send: (bytes) => {
        if (!stream.destroyed) stream.push(Buffer.from(bytes))
      },
      close: () => {
        if (!stream.destroyed) stream.push(null)
      },
      destroy: () => stream.destroy(),
    },
    { kind: "memory" },
  )
  return stream
}

/** What a service runtime exposes for its MQTT side; `serveMqtt` binds listeners to it. */
export type MqttRuntime = {
  attach(transport: Transport, info?: TransportInfo, namespace?: string): Connection
  webSocketPath(pathname: string): { namespace: string | undefined } | undefined
  /** Listener URLs, reported by the runtime's health route. */
  readonly endpoints: { mqtt?: string; websocket?: string }
  namespaces(): string[]
  instance(namespace?: string): { broker: Broker }
  /** Replaced by `serveMqtt` with one that also closes what it bound. */
  stop(): void
}

export type ServeMqttOptions = TcpListenOptions & {
  /**
   * How often (real ms) expiries are settled when nothing else touches the brokers. A suite
   * that moves the runtime clock needs none of it. Default 1000.
   */
  sweepMs?: number
  /** WebSocket subprotocols accepted. Default `["mqtt"]`. */
  subprotocols?: readonly string[]
}

export type MqttListening = {
  tcp: TcpListening
  /** Serve MQTT over WebSocket on a bound HTTP server; returns its `ws://…/mqtt` URL. */
  attachWebSocket(http: { server: HttpServer; url: string }): string
}

/**
 * Bind a runtime's MQTT listeners: TCP now, WebSocket once its HTTP server is up, and a timer
 * that settles expiries in real time. `runtime.stop()` then closes all of it and drops every
 * client, and so does closing the HTTP server.
 */
export const serveMqtt = async (
  runtime: MqttRuntime,
  options: ServeMqttOptions = {},
): Promise<MqttListening> => {
  const tcp = await listenTcp((transport, info) => runtime.attach(transport, info), options)
  runtime.endpoints.mqtt = tcp.url
  const timer = setInterval(() => {
    for (const name of runtime.namespaces()) runtime.instance(name).broker.sweep()
  }, options.sweepMs ?? 1000)
  timer.unref()
  const dropConnections = runtime.stop
  let webSocket: WebSocketListening | undefined
  runtime.stop = () => {
    clearInterval(timer)
    webSocket?.close()
    void tcp.close()
    dropConnections()
  }
  return {
    tcp,
    attachWebSocket: (http) => {
      // The HTTP server is what a supervisor closes (`serve` on SIGINT): MQTT goes with it.
      http.server.once("close", () => runtime.stop())
      webSocket = attachWebSocket(http.server, {
        ...(options.subprotocols ? { subprotocols: options.subprotocols } : {}),
        route: (pathname) => {
          const match = runtime.webSocketPath(pathname)
          if (!match) return undefined
          return (transport, info) => runtime.attach(transport, info, match.namespace)
        },
      })
      const url = `${http.url.replace(/^http/, "ws")}${MQTT_WEBSOCKET_PATH}`
      runtime.endpoints.websocket = url
      return url
    },
  }
}
