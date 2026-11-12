import { createConnection, createServer } from "node:net"
import type { ConfigService, FleetChild } from "@crvouga/mockingbird-adapter-node"
import {
  matchNamespacePath,
  normalizeBootControls,
  resolveAdminPrefix,
} from "@crvouga/mockingbird-service"
import { createRedis, type Redis } from "./engine.ts"
import { RespParser } from "./protocol.ts"
import { createRespServer, type RespServerOptions } from "./transport.ts"

export {
  type ByteStreamPair,
  type ClientStream,
  createRespServer,
  type DuplexLike,
  type RespServer,
  type RespServerOptions,
} from "./transport.ts"

/** HTTP port for `serve --config`. The RESP socket binds an ephemeral port. */
export const DEFAULT_PORT = 8827

export interface ServeOptions extends RespServerOptions {
  port?: number
  host?: string
}

export interface RedisListening {
  readonly listening: boolean
  host: string
  port: number
  close(): Promise<void>
}

/**
 * Listen for RESP clients over TCP. Each socket is handed to a {@link createRespServer} server;
 * where no listener can run, use that server from `/transport` directly.
 */
export function serve(redis: Redis, options: ServeOptions = {}): Promise<RedisListening> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 6379
  const resp = createRespServer(redis, {
    ...(options.admit ? { admit: options.admit } : {}),
    controlPrivileged: options.controlPrivileged ?? false,
    closeEngine: options.closeEngine !== false,
  })
  const server = createServer({ keepAlive: true }, (socket) => {
    void resp.accept(socket)
  })
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error)
    server.once("error", fail)
    server.listen(port, host, () => {
      server.off("error", fail)
      const address = server.address()
      const actual = address && typeof address === "object" ? address.port : port
      resolve({
        get listening() {
          return server.listening
        },
        host,
        port: actual,
        close: async () => {
          const closing = resp.close()
          await new Promise<void>((done) => server.close(() => done()))
          await closing
        },
      })
    })
  })
}

type FleetRuntime = {
  fetch(request: Request): Promise<Response>
  respPort: number
  close(): Promise<void>
}

const isHealth = (pathname: string, adminPrefix: string): boolean => {
  const path = pathname.replace(/\/+$/, "") || "/"
  return (
    path === `${adminPrefix}/health` ||
    matchNamespacePath(path, adminPrefix)?.[2] === `${adminPrefix}/health`
  )
}

/**
 * Fleet entry for `serve --config`. HTTP `GET /__admin/health` reports `service: redis`.
 * RESP listens on an ephemeral port named in the startup banner.
 */
export const serveTarget = {
  name: "redis",
  protocol: "redis" as const,
  defaultPort: 6379,
  start: startProtocol,
  async create(
    _values: unknown = {},
    common: { adminPrefix?: string } = {},
  ): Promise<FleetRuntime> {
    const redis = createRedis()
    const tcp = await serve(redis, { host: "127.0.0.1", port: 0 })
    const runtime: FleetRuntime = {
      respPort: tcp.port,
      close: () => tcp.close(),
      fetch: async (request: Request) => {
        if (
          request.method === "GET" &&
          isHealth(new URL(request.url).pathname, resolveAdminPrefix(common.adminPrefix))
        ) {
          return Response.json({ status: "ok", service: "redis" })
        }
        return new Response("not found", { status: 404 })
      },
    }
    return runtime
  },
  banner(runtime: FleetRuntime) {
    return [`resp: redis://127.0.0.1:${runtime.respPort}`]
  },
}

/** Each fleet namespace owns a listener and an engine; Redis SELECT retains vendor semantics. */
async function startProtocol(entry: ConfigService): Promise<FleetChild> {
  const namespaces = new Map<string, { redis: Redis; listener: RedisListening; database: number }>()
  const selectors = { default: 0, ...entry.namespaces }
  if (
    entry.seed !== undefined &&
    (!String(entry.seed).trim() || !Number.isFinite(Number(entry.seed)))
  )
    throw new Error("Redis seed must be a finite number")
  let admission: ((namespace: string) => boolean) | undefined
  const boot = normalizeBootControls(entry.adminControls)
  const create = async (name: string, database: number, port = 0) => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("invalid Redis namespace")
    if (!Number.isInteger(database) || database < 0 || database > 15)
      throw new Error("invalid Redis database index")
    const redis = createRedis({
      ...(entry.password !== undefined ? { password: entry.password } : {}),
      ...(entry.seed !== undefined ? { seed: Number(entry.seed) } : {}),
    })
    const control = { ...boot.shared.clock, ...boot.namespaces[name]?.clock }
    if (control.frozen) redis.clock.freeze()
    if (control.now !== undefined) redis.clock.set(control.now)
    const listener = await serve(redis, {
      host: entry.host ?? "127.0.0.1",
      port,
      admit: () => admission?.(name) !== false,
    })
    namespaces.set(name, { redis, listener, database })
  }
  try {
    for (const [name, database] of Object.entries(selectors))
      await create(name, database as number, name === "default" ? (entry.port ?? 6379) : 0)
  } catch (error) {
    await Promise.allSettled([...namespaces.values()].map(({ listener }) => listener.close()))
    throw error
  }
  const get = (name: string) => {
    const found = namespaces.get(name)
    if (!found) throw new Error(`Redis namespace ${name} is not configured`)
    return found
  }
  const url = (name: string, privateUrl = false) => {
    const { listener, database } = get(name)
    const host = listener.host.includes(":") ? `[${listener.host}]` : listener.host
    const auth =
      privateUrl && entry.password !== undefined ? `:${encodeURIComponent(entry.password)}@` : ""
    return `redis://${auth}${host}:${listener.port}/${database}`
  }
  return {
    protocol: "redis",
    url: url("default"),
    connection: url("default", true),
    get connections() {
      return Object.fromEntries([...namespaces.keys()].map((name) => [name, url(name, true)]))
    },
    get namespaces() {
      return {
        mechanism: "endpoint",
        endpoints: Object.fromEntries([...namespaces.keys()].map((name) => [name, url(name)])),
      }
    },
    async createNamespace(name) {
      if (namespaces.has(name)) throw new Error("namespace already exists")
      await create(name, 0)
    },
    async deleteNamespace(name) {
      const { redis, listener } = get(name)
      if (
        redis.activeCommands() ||
        redis.waiterCount() ||
        redis.activeJobs() ||
        redis.connections()
      )
        throw new Error("Redis namespace has active clients or work")
      await listener.close()
      namespaces.delete(name)
    },
    async exportCheckpoint(name, point) {
      return get(name).redis.exportSnapshot(point)
    },
    async importCheckpoint(name, document) {
      return (namespaces.get(name) ?? get("default")).redis.importSnapshot(document)
    },
    async inspect(name, { offset, limit, collection }) {
      const { redis, database } = get(name)
      const keys = redis.inspect(database)
      return {
        total: keys.length,
        keys: keys
          .filter((key) => collection === undefined || key.key === collection)
          .slice(offset, offset + limit),
        pendingJobs: redis.pendingJobs(),
        activeJobs: redis.activeJobs(),
      }
    },
    async initializationAccess() {
      const listeners: RedisListening[] = []
      const connections: Record<string, string> = {}
      try {
        for (const [name, { redis, database }] of namespaces) {
          const seed = await serve(redis, {
            port: 0,
            host: "127.0.0.1",
            closeEngine: false,
            controlPrivileged: true,
          })
          listeners.push(seed)
          connections[name] =
            `redis://${entry.password ? `:${encodeURIComponent(entry.password)}@` : ""}127.0.0.1:${seed.port}/${database}`
        }
      } catch (error) {
        await Promise.allSettled(listeners.map((l) => l.close()))
        throw error
      }
      return {
        connections,
        close: async () => {
          await Promise.all(listeners.map((l) => l.close()))
        },
      }
    },
    setAdmission(allow) {
      admission = allow
    },
    async ready() {
      if (admission) return [...namespaces.values()].every(({ listener }) => listener.listening)
      const ready = (
        await Promise.all(
          [...namespaces.values()].map(({ listener, database }) =>
            probe(listener, database, entry.password),
          ),
        )
      ).every(Boolean)
      const deadline = Date.now() + 2000
      while (
        [...namespaces.values()].some(({ redis }) => redis.connections() > 0) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 1))
      return ready
    },
    async close() {
      await Promise.all([...namespaces.values()].map(({ listener }) => listener.close()))
    },
    lock: (name) => get(name).redis.fence(),
    diagnostics(name) {
      const { redis } = get(name)
      return {
        activeRequests: redis.activeCommands(),
        activeConnections: redis.connections(),
        blockedCommands: redis.waiterCount(),
        pendingJobs: redis.pendingJobs(),
        activeJobs: redis.activeJobs(),
        pendingWebhooks: 0,
        unmatchedRequests: 0,
      }
    },
    async checkpoint(name) {
      return get(name).redis.snapshot()
    },
    async restore(name, point) {
      get(name).redis.restore(point)
    },
    async reset(name) {
      const { redis } = get(name)
      redis.reset()
      const control = { ...boot.shared.clock, ...boot.namespaces[name]?.clock }
      if (control.frozen) redis.clock.freeze()
      if (control.now !== undefined) redis.clock.set(control.now)
    },
    nextEvent: (name) => get(name).redis.nextEvent(),
    async settle(name) {
      get(name).redis.settleTimers()
    },
    clock: (name) => get(name).redis.clock,
  }
}

/** Readiness checks the actual RESP listener, including configured authentication and SELECT. */
function probe(
  listener: RedisListening,
  database: number,
  password: string | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: listener.host, port: listener.port })
    const parser = new RespParser()
    const commands = [
      ...(password !== undefined ? [["AUTH", password]] : []),
      ["SELECT", String(database)],
      ["PING"],
    ]
    const expected = commands.map((command) => (command[0] === "PING" ? "PONG" : "OK"))
    let result = false
    const finish = (ok: boolean) => {
      result = ok
      socket.destroy()
    }
    const timeout = setTimeout(() => finish(false), 2000)
    socket.once("close", () => {
      clearTimeout(timeout)
      resolve(result)
    })
    socket.on("error", () => finish(false))
    socket.once("connect", () => {
      for (const command of commands)
        socket.write(
          `*${command.length}\r\n${command.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`,
        )
    })
    socket.on("data", (data) => {
      try {
        for (const reply of parser.push(data)) {
          if (reply.t !== "simple" || reply.v !== expected.shift()) {
            finish(false)
            return
          }
          if (expected.length === 0) {
            finish(true)
            return
          }
        }
      } catch {
        finish(false)
      }
    })
  })
}
