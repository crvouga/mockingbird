import { afterEach, describe, expect, test } from "bun:test"
import { connect } from "node:net"
import { createRedis, manualClock, RedisReplyError } from "../src/index.ts"
import { RequestParser } from "../src/protocol.ts"
import { serve } from "../src/server.ts"

// Expected values were observed against redis-server 8.4.0 with the same requests.

const rejects = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(RedisReplyError)
  return (error as Error).message
}

describe("SET expiry validation (#500)", () => {
  test("zero, negative and overflowing expiry is rejected and leaves the old value", async () => {
    const redis = createRedis({ clock: manualClock(1_700_000_000_000) })
    const client = redis.client()
    await client.call("SET", "k", "old")
    const bad: string[][] = [
      ["SET", "k", "new", "EX", "0"],
      ["SET", "k", "new", "PX", "0"],
      ["SET", "k", "new", "EX", "-1"],
      ["SET", "k", "new", "EXAT", "0"],
      ["SET", "k", "new", "PXAT", "-5"],
      ["SET", "k", "new", "EX", "9223372036854775807"],
      ["SET", "k", "new", "EX", "9223372036854776"],
      ["SET", "k", "new", "EXAT", "9223372036854775807"],
      ["SET", "k", "new", "NX", "EX", "0"],
    ]
    for (const [name = "", ...args] of bad) {
      expect(await rejects(client.call(name, ...args))).toBe(
        "ERR invalid expire time in 'set' command",
      )
    }
    expect(await rejects(client.call("SETEX", "k", "0", "new"))).toBe(
      "ERR invalid expire time in 'setex' command",
    )
    expect(await rejects(client.call("SETEX", "k2", "-5", "v"))).toBe(
      "ERR invalid expire time in 'setex' command",
    )
    expect(await rejects(client.call("SETEX", "k2", "9223372036854775807", "v"))).toBe(
      "ERR invalid expire time in 'setex' command",
    )
    expect(await rejects(client.call("PSETEX", "k2", "0", "v"))).toBe(
      "ERR invalid expire time in 'psetex' command",
    )
    expect(await client.call("GET", "k")).toBe("old")
    expect(await client.call("EXISTS", "k2")).toBe(0)
    redis.close()
  })

  test("the largest valid expiry is accepted and parsing keeps Redis' option rules", async () => {
    const redis = createRedis({ clock: manualClock(1_700_000_000_000) })
    const client = redis.client()
    expect(await client.call("SET", "a", "v", "EX", "9223372036854775")).toBe("OK")
    // now + 9223372036854775 s wraps past 2^63 ms in Redis: the key is stored already expired.
    expect(await client.call("EXISTS", "a")).toBe(0)
    expect(await client.call("SET", "b", "v", "PXAT", "9223372036854775807")).toBe("OK")
    expect(await client.call("EXISTS", "b")).toBe(1)
    // The same expiry option may repeat (last wins); mixing options, or a missing value, is a syntax error.
    expect(await client.call("SET", "c", "v", "EX", "0", "EX", "10")).toBe("OK")
    expect(await client.call("TTL", "c")).toBe(10)
    expect(await rejects(client.call("SET", "c", "v", "EX", "10", "PX", "10"))).toBe(
      "ERR syntax error",
    )
    expect(await rejects(client.call("SET", "c", "v", "EX"))).toBe("ERR syntax error")
    // Options are parsed before the number is: a later syntax error wins over a non-integer.
    expect(await rejects(client.call("SET", "c", "v", "EX", "abc", "FOO"))).toBe("ERR syntax error")
    expect(await rejects(client.call("SET", "c", "v", "EX", "abc"))).toBe(
      "ERR value is not an integer or out of range",
    )
    redis.close()
  })

  test("inside MULTI the bad expiry fails at EXEC, not at queue time", async () => {
    const redis = createRedis()
    const client = redis.client()
    await client.call("MULTI")
    expect(await client.call("SETEX", "q", "0", "v")).toBe("QUEUED")
    await client.call("SET", "other", "1")
    const results = (await client.raw("EXEC")) as { t: "array"; v: Array<{ t: string; v: string }> }
    expect(results.v.map((reply) => reply.t)).toEqual(["error", "simple"])
    expect(results.v[0]?.v).toBe("ERR invalid expire time in 'setex' command")
    redis.close()
  })
})

describe("SETNX (#502)", () => {
  test("replies 1 when the key was set and 0 when it existed, whatever its type", async () => {
    const redis = createRedis()
    const client = redis.client()
    expect(await client.call("SETNX", "sn", "1")).toBe(1)
    expect(await client.call("SETNX", "sn", "2")).toBe(0)
    expect(await client.call("GET", "sn")).toBe("1")
    await client.call("RPUSH", "list", "a")
    expect(await client.call("SETNX", "list", "x")).toBe(0)
    expect(await client.call("TYPE", "list")).toBe("list")
    await client.call("SET", "ttl", "v", "EX", 100)
    await client.call("DEL", "ttl")
    expect(await client.call("SETNX", "ttl", "v")).toBe(1)
    expect(await client.call("TTL", "ttl")).toBe(-1)
    await expect(client.call("SETNX", "sn")).rejects.toThrow(
      "ERR wrong number of arguments for 'setnx' command",
    )
    redis.close()
  })

  test("inside MULTI the replies are integers too", async () => {
    const redis = createRedis()
    const client = redis.client()
    await client.call("MULTI")
    await client.call("SETNX", "q", "1")
    await client.call("SETNX", "q", "2")
    const results = (await client.raw("EXEC")) as { t: "array"; v: Array<{ t: string; v: number }> }
    expect(results.v).toEqual([
      { t: "int", v: 1 },
      { t: "int", v: 0 },
    ])
    redis.close()
  })
})

describe("TTL rounding (#503)", () => {
  test("TTL is PTTL rounded to the nearest second, halves up", async () => {
    const redis = createRedis({ clock: manualClock(1_700_000_000_000) })
    const client = redis.client()
    const rows: Array<[number, number]> = [
      [700, 1],
      [499, 0],
      [500, 1],
      [1499, 1],
      [1500, 2],
      [1600, 2],
      [2600, 3],
      [90_000, 90],
    ]
    for (const [px, ttl] of rows) {
      await client.call("SET", "t", "v", "PX", px)
      expect([px, await client.call("PTTL", "t"), await client.call("TTL", "t")]).toEqual([
        px,
        px,
        ttl,
      ])
    }
    await client.call("SET", "t", "v", "EX", 100)
    redis.advance(1)
    expect(await client.call("PTTL", "t")).toBe(99_999)
    expect(await client.call("TTL", "t")).toBe(100)
    expect(await client.call("TTL", "missing")).toBe(-2)
    await client.call("SET", "p", "v")
    expect(await client.call("TTL", "p")).toBe(-1)
    redis.close()
  })
})

describe("SCAN TYPE (#506)", () => {
  test("filters by type, composes with MATCH and COUNT, and an unknown type is empty", async () => {
    const redis = createRedis()
    const client = redis.client()
    await client.call("SET", "s1", "v")
    await client.call("HSET", "h1", "f", "v")
    await client.call("RPUSH", "l1", "a")
    await client.call("ZADD", "z1", 1, "m")
    await client.call("SADD", "st1", "a")
    await client.call("XADD", "x1", "1-1", "a", "b")
    const scan = (...args: Array<string | number>) => client.call("SCAN", 0, ...args)
    expect(await scan("TYPE", "string", "COUNT", 100)).toEqual(["0", ["s1"]])
    expect(await scan("TYPE", "hash", "COUNT", 100)).toEqual(["0", ["h1"]])
    expect(await scan("TYPE", "list", "COUNT", 100)).toEqual(["0", ["l1"]])
    expect(await scan("TYPE", "set")).toEqual(["0", ["st1"]])
    expect(await scan("TYPE", "stream")).toEqual(["0", ["x1"]])
    expect(await scan("MATCH", "?1", "TYPE", "zset", "COUNT", 100)).toEqual(["0", ["z1"]])
    expect(await scan("TYPE", "ZSET")).toEqual(["0", ["z1"]])
    expect(await scan("TYPE", "nosuchtype", "COUNT", 100)).toEqual(["0", []])
    expect(await rejects(scan("TYPE"))).toBe("ERR syntax error")
    redis.close()
  })
})

describe("KEYS and SCAN MATCH globs (#509)", () => {
  test("[!b], an unclosed class and a reversed range follow Redis", async () => {
    const redis = createRedis()
    const client = redis.client()
    for (const key of ["ab", "ac", "ad", "aB", "a!", "a", "b1", "A", ""]) {
      await client.call("SET", key, "1")
    }
    const keys = async (pattern: string) =>
      ((await client.call("KEYS", pattern)) as string[]).sort()
    const scan = async (pattern: string) => {
      const reply = (await client.call("SCAN", 0, "MATCH", pattern, "COUNT", 100)) as [
        string,
        string[],
      ]
      return reply[1].sort()
    }
    const expected: Array<[string, string[]]> = [
      ["a[!b]", ["a!", "ab"]],
      ["*[!a]", ["a", "a!"]],
      ["a[b", ["ab"]],
      ["a[c-b]", ["ab", "ac"]],
      ["a[b-c]", ["ab", "ac"]],
      ["a[^b]", ["a!", "aB", "ac", "ad"]],
      ["a[]", []],
      ["*", ["", "A", "a", "a!", "aB", "ab", "ac", "ad", "b1"]],
    ]
    for (const [pattern, found] of expected) {
      expect([pattern, await keys(pattern)]).toEqual([pattern, found])
      expect([pattern, await scan(pattern)]).toEqual([pattern, found])
    }
    redis.close()
  })
})

describe("INFO (#501)", () => {
  const fields = (text: string) =>
    Object.fromEntries(
      text
        .split("\r\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]),
    )
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  test("tcp_port is the listening port, uptime follows the clock", async () => {
    const clock = manualClock(1_700_000_000_000)
    const redis = createRedis({ clock })
    const listening = await serve(redis, { port: 0, host: "127.0.0.1" })
    stop = () => listening.close()
    expect(listening.port).not.toBe(6379)
    const socket = connect(listening.port, listening.host)
    const replies: string[] = []
    socket.on("data", (data) => replies.push(data.toString("latin1")))
    const ask = async (...args: string[]) => {
      const before = replies.length
      socket.write(`*${args.length}\r\n${args.map((a) => `$${a.length}\r\n${a}\r\n`).join("")}`)
      for (let i = 0; i < 100 && replies.length === before; i++) await Bun.sleep(5)
      return replies[before] ?? ""
    }
    expect(fields(await ask("INFO", "server")).tcp_port).toBe(String(listening.port))
    expect(fields(await ask("INFO", "server")).uptime_in_seconds).toBe("0")
    redis.advance(3_200)
    expect(fields(await ask("INFO", "server")).uptime_in_seconds).toBe("3")
    socket.destroy()
  })

  test("memory, clients and the other sections are well formed", async () => {
    const redis = createRedis({ clock: manualClock(0) })
    const client = redis.client()
    const info = async (...sections: string[]) => String(await client.call("INFO", ...sections))
    const merged = { ...fields(await info()), ...fields(await info("memory")) }
    for (const name of [
      "used_memory",
      "used_memory_peak",
      "mem_fragmentation_ratio",
      "total_system_memory",
      "maxmemory",
    ]) {
      expect(Number.isFinite(Number(merged[name]))).toBe(true)
    }
    expect(merged.used_memory_human).toMatch(/^\d+(?:\.\d+)?[KMG]$/)
    expect(Number(merged.used_memory_peak)).toBeGreaterThanOrEqual(Number(merged.used_memory))
    expect(fields(await info("clients")).blocked_clients).toBe("0")
    expect(await info("everything")).toContain("# CPU\r\nused_cpu_sys:")
    expect(await info("cpu")).toContain("# CPU\r\nused_cpu_sys:")
    await client.call("SET", "k", "v")
    await client.call("GET", "k")
    await client.call("GET", "k")
    expect(await info("commandstats")).toContain("cmdstat_get:calls=2,")
    expect(await info("default")).not.toContain("# Commandstats")
    expect(await info("all")).toContain("# Commandstats")
    const two = await info("server", "clients")
    expect(two).toContain("# Server")
    expect(two).toContain("# Clients")
    expect(two).not.toContain("# Memory")
    expect(await info("nonexistent")).toBe("")
    redis.close()
  })
})

describe("RESP protocol errors (#508)", () => {
  const ping = "*1\r\n$4\r\nPING\r\n"
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  const exchange = async (payload: string) => {
    const redis = createRedis()
    const listening = await serve(redis, { port: 0, host: "127.0.0.1" })
    stop = () => listening.close()
    return new Promise<{ received: string; closed: boolean }>((resolve) => {
      const socket = connect(listening.port, listening.host)
      let received = ""
      let closed = false
      socket.on("data", (data) => {
        received += data.toString("latin1")
      })
      socket.on("close", () => {
        closed = true
      })
      socket.on("error", () => undefined)
      socket.write(payload, "latin1")
      setTimeout(() => {
        socket.destroy()
        resolve({ received, closed })
      }, 150)
    })
  }

  const fatal: Array<[string, string, string]> = [
    ["bulk length not a number", `*1\r\n$abc\r\nPING\r\n${ping}`, "invalid bulk length"],
    [
      "bulk length above 512 MB",
      `*2\r\n$3\r\nGET\r\n$536870913\r\nx\r\n${ping}`,
      "invalid bulk length",
    ],
    ["huge bulk length", `*2\r\n$3\r\nGET\r\n$99999999999\r\nx\r\n${ping}`, "invalid bulk length"],
    ["negative bulk length", `*2\r\n$3\r\nGET\r\n$-1\r\n${ping}`, "invalid bulk length"],
    ["huge array length", "*99999999999\r\n$4\r\nPING\r\n", "invalid multibulk length"],
    ["array length not a number", `*abc\r\n${ping}`, "invalid multibulk length"],
    ["argument is not a bulk string", `*1\r\n:5\r\n${ping}`, "expected '$', got ':'"],
    ["unbalanced inline quotes", `SET "a b\r\n${ping}`, "unbalanced quotes in request"],
    ["oversized inline line", "x".repeat(70_000), "too big inline request"],
  ]
  for (const [label, payload, message] of fatal) {
    test(`${label}: protocol error, connection closed, nothing after it runs`, async () => {
      const { received, closed } = await exchange(payload)
      expect(received).toBe(`-ERR Protocol error: ${message}\r\n`)
      expect(closed).toBe(true)
    })
  }

  test("commands before the bad frame are answered first", async () => {
    const { received, closed } = await exchange(`${ping}*1\r\n$abc\r\n${ping}`)
    expect(received).toBe("+PONG\r\n-ERR Protocol error: invalid bulk length\r\n")
    expect(closed).toBe(true)
  })

  for (const [label, payload] of [
    ["null array", `*-1\r\n${ping}`],
    ["empty array", `*0\r\n${ping}`],
    ["blank inline line", `\r\n${ping}`],
  ] as const) {
    test(`${label} is a no-op and the connection keeps working`, async () => {
      const { received, closed } = await exchange(payload)
      expect(received).toBe("+PONG\r\n")
      expect(closed).toBe(false)
    })
  }

  test("inline commands honour quotes and escapes", async () => {
    const { received } = await exchange(
      `SET k "a\\x41\\n b"\r\nGET k\r\nSET j 'x\\'y'\r\nGET j\r\n`,
    )
    expect(received).toBe("+OK\r\n$5\r\naA\n b\r\n+OK\r\n$3\r\nx'y\r\n")
  })

  test("the parser resumes across arbitrary chunk boundaries", () => {
    const parser = new RequestParser()
    const bytes = Buffer.from(
      "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\nhello\r\nPING\r\n*1\r\n$4\r\nPING\r\n",
      "latin1",
    )
    const seen: string[] = []
    for (const byte of bytes) {
      const { requests, error } = parser.push(Uint8Array.of(byte))
      expect(error).toBeNull()
      for (const request of requests) seen.push(request.name)
    }
    expect(seen).toEqual(["SET", "PING", "PING"])
  })
})
