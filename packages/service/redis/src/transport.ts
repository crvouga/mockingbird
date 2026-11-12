/**
 * The RESP server without a listener: it accepts client connections handed to it as byte
 * streams, so it runs in a browser, a (Shared)Worker, an edge runtime or a unit test with no
 * port. `serve()` from `/server` is this server behind `net.createServer`.
 *
 * Nothing here imports a `node:` built-in.
 *
 * @example
 * ```ts
 * import { createRedis } from "@crvouga/mockingbird-service-redis"
 * import { createRespServer } from "@crvouga/mockingbird-service-redis/transport"
 *
 * const server = createRespServer(createRedis())
 * const toServer = new TransformStream<Uint8Array, Uint8Array>()
 * const toClient = new TransformStream<Uint8Array, Uint8Array>()
 * void server.accept({ readable: toServer.readable, writable: toClient.writable })
 * // The client writes RESP to toServer.writable and reads replies from toClient.readable.
 * ```
 *
 * @module
 */
import type { Redis } from "./engine.ts"
import { encodeReply, err, type Reply, RequestParser } from "./protocol.ts"
import { type ClientStream, type StreamSocket, toSocket } from "./stream.ts"

export interface RespServerOptions {
  /** Called for each new connection; `false` closes it before it is served. */
  admit?: () => boolean
  /** Let the connection's session use test-control commands reserved for the host. */
  controlPrivileged?: boolean
  /** `close()` also closes the engine. Default `true`. */
  closeEngine?: boolean
}

export interface RespServer {
  /**
   * Serve one client connection: web streams (`{ readable, writable }`) or a Node `Duplex`.
   * Resolves when the connection closes, from either side; its blocking waiters, `MULTI` state,
   * subscriptions and `CLIENT` registration are then released as on a socket close.
   */
  accept(stream: ClientStream): Promise<void>
  /** Open connections right now. */
  readonly connections: number
  /** Close every connection (and the engine, unless `closeEngine: false`). */
  close(): Promise<void>
}

/** Create a RESP server over `redis` that accepts connections from {@link RespServer.accept}. */
export function createRespServer(redis: Redis, options: RespServerOptions = {}): RespServer {
  const sockets = new Set<StreamSocket>()
  let closed = false
  return {
    accept(stream) {
      const peer = stream as { localPort?: number; remoteAddress?: string; remotePort?: number }
      const socket = toSocket(stream)
      if (closed || (options.admit && !options.admit())) {
        socket.destroy()
        return socket.closed
      }
      sockets.add(socket)
      attach(redis, socket, peer, options.controlPrivileged ?? false)
      return socket.closed.then(() => {
        sockets.delete(socket)
      })
    },
    get connections() {
      return sockets.size
    },
    async close() {
      closed = true
      if (options.closeEngine !== false) redis.close()
      const open = [...sockets]
      for (const socket of open) socket.destroy()
      await Promise.all(open.map((socket) => socket.closed))
    },
  }
}

function attach(
  redis: Redis,
  socket: StreamSocket,
  peer: { localPort?: number; remoteAddress?: string; remotePort?: number },
  controlPrivileged: boolean,
): void {
  const session = redis.createSession()
  session.controlPrivileged = controlPrivileged
  if (peer.localPort !== undefined) session.localPort = peer.localPort
  if (peer.remoteAddress)
    session.remoteAddr = `${peer.remoteAddress.replace(/^::ffff:/, "")}:${peer.remotePort}`
  const parser = new RequestParser()
  // A protocol error is queued behind the commands before it, then closes the connection.
  const pending: Array<{ name: string; args: Uint8Array[] } | { fatal: string }> = []
  let pumping = false
  // Set once the connection is closing after its last reply (QUIT or a protocol error). Redis
  // stops reading input then, so nothing pipelined behind it may run.
  let closing = false
  const closeAfterReply = () => {
    closing = true
    pending.length = 0
    socket.end()
  }
  const write = (reply: Reply) => {
    if (!socket.destroyed && !closing) socket.write(encodeReply(reply, session.protocol))
  }
  session.onPush = write
  const stop = redis.onDisconnect((dropped) => {
    if (dropped === session) socket.destroy()
  })
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    redis.disconnect(session)
    stop()
  }
  socket.on("data", (chunk: Uint8Array) => {
    if (closing) return
    const { requests, error } = parser.push(chunk)
    pending.push(...requests)
    if (error !== null) pending.push({ fatal: error })
    void pump()
  })
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (pending.length > 0) {
        const command = pending.shift()
        if (!command) break
        if ("fatal" in command) {
          write(err(`ERR Protocol error: ${command.fatal}`))
          closeAfterReply()
          break
        }
        try {
          const reply = await redis.perform(session, command.name, command.args)
          write(reply)
          if (session.quit) {
            closeAfterReply()
            break
          }
        } catch {
          // A RedisConnectionError (the session was dropped) or an engine failure: either way the
          // connection cannot continue.
          socket.destroy()
          break
        }
      }
    } finally {
      pumping = false
      if (pending.length > 0 && !socket.destroyed) void pump()
    }
  }
  socket.on("close", finish)
  socket.on("error", finish)
}

export type { ByteStreamPair, ClientStream, DuplexLike } from "./stream.ts"
