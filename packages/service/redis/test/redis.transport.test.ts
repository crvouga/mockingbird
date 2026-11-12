import { afterEach, describe, expect, test } from "bun:test"
import { Duplex, duplexPair } from "node:stream"
import { build } from "esbuild"
import { Redis as IORedis } from "ioredis"
import { createRedis, type Redis } from "../src/index.ts"
import { RespParser } from "../src/protocol.ts"
import { createRespServer, type RespServer } from "../src/transport.ts"

// Real ioredis over in-memory byte streams: no port, no node:net. The server side gets web
// streams (the browser / worker shape); ioredis gets a Duplex through its `Connector` option.

/** A client Duplex over a pair of web streams, with the socket methods ioredis calls. */
class MemorySocket extends Duplex {
  readonly connecting = false
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>

  constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    super()
    this.writer = writable.getWriter()
    void (async () => {
      const reader = readable.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.push(Buffer.from(value))
      }
      this.push(null)
    })().catch((error) => this.destroy(error))
  }

  setNoDelay(): this {
    return this
  }
  setKeepAlive(): this {
    return this
  }
  setTimeout(): this {
    return this
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.writer.write(new Uint8Array(chunk)).then(() => done(), done)
  }
  override _final(done: (error?: Error | null) => void): void {
    this.writer.close().then(() => done(), done)
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.writer.abort().catch(() => undefined)
    done(error)
  }
}

let redis: Redis
let server: RespServer
const accepted: Promise<void>[] = []
const clients: IORedis[] = []

/** One in-memory connection: the server's web-stream side is accepted, the client side returned. */
const open = (): { client: MemorySocket; closed: Promise<void> } => {
  const toServer = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const closed = server.accept({ readable: toServer.readable, writable: toClient.writable })
  accepted.push(closed)
  return { client: new MemorySocket(toClient.readable, toServer.writable), closed }
}

/** An ioredis client whose every connection is an in-memory stream accepted by `server`. */
const connect = async (): Promise<{ client: IORedis; closed: () => Promise<void> }> => {
  let last: Promise<void> = Promise.resolve()
  class MemoryConnector {
    connecting = false
    stream: MemorySocket | undefined
    check() {
      return true
    }
    async connect() {
      this.connecting = true
      const { client, closed } = open()
      last = closed
      this.stream = client
      return client
    }
    disconnect() {
      this.connecting = false
      this.stream?.end()
    }
  }
  const client = new IORedis({
    Connector: MemoryConnector as never,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  })
  client.on("error", () => undefined)
  clients.push(client)
  await client.connect()
  return { client, closed: () => last }
}

const fresh = () => {
  redis = createRedis()
  server = createRespServer(redis)
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  await server?.close()
  await Promise.all(accepted.splice(0))
})

describe("createRespServer over injected web streams", () => {
  test("a raw RESP exchange: pipelined commands answer in order", async () => {
    fresh()
    const toServer = new TransformStream<Uint8Array, Uint8Array>()
    const toClient = new TransformStream<Uint8Array, Uint8Array>()
    const closed = server.accept({ readable: toServer.readable, writable: toClient.writable })
    const writer = toServer.writable.getWriter()
    const reader = toClient.readable.getReader()
    const parser = new RespParser()
    const command = (...args: string[]) =>
      `*${args.length}\r\n${args.map((arg) => `$${arg.length}\r\n${arg}\r\n`).join("")}`
    await writer.write(
      new TextEncoder().encode(command("PING") + command("SET", "k", "v") + command("GET", "k")),
    )
    const replies: unknown[] = []
    while (replies.length < 3) {
      const { value } = await reader.read()
      if (value) replies.push(...parser.push(value))
    }
    expect(replies).toEqual([
      { t: "simple", v: "PONG" },
      { t: "simple", v: "OK" },
      expect.objectContaining({ t: "bulk" }),
    ])
    expect(new TextDecoder().decode((replies[2] as { v: Uint8Array }).v)).toBe("v")
    await writer.write(new TextEncoder().encode(command("QUIT")))
    const quit: unknown[] = []
    while (quit.length < 1) {
      const { value } = await reader.read()
      if (value) quit.push(...parser.push(value))
    }
    expect(quit).toEqual([{ t: "simple", v: "OK" }])
    // The server ends its side after the reply, and accept() resolves.
    expect((await reader.read()).done).toBe(true)
    await closed
    expect(server.connections).toBe(0)
  })

  test("ioredis runs commands through a custom Connector", async () => {
    fresh()
    const { client } = await connect()
    expect(await client.ping()).toBe("PONG")
    await client.set("greeting", "hello")
    expect(await client.get("greeting")).toBe("hello")
    expect(server.connections).toBe(1)
  })

  test("a BLPOP on one stream is woken by an LPUSH on another", async () => {
    fresh()
    const a = await connect()
    const b = await connect()
    const popped = a.client.blpop("jobs", 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(redis.waiterCount()).toBe(1)
    await b.client.lpush("jobs", "job-1")
    expect(await popped).toEqual(["jobs", "job-1"])
  })

  test("SUBSCRIBE on one stream receives PUBLISH from another", async () => {
    fresh()
    const a = await connect()
    const b = await connect()
    const message = new Promise<[string, string]>((resolve) =>
      a.client.on("message", (channel, payload) => resolve([channel, payload])),
    )
    await a.client.subscribe("news")
    expect(await b.client.publish("news", "hi")).toBe(1)
    expect(await message).toEqual(["news", "hi"])
  })

  test("closing a stream releases its waiters, MULTI state, subscriptions and registration", async () => {
    fresh()
    const a = await connect()
    const b = await connect()
    const blocked = await connect()
    const multi = await connect()
    await b.client.subscribe("news")
    void blocked.client.blpop("never", 0).catch(() => undefined)
    await multi.client.call("MULTI")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(redis.waiterCount()).toBe(1)
    expect(redis.connections()).toBe(4)
    for (const gone of [b, blocked, multi]) gone.client.disconnect()
    await Promise.all([b.closed(), blocked.closed(), multi.closed()])
    expect(redis.waiterCount()).toBe(0)
    expect(redis.connections()).toBe(1)
    expect(await a.client.publish("news", "anyone?")).toBe(0)
    expect(server.connections).toBe(1)
  })

  test("admit() refusing a connection closes it before it is served", async () => {
    redis = createRedis()
    server = createRespServer(redis, { admit: () => false })
    const { closed } = open()
    await closed
    expect(server.connections).toBe(0)
    expect(redis.connections()).toBe(0)
  })
})

describe("createRespServer over a Node Duplex", () => {
  test("accept() takes a Duplex as net.createServer hands one over", async () => {
    fresh()
    const [serverSide, clientSide] = duplexPair()
    accepted.push(server.accept(serverSide))
    const client = new IORedis({
      Connector: class {
        connecting = false
        check() {
          return true
        }
        async connect() {
          return Object.assign(clientSide, {
            connecting: false,
            setNoDelay: () => clientSide,
            setKeepAlive: () => clientSide,
            setTimeout: () => clientSide,
          })
        }
        disconnect() {
          clientSide.end()
        }
      } as never,
      lazyConnect: true,
      retryStrategy: () => null,
    })
    client.on("error", () => undefined)
    clients.push(client)
    await client.connect()
    expect(await client.incr("n")).toBe(1)
  })
})

describe("the /transport entry", () => {
  test("bundles for the browser: no node: built-in is reached", async () => {
    const result = await build({
      entryPoints: [new URL("../src/transport.ts", import.meta.url).pathname],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
      metafile: true,
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter((path) => path.startsWith("node:"))).toEqual([])
    expect(result.outputFiles[0]?.text).not.toMatch(/\bBuffer\.|["']node:/)
  })
})
