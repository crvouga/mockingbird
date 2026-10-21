import { describe, expect, test } from "bun:test"
import { createRedis, manualClock, RedisReplyError } from "../src/index.ts"
import { encodeReply } from "../src/protocol.ts"
import { sha1Hex } from "../src/sha1.ts"

const frame = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1")

async function settled(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error("condition was not met")
}

describe("RESP replies", () => {
  test("encodes command replies the way Redis 8.4.0 does", async () => {
    const redis = createRedis()
    const client = redis.client()
    expect(frame(encodeReply(await client.raw("PING")))).toBe("+PONG\r\n")
    expect(frame(encodeReply(await client.raw("SET", "k", "v")))).toBe("+OK\r\n")
    expect(frame(encodeReply(await client.raw("GET", "missing")))).toBe("$-1\r\n")
    expect(await client.call("SET", "n", "10")).toBe("OK")
    expect(frame(encodeReply(await client.raw("INCR", "n")))).toBe(":11\r\n")
    expect(frame(encodeReply(await client.raw("DEL", "absent")))).toBe(":0\r\n")
    expect(frame(encodeReply(await client.raw("SET", "k", "w", "NX", "GET")))).toBe("$1\r\nv\r\n")
    expect(await client.call("GET", "k")).toBe("v")
    await expect(client.call("INCR", "k")).rejects.toThrow(
      "ERR value is not an integer or out of range",
    )
    await expect(client.call("LPUSH", "k", "a")).rejects.toThrow(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
    await expect(client.call("FOO", "a", "b")).rejects.toThrow(
      "ERR unknown command 'FOO', with args beginning with: 'a' 'b' ",
    )
    await expect(client.call("GET")).rejects.toThrow(
      "ERR wrong number of arguments for 'get' command",
    )
    redis.close()
  })

  test("HELLO 3 switches the protocol before the reply", async () => {
    const redis = createRedis()
    const client = redis.client()
    const hello = await client.raw("HELLO", "3")
    expect(client.protocol).toBe(3)
    expect(frame(encodeReply(hello, client.protocol)).startsWith("%7\r\n")).toBe(true)
    expect(frame(encodeReply(await client.raw("GET", "missing"), client.protocol))).toBe("_\r\n")
    expect(frame(encodeReply(await client.raw("PING"), 3))).toBe("+PONG\r\n")
    redis.close()
  })

  test("SCRIPT LOAD uses SHA-1", async () => {
    expect(sha1Hex(new Uint8Array())).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709")
    expect(sha1Hex(Buffer.from("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d")
    const redis = createRedis()
    const client = redis.client()
    const digest = await client.call("SCRIPT", "LOAD", "return 1")
    expect(digest).toBe(sha1Hex(Buffer.from("return 1")))
    if (typeof digest !== "string") throw new Error("script digest")
    expect(await client.call("EVALSHA", digest, 0)).toBe(1)
    await expect(client.call("EVALSHA", "ab", 0)).rejects.toThrow(RedisReplyError)
    redis.close()
  })
})

describe("expiration and locks", () => {
  test("PX uses the injected clock, and EXPIRE NX/XX/negative match Redis", async () => {
    const clock = manualClock(1_700_000_000_000)
    const redis = createRedis({ clock })
    const client = redis.client()
    expect(await client.call("SET", "lock", "token", "PX", 1500)).toBe("OK")
    expect(await client.call("TTL", "lock")).toBe(2)
    expect(await client.call("PTTL", "lock")).toBe(1500)
    expect(await client.call("EXPIRE", "lock", 5, "NX")).toBe(0)
    redis.advance(1500)
    expect(await client.call("GET", "lock")).toBeNull()
    expect(await client.call("TTL", "lock")).toBe(-2)
    expect(await client.call("SET", "kept", "1", "EX", 100)).toBe("OK")
    expect(await client.call("EXPIRE", "kept", 5, "XX")).toBe(1)
    expect(await client.call("EXPIRE", "missing", -1)).toBe(0)
    expect(await client.call("SET", "gone", "1")).toBe("OK")
    expect(await client.call("EXPIRE", "gone", -1)).toBe(1)
    expect(await client.call("EXISTS", "gone")).toBe(0)
    redis.close()
  })

  test("a compare-and-delete lock is atomic across two clients", async () => {
    const clock = manualClock(0)
    const redis = createRedis({ clock })
    const a = redis.client()
    const b = redis.client()
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
    expect(await a.call("SET", "lock", "token", "PX", 5000)).toBe("OK")
    expect(await b.call("EVAL", script, 1, "lock", "other")).toBe(0)
    expect(await a.call("GET", "lock")).toBe("token")
    expect(await a.call("EVAL", script, 1, "lock", "token")).toBe(1)
    expect(await a.call("EXISTS", "lock")).toBe(0)
    expect(await a.call("SET", "lock", "token", "PX", 5000)).toBe("OK")
    expect(
      await a.call("EVAL", "return redis.call('pexpire', KEYS[1], ARGV[1])", 1, "lock", "5000"),
    ).toBe(1)
    expect(await a.call("PTTL", "lock")).toBe(5000)
    expect(await a.call("EVAL", "return {1, false, nil, 'ok'}", 0)).toEqual([1, null])
    redis.close()
  })
})

describe("transactions, blocking, pub/sub, and streams", () => {
  test("WATCH conflict aborts EXEC, and a bad queued command aborts later", async () => {
    const redis = createRedis()
    const a = redis.client()
    const b = redis.client()
    expect(await a.call("WATCH", "k")).toBe("OK")
    expect(await b.call("SET", "k", "other")).toBe("OK")
    expect(await a.call("MULTI")).toBe("OK")
    expect(await a.call("SET", "k", "mine")).toBe("QUEUED")
    expect(await a.call("EXEC")).toBeNull()
    expect(await a.call("GET", "k")).toBe("other")
    expect(await a.call("MULTI")).toBe("OK")
    await expect(a.call("GET")).rejects.toThrow("ERR wrong number of arguments for 'get' command")
    expect(await a.call("SET", "k", "later")).toBe("QUEUED")
    await expect(a.call("EXEC")).rejects.toThrow(
      "EXECABORT Transaction discarded because of previous errors.",
    )
    redis.close()
  })

  test("BLPOP waits without blocking the other client, then times out on the manual clock", async () => {
    const clock = manualClock(0)
    const redis = createRedis({ clock })
    const reader = redis.client()
    const writer = redis.client()
    const popped = reader.call("BLPOP", "q", 1)
    await settled(() => redis.waiterCount() === 1)
    expect(await writer.call("LPUSH", "q", "a", "b")).toBe(2)
    expect(await popped).toEqual(["q", "b"])
    const timed = reader.call("BLPOP", "empty", 1)
    await settled(() => redis.waiterCount() === 1)
    redis.advance(1000)
    expect(await timed).toBeNull()
    redis.close()
  })

  test("pauseConsumers holds a blocked reader until resume", async () => {
    const redis = createRedis()
    redis.pauseConsumers(true)
    const reader = redis.client()
    const writer = redis.client()
    const popped = reader.call("BLPOP", "q", 0)
    await settled(() => redis.waiterCount() === 1)
    expect(await writer.call("LPUSH", "q", "item")).toBe(1)
    expect(redis.waiterCount()).toBe(1)
    redis.pauseConsumers(false)
    expect(await popped).toEqual(["q", "item"])
    redis.close()
  })

  test("PUBLISH delivers a message push", async () => {
    const redis = createRedis()
    const sub = redis.client()
    const pub = redis.client()
    const pushes: string[] = []
    sub.onPush((reply) => {
      if (reply.t === "push" && reply.v[0]?.t === "bulk" && reply.v[0].v) {
        pushes.push(Buffer.from(reply.v[0].v).toString("utf8"))
      }
    })
    expect(await sub.call("SUBSCRIBE", "ch")).toEqual(["subscribe", "ch", 1])
    expect(await pub.call("PUBLISH", "ch", "hi")).toBe(1)
    expect(pushes).toEqual(["message"])
    expect(await pub.call("PUBLISH", "other", "hi")).toBe(0)
    redis.close()
  })

  test("a consumer group pending entry can be claimed", async () => {
    const clock = manualClock(1_000)
    const redis = createRedis({ clock })
    const client = redis.client()
    expect(await client.call("XGROUP", "CREATE", "st", "g", "$", "MKSTREAM")).toBe("OK")
    const id = await client.call("XADD", "st", "*", "field", "value")
    expect(id).toBe("1000-0")
    expect(
      await client.call("XREADGROUP", "GROUP", "g", "c", "COUNT", "1", "STREAMS", "st", ">"),
    ).toEqual([["st", [["1000-0", ["field", "value"]]]]])
    expect(await client.call("XPENDING", "st", "g")).toEqual([1, "1000-0", "1000-0", [["c", "1"]]])
    expect(await client.call("XAUTOCLAIM", "st", "g", "c2", "0", "0-0", "COUNT", "10")).toEqual([
      "0-0",
      [["1000-0", ["field", "value"]]],
      [],
    ])
    redis.close()
  })

  test("XREAD BLOCK $ observes an entry added after the read starts", async () => {
    const clock = manualClock(5_000)
    const redis = createRedis({ clock })
    const reader = redis.client()
    const writer = redis.client()
    expect(await writer.call("XADD", "st", "*", "f", "1")).toBe("5000-0")
    const pending = reader.call("XREAD", "BLOCK", "0", "STREAMS", "st", "$")
    await settled(() => redis.waiterCount() === 1)
    expect(await writer.call("XADD", "st", "*", "f", "2")).toBe("5000-1")
    expect(await pending).toEqual([["st", [["5000-1", ["f", "2"]]]]])
    redis.close()
  })
})

describe("namespaces", () => {
  test("SELECT and separate instances do not leak keys", async () => {
    const redis = createRedis()
    const db0 = redis.client()
    const db1 = redis.client()
    expect(await db0.call("SET", "k", "zero")).toBe("OK")
    expect(await db1.call("SELECT", "1")).toBe("OK")
    expect(await db1.call("GET", "k")).toBeNull()
    expect(await db1.call("SET", "k", "one")).toBe("OK")
    expect(await db0.call("GET", "k")).toBe("zero")
    expect(redis.inspect(0).map((item) => item.key)).toEqual(["k"])
    expect(redis.inspect(1).map((item) => item.key)).toEqual(["k"])
    const other = createRedis()
    expect(await other.client().call("GET", "k")).toBeNull()
    await expect(db0.call("SELECT", "16")).rejects.toThrow("ERR DB index is out of range")
    redis.reset()
    expect(redis.inspect(0)).toEqual([])
    expect(await db1.call("GET", "k")).toBeNull()
    redis.close()
    other.close()
  })

  test("readonly, oom, and disconnect faults are deterministic", async () => {
    const redis = createRedis()
    const client = redis.client()
    redis.fault("readonly")
    await expect(client.call("SET", "k", "v")).rejects.toThrow(
      "READONLY You can't write against a read only replica.",
    )
    redis.fault(null)
    expect(await client.call("SET", "k", "v")).toBe("OK")
    redis.fault("oom")
    await expect(client.call("SET", "k", "w")).rejects.toThrow(
      "OOM command not allowed when used memory > 'maxmemory'.",
    )
    redis.fault("disconnect")
    await expect(client.call("PING")).rejects.toThrow("Connection is closed")
    redis.close()
  })
})
