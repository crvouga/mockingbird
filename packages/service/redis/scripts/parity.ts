/**
 * Optional differential check against a real Redis or Valkey. The URL comes from the
 * environment (`.env.local` locally, the `REDIS_URL` repo secret in the parity workflow).
 * This script never prints that URL.
 */

import { connect, type Socket } from "node:net"
import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { createRedis } from "../src/index.ts"
import { asCommand, encodeReply, type Reply, RespParser } from "../src/protocol.ts"

const spec = { provider: "redis", fields: { REDIS_URL: "REDIS_URL" } }

let url: string
try {
  const credentials = await loadCredentials(spec, { env: process.env })
  url = credentials.values.REDIS_URL
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`redis parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}

/**
 * One command per entry, arguments split on spaces. Keys stay under `parity:` and are deleted at
 * the end. A leading `~` runs the command without comparing its reply (a reply that names the
 * server, such as `HELLO`). Replies after `HELLO 3` are compared as RESP3.
 */
const commands = [
  "PING",
  "SET parity 1",
  "GET parity",
  "INCR parity",
  "DEL parity",
  // #753: XREVRANGE argument order, the commands reported unknown, RESP3 sorted-set replies.
  "XADD parity:xs 1-1 a 1",
  "XADD parity:xs 1-2 a 2",
  "XADD parity:xs 2-0 a 3",
  "XREVRANGE parity:xs + -",
  "XREVRANGE parity:xs 2 1 COUNT 2",
  "XRANGE parity:xs (1-1 +",
  "XRANGE parity:xs abc +",
  "SET parity:s 1",
  "TOUCH parity:s parity:nokey",
  "LPUSHX parity:l x",
  "LPUSH parity:l a",
  "LPUSHX parity:l x y",
  "RPUSHX parity:l z",
  "LRANGE parity:l 0 -1",
  "SADD parity:s1 a b c",
  "SADD parity:s2 c d",
  "SUNIONSTORE parity:sd parity:s1 parity:s2",
  "SINTERSTORE parity:sd parity:s1 parity:s2",
  "SDIFFSTORE parity:sd parity:s1 parity:s2",
  "SMEMBERS parity:sd",
  "SINTERCARD 2 parity:s1 parity:s2",
  "ZADD parity:z1 1 a 2 b 3 c",
  "ZADD parity:z2 10 b 20 c 30 d",
  "ZINTERSTORE parity:zo 2 parity:z1 parity:z2 WEIGHTS 2 1 AGGREGATE MAX",
  "ZRANGE parity:zo 0 -1 WITHSCORES",
  "ZUNION 2 parity:z1 parity:z2 WITHSCORES",
  "ZDIFF 2 parity:z1 parity:z2",
  "ZINTERCARD 2 parity:z1 parity:z2 LIMIT 1",
  "ZRANGESTORE parity:zo parity:z1 (1 +inf BYSCORE LIMIT 0 1",
  "ZADD parity:lex 0 a 0 b 0 c 0 d",
  "ZRANGEBYLEX parity:lex [b (d",
  "ZREVRANGEBYLEX parity:lex + (a LIMIT 0 2",
  "ZLEXCOUNT parity:lex [b +",
  "ZREMRANGEBYLEX parity:lex [a (c",
  "PFADD parity:hll a b c",
  "PFADD parity:hll a",
  "PFCOUNT parity:hll",
  "SETBIT parity:bits 100 1",
  "GETBIT parity:bits 100",
  "BITCOUNT parity:bits",
  "WAIT 0 0",
  "SPUBLISH parity:ch hi",
  "FCALL parity_no_such_function 0",
  "ZADD parity:f 1e20 a 1.5e-7 b 0.00001 c",
  "ZRANGE parity:f 0 -1 WITHSCORES",
  "~HELLO 3",
  "ZRANGE parity:z1 0 -1 WITHSCORES",
  "ZRANGEBYSCORE parity:z1 -inf +inf WITHSCORES",
  "ZSCORE parity:z1 b",
  "ZPOPMIN parity:z2 2",
  "ZRANK parity:z1 c WITHSCORE",
  "DEL parity:xs parity:s parity:l parity:s1 parity:s2 parity:sd parity:z1 parity:z2 parity:zo parity:lex parity:hll parity:bits parity:f",
]
const protocolAt = (index: number): 2 | 3 =>
  index > 0 && commands.slice(0, index).includes("~HELLO 3") ? 3 : 2
const words = (command: string) => command.replace(/^~/, "").split(" ")

try {
  const real = await sendAll(url, commands)
  const redis = createRedis()
  const client = redis.client()
  const mock: string[] = []
  for (const [index, command] of commands.entries()) {
    const [name, ...args] = words(command)
    if (!name) continue
    const reply = await client.raw(name, ...args)
    mock.push(Buffer.from(encodeReply(reply, protocolAt(index))).toString("latin1"))
  }
  redis.close()
  const mismatches = commands.filter(
    (command, index) => !command.startsWith("~") && real[index] !== mock[index],
  )
  if (mismatches.length > 0) {
    console.error(
      `redis parity: ${mismatches.length} command(s) diverged: ${mismatches.join(", ")}`,
    )
    process.exit(1)
  }
  console.log(`redis parity: ${commands.length} commands matched`)
} catch (error) {
  console.error(
    `redis parity: could not compare against REDIS_URL (${error instanceof Error ? error.name : "Error"})`,
  )
  process.exit(1)
}

function sendAll(target: string, commands: string[]): Promise<string[]> {
  const parsed = new URL(target)
  const port = parsed.port ? Number(parsed.port) : 6379
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, parsed.hostname)
    const parser = new RespParser()
    const got: string[] = []
    socket.setTimeout(5000)
    socket.on("timeout", () => {
      socket.destroy()
      reject(new Error("timeout"))
    })
    socket.on("error", reject)
    const password = decodeURIComponent(parsed.password)
    const prefix = password ? 1 : 0
    socket.on("data", (chunk: Uint8Array) => {
      for (const reply of parser.push(chunk))
        got.push(
          Buffer.from(encodeReply(reply, protocolAt(got.length - prefix))).toString("latin1"),
        )
      if (got.length >= commands.length + prefix) {
        socket.end()
        resolve(got.slice(prefix, prefix + commands.length))
      }
    })
    socket.on("connect", () => {
      if (password) {
        socket.write(encodeCommand("AUTH", [password]))
      }
      for (const command of commands) {
        const [name, ...args] = words(command)
        if (name) socket.write(encodeCommand(name, args))
      }
    })
  })
}

function encodeCommand(name: string, args: string[]): Uint8Array {
  const reply: Reply = {
    t: "array",
    v: [name, ...args].map((part) => ({ t: "bulk", v: Buffer.from(part) })),
  }
  const encoded = encodeReply(reply, 2)
  const parsed = new RespParser().push(encoded)
  const command = parsed[0] ? asCommand(parsed[0]) : null
  if (!command || "t" in command) return encoded
  return encoded
}
