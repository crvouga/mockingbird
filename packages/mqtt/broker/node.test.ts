/**
 * The Node transports, driven with raw sockets and the package's own codec. The services'
 * SDK tests drive the same listeners with a real client library.
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { type AddressInfo, connect as connectSocket } from "node:net"
import { PassThrough } from "node:stream"
import { bootSqlite } from "@crvouga/mockingbird-service"
import {
  Broker,
  type BrokerPolicy,
  encodePacket,
  type Packet,
  PacketReader,
  ReasonCode,
} from "./src/index.js"
import { attachWebSocket, listenTcp, memoryStream } from "./src/node.js"

const policy: BrokerPolicy = {
  authenticate: () => ({ ok: true }),
  authorize: () => true,
  denyAction: () => "ignore",
  assignClientId: (token) => token,
  sessionExpiry: (requested) => requested,
  connackProperties: () => ({}),
  maxInflight: 32,
  queue: { storeQos0: false },
  pubackNoMatchingSubscribers: ReasonCode.Success,
  qos2Subscribe: "downgrade",
  multiLevelWildcardMatchesParent: true,
  connectionExpiredReason: ReasonCode.NotAuthorized,
}

const newBroker = () =>
  new Broker({ sqlite: bootSqlite(), namespace: "node", now: Date.now, policy })

const CONNECT = (clientId: string): Packet => ({
  type: "connect",
  protocolName: "MQTT",
  protocolVersion: 5,
  cleanStart: false,
  keepAlive: 0,
  properties: { sessionExpiryInterval: 60 },
  clientId,
})
const SUBSCRIBE: Packet = {
  type: "subscribe",
  packetId: 1,
  properties: {},
  subscriptions: [
    { topicFilter: "t", qos: 0, noLocal: false, retainAsPublished: false, retainHandling: 0 },
  ],
}

/** Collects decoded packets and resolves waiters as they arrive. */
const collector = () => {
  const reader = new PacketReader()
  const packets: Packet[] = []
  const waiting: { count: number; resolve: () => void }[] = []
  return {
    packets,
    push(bytes: Uint8Array) {
      packets.push(...reader.push(bytes).packets)
      for (const each of waiting.splice(0)) {
        if (packets.length >= each.count) each.resolve()
        else waiting.push(each)
      }
    },
    received: (count: number) =>
      packets.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push({ count, resolve })
          }),
  }
}

describe("listenTcp", () => {
  test("serves the broker on an OS-assigned port and closes its connections", async () => {
    const broker = newBroker()
    const tcp = await listenTcp((transport, info) => broker.connect(transport, info))
    expect(tcp.port).toBeGreaterThan(0)
    expect(tcp.url).toBe(`mqtt://127.0.0.1:${tcp.port}`)

    const inbox = collector()
    const socket = connectSocket({ host: tcp.host, port: tcp.port })
    socket.on("data", (chunk) => inbox.push(chunk))
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    // Two packets in one write, then one split across two writes.
    const subscribe = encodePacket(SUBSCRIBE)
    socket.write(Buffer.concat([encodePacket(CONNECT("tcp")), subscribe.subarray(0, 3)]))
    socket.write(subscribe.subarray(3))
    await inbox.received(2)
    expect(inbox.packets.map((packet) => packet.type)).toEqual(["connack", "suback"])
    expect(broker.clients()).toMatchObject([{ clientId: "tcp", connected: true, transport: "tcp" }])

    broker.publish({ topic: "t", payload: Uint8Array.of(1, 2, 3), qos: 1 })
    await inbox.received(3)
    expect(inbox.packets[2]).toMatchObject({ type: "publish", topic: "t", qos: 0 })

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    await tcp.close()
    await closed
    // The session outlives the socket the listener dropped.
    expect(broker.clients()).toMatchObject([{ clientId: "tcp", connected: false }])
    await new Promise<void>((resolve) => {
      connectSocket({ host: tcp.host, port: tcp.port }).once("error", () => resolve())
    })
  })

  test("a DISCONNECT the broker sends is flushed before the socket ends", async () => {
    const broker = newBroker()
    const tcp = await listenTcp((transport, info) => broker.connect(transport, info))
    try {
      const inbox = collector()
      const socket = connectSocket({ host: tcp.host, port: tcp.port })
      socket.on("data", (chunk) => inbox.push(chunk))
      const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()))
      socket.write(encodePacket(CONNECT("kicked")))
      await inbox.received(1)
      expect(broker.kick("kicked")).toBe(true)
      await ended
      expect(inbox.packets[1]).toEqual({
        type: "disconnect",
        reasonCode: ReasonCode.AdministrativeAction,
        properties: {},
      })
    } finally {
      await tcp.close()
    }
  })
})

describe("attachWebSocket", () => {
  test("serves MQTT in binary frames on the routed path and negotiates the subprotocol", async () => {
    const broker = newBroker()
    const http = createHttpServer((_request, response) => response.end("plain http"))
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
    const { port } = http.address() as AddressInfo
    const webSocket = attachWebSocket(http, {
      route: (pathname) =>
        pathname === "/mqtt" ? (transport, info) => broker.connect(transport, info) : undefined,
    })
    try {
      const inbox = collector()
      const socket = new WebSocket(`ws://127.0.0.1:${port}/mqtt`, ["mqtt"])
      socket.binaryType = "arraybuffer"
      socket.onmessage = (message) => inbox.push(new Uint8Array(message.data as ArrayBuffer))
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error("websocket failed"))
      })
      expect(socket.protocol).toBe("mqtt")
      socket.send(encodePacket(CONNECT("ws")))
      socket.send(encodePacket(SUBSCRIBE))
      await inbox.received(2)
      expect(broker.clients()).toMatchObject([
        { clientId: "ws", connected: true, transport: "websocket" },
      ])
      // A payload long enough for the 16-bit and the 64-bit frame length forms.
      for (const size of [200, 70_000]) {
        broker.publish({ topic: "t", payload: new Uint8Array(size).fill(7), qos: 0 })
      }
      await inbox.received(4)
      expect(
        inbox.packets
          .slice(2)
          .map((packet) => (packet.type === "publish" ? packet.payload.length : 0)),
      ).toEqual([200, 70_000])
      socket.send(
        encodePacket({
          type: "publish",
          topic: "echo",
          payload: new Uint8Array(70_000),
          qos: 0,
          retain: false,
          dup: false,
          properties: {},
        }),
      )
      socket.send(encodePacket({ type: "pingreq" }))
      await inbox.received(5)
      expect(inbox.packets[4]).toEqual({ type: "pingresp" })
      expect(broker.publishLog().at(-1)).toMatchObject({ topic: "echo", bytes: 70_000 })

      // The plain HTTP side of the same server is untouched.
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("plain http")

      const closed = new Promise<void>((resolve) => {
        socket.onclose = () => resolve()
      })
      webSocket.close()
      await closed
      expect(broker.clients()).toMatchObject([{ clientId: "ws", connected: false }])
    } finally {
      webSocket.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
  test("reassembles a large frame from many small chunks in linear time", () => {
    // A fake server and socket, so the parser sees exactly the chunks written here.
    const server = new EventEmitter()
    const socket = Object.assign(new PassThrough(), { setNoDelay: () => {} })
    let received = 0
    attachWebSocket(server as unknown as HttpServer, {
      route: () => () => ({
        receive: (chunk) => {
          received += chunk.length
        },
        closed: () => {},
      }),
    })
    server.emit(
      "upgrade",
      {
        url: "/mqtt",
        headers: {
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "mqtt",
        },
      },
      socket,
      Buffer.alloc(0),
    )
    // One 16 MB binary frame in 1 KB chunks: re-copying the buffered bytes on each chunk copies
    // ~128 GB and takes many seconds.
    const frame = Buffer.alloc(10 + 4 + 16 * 1024 * 1024)
    frame[0] = 0x82
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(16 * 1024 * 1024), 2)
    const started = performance.now()
    for (let offset = 0; offset < frame.length; offset += 1024) {
      socket.emit("data", frame.subarray(offset, offset + 1024))
    }
    const elapsed = performance.now() - started
    socket.destroy()
    expect(received).toBe(16 * 1024 * 1024)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe("memoryStream", () => {
  test("is a duplex over one in-process connection", async () => {
    const broker = newBroker()
    const stream = memoryStream((transport, info) => broker.connect(transport, info))
    const inbox = collector()
    stream.on("data", (chunk: Uint8Array) => inbox.push(chunk))
    stream.write(encodePacket(CONNECT("memory")))
    stream.write(encodePacket(SUBSCRIBE))
    await inbox.received(2)
    expect(broker.clients()).toMatchObject([
      { clientId: "memory", connected: true, transport: "memory" },
    ])
    const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()))
    broker.disconnect("memory", ReasonCode.ServerShuttingDown)
    await ended
    expect(inbox.packets.at(-1)).toMatchObject({
      type: "disconnect",
      reasonCode: ReasonCode.ServerShuttingDown,
    })
    stream.destroy()
    expect(broker.connections).toBe(0)
  })
})
