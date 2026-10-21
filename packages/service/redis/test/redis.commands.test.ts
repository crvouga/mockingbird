import { afterEach, describe, expect, test } from "bun:test"
import { connect, type Socket } from "node:net"
import { createRedis, manualClock, RedisReplyError } from "../src/index.ts"
import { serve } from "../src/server.ts"

// Issues #498, #499 and #507. Where a comment says "best guess" the value is not oracle-verified;
// the rest were observed against redis-server 8.4.0 in the reports.

const rejects = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(RedisReplyError)
  return (error as Error).message
}

const setup = () => {
  const redis = createRedis({ clock: manualClock(1_700_000_000_000) })
  return { redis, client: redis.client() }
}

const encode = (...parts: string[]) =>
  `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`

describe("MONITOR (#498)", () => {
  let stop: (() => Promise<void>) | undefined
  const sockets: Socket[] = []
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy()
    await stop?.()
    stop = undefined
  })

  const monitorOn = async (password?: string) => {
    const redis = createRedis({
      clock: manualClock(1_700_000_000_123),
      ...(password ? { password } : {}),
    })
    const listening = await serve(redis, { port: 0, host: "127.0.0.1" })
    stop = () => listening.close()
    const socket = connect(listening.port, listening.host)
    sockets.push(socket)
    let received = ""
    socket.on("data", (data) => {
      received += data.toString("latin1")
    })
    const settle = () => Bun.sleep(60)
    return {
      redis,
      listening,
      socket,
      received: () => received,
      settle,
      write: (...parts: string[]) => socket.write(encode(...parts)),
      other: () => redis.client(),
    }
  }

  test("AUTH and MONITOR pipelined in one write reply +OK twice, then only the stream", async () => {
    const m = await monitorOn("pw")
    m.socket.write(encode("AUTH", "default", "pw") + encode("MONITOR"))
    await m.settle()
    expect(m.received()).toBe("+OK\r\n+OK\r\n")
  })

  test("SET with options is shown as the monitor saw it, with a unix timestamp and the origin", async () => {
    const m = await monitorOn()
    m.write("MONITOR")
    await m.settle()
    await m.other().call("set", "lock:x", "token-1", "PX", "30000", "NX")
    await m.settle()
    const lines = m.received().split("\r\n").filter(Boolean)
    expect(lines[0]).toBe("+OK")
    expect(lines[1]).toMatch(
      /^\+1700000000\.123000 \[0 127\.0\.0\.1:\d+\] "set" "lock:x" "token-1" "PX" "30000" "NX"$/,
    )
    expect(lines).toHaveLength(2)
  })

  test("EVAL is shown with its escaped script, then the script's own calls with origin lua", async () => {
    const m = await monitorOn()
    m.write("MONITOR")
    await m.settle()
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
    const other = m.other()
    await other.call("set", "lock:x", "token-1")
    await other.call("eval", script, "1", "lock:x", "token-1")
    await m.settle()
    const lines = m.received().split("\r\n").filter(Boolean)
    const escaped = script.replaceAll('"', '\\"')
    expect(lines[2]).toMatch(/^\+\d+\.\d{6} \[0 127\.0\.0\.1:\d+\] "eval" /)
    expect(lines[2]?.endsWith(`"eval" "${escaped}" "1" "lock:x" "token-1"`)).toBe(true)
    expect(lines[3]).toMatch(/^\+\d+\.\d{6} \[0 lua\] "get" "lock:x"$/)
    expect(lines[4]).toMatch(/^\+\d+\.\d{6} \[0 lua\] "del" "lock:x"$/)
    expect(lines).toHaveLength(5)
  })

  test("AUTH arguments are redacted and the password never appears", async () => {
    const m = await monitorOn("hunter2")
    m.socket.write(encode("AUTH", "default", "hunter2") + encode("MONITOR"))
    await m.settle()
    const second = m.redis.client()
    await second.call("auth", "hunter2")
    await m.settle()
    expect(m.received()).toContain(`"auth" "(redacted)"`)
    expect(m.received()).not.toContain("hunter2")
  })

  test("the database index in the bracket follows SELECT", async () => {
    const m = await monitorOn()
    m.write("MONITOR")
    await m.settle()
    const other = m.other()
    await other.call("select", "3")
    await other.call("set", "k", "v")
    await m.settle()
    const lines = m.received().split("\r\n").filter(Boolean)
    expect(lines[1]).toMatch(/\[3 127\.0\.0\.1:\d+\] "select" "3"$/)
    expect(lines[2]).toMatch(/\[3 127\.0\.0\.1:\d+\] "set" "k" "v"$/)
  })

  test("arguments are quoted like sdscatrepr and rejected commands are not shown", async () => {
    const m = await monitorOn()
    m.write("MONITOR")
    await m.settle()
    const other = m.other()
    await other.call("set", "k", 'a"b\\c\n\x01')
    await rejects(other.call("nosuch", "x"))
    await rejects(other.call("get"))
    await m.settle()
    const lines = m.received().split("\r\n").filter(Boolean)
    expect(lines[1]).toMatch(/"set" "k" "a\\"b\\\\c\\n\\x01"$/)
    expect(lines).toHaveLength(2)
  })

  test("the monitoring connection cannot touch the keyspace, and MONITOR takes no arguments", async () => {
    const m = await monitorOn()
    m.write("MONITOR")
    await m.settle()
    m.write("GET", "k")
    await m.settle()
    expect(m.received()).toBe("+OK\r\n-ERR Replica can't interact with the keyspace\r\n")
    const { client } = setup()
    expect(await rejects(client.call("MONITOR", "x"))).toBe(
      "ERR wrong number of arguments for 'monitor' command",
    )
  })
})

describe("MEMORY USAGE and OBJECT (#499)", () => {
  test("MEMORY USAGE is a positive integer that grows with the value (best guess sizes)", async () => {
    const { client } = setup()
    await client.call("SET", "mk", "value")
    await client.call("SET", "big", "v".repeat(500))
    await client.call("RPUSH", "lst", "a")
    const small = Number(await client.call("MEMORY", "USAGE", "mk"))
    expect(small).toBeGreaterThan(0)
    expect(Number(await client.call("MEMORY", "USAGE", "big"))).toBeGreaterThan(small + 400)
    expect(Number(await client.call("MEMORY", "USAGE", "lst", "SAMPLES", "5"))).toBeGreaterThan(0)
    await client.call("RPUSH", "lst", "b", "c")
    expect(Number(await client.call("MEMORY", "USAGE", "lst"))).toBeGreaterThan(
      Number(await client.call("MEMORY", "USAGE", "mk", "SAMPLES", "0")) - 1000,
    )
  })

  test("MEMORY USAGE of a missing key is nil; bad options are errors", async () => {
    const { client } = setup()
    expect(await client.call("MEMORY", "USAGE", "missing")).toBeNull()
    await client.call("SET", "mk", "v")
    expect(await rejects(client.call("MEMORY", "USAGE", "mk", "SAMPLES"))).toBe("ERR syntax error")
    expect(await rejects(client.call("MEMORY", "USAGE", "mk", "BOGUS", "1"))).toBe(
      "ERR syntax error",
    )
    expect(await rejects(client.call("MEMORY", "USAGE", "mk", "SAMPLES", "x"))).toBe(
      "ERR value is not an integer or out of range",
    )
  })

  test("MEMORY DOCTOR, STATS and MALLOC-STATS are explicit unsupported errors", async () => {
    const { client } = setup()
    for (const sub of ["DOCTOR", "STATS", "MALLOC-STATS"]) {
      expect(await rejects(client.call("MEMORY", sub))).toBe(
        `ERR MEMORY ${sub} is not supported by the Mockingbird Redis emulator`,
      )
    }
    expect(await client.call("MEMORY", "PURGE")).toBe("OK")
  })

  test("OBJECT IDLETIME tracks the injected clock and resets on read or write", async () => {
    const { redis, client } = setup()
    await client.call("SET", "mk", "value")
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(0)
    redis.advance(5000)
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(5)
    // OBJECT itself does not count as an access.
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(5)
    await client.call("GET", "mk")
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(0)
    redis.advance(2500)
    await client.call("SET", "mk", "again")
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(0)
    redis.advance(61_000)
    expect(await client.call("OBJECT", "IDLETIME", "mk")).toBe(61)
  })

  test("OBJECT on a missing key is nil; FREQ explains the LFU policy; ENCODING names the encoding", async () => {
    const { client } = setup()
    expect(await client.call("OBJECT", "IDLETIME", "missing")).toBeNull()
    expect(await client.call("OBJECT", "ENCODING", "missing")).toBeNull()
    await client.call("SET", "mk", "value")
    expect(await rejects(client.call("OBJECT", "FREQ", "mk"))).toBe(
      "ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.",
    )
    await client.call("RPUSH", "lst", "a")
    expect(await client.call("OBJECT", "ENCODING", "lst")).toBe("listpack")
    expect(await client.call("OBJECT", "ENCODING", "mk")).toBe("embstr")
    await client.call("SET", "n", "123")
    expect(await client.call("OBJECT", "ENCODING", "n")).toBe("int")
    await client.call("SADD", "s", "1", "2")
    expect(await client.call("OBJECT", "ENCODING", "s")).toBe("intset")
    expect(await client.call("OBJECT", "REFCOUNT", "mk")).toBe(1)
    expect(Array.isArray(await client.call("OBJECT", "HELP"))).toBe(true)
    expect(await rejects(client.call("OBJECT", "NOPE", "mk"))).toBe(
      "ERR unknown subcommand 'NOPE'. Try OBJECT HELP.",
    )
  })
})

describe("HSCAN, SSCAN and ZSCAN (#507)", () => {
  test("a small collection is returned whole with cursor 0", async () => {
    const { client } = setup()
    await client.call("HSET", "h", "f1", "v1", "f2", "v2")
    await client.call("SADD", "s", "a", "b")
    await client.call("ZADD", "z", "1", "a", "2.5", "b")
    expect(await client.call("HSCAN", "h", "0", "COUNT", "100")).toEqual([
      "0",
      ["f1", "v1", "f2", "v2"],
    ])
    expect(await client.call("SSCAN", "s", "0", "COUNT", "100")).toEqual(["0", ["a", "b"]])
    expect(await client.call("ZSCAN", "z", "0", "COUNT", "100")).toEqual([
      "0",
      ["a", "1", "b", "2.5"],
    ])
  })

  test("MATCH filters by glob; NOVALUES drops hash values; a missing key is an empty page", async () => {
    const { client } = setup()
    await client.call("HSET", "h", "apple", "1", "avocado", "2", "banana", "3")
    expect(await client.call("HSCAN", "h", "0", "MATCH", "a*")).toEqual([
      "0",
      ["apple", "1", "avocado", "2"],
    ])
    expect(await client.call("HSCAN", "h", "0", "NOVALUES")).toEqual([
      "0",
      ["apple", "avocado", "banana"],
    ])
    expect(await client.call("SSCAN", "nope", "0")).toEqual(["0", []])
    expect(await client.call("ZSCAN", "nope", "0", "MATCH", "*")).toEqual(["0", []])
  })

  test("a large collection is paged by COUNT and a full walk visits every member once (best guess cursor)", async () => {
    const { client } = setup()
    const members = Array.from({ length: 300 }, (_, i) => `m${i}`)
    await client.call("SADD", "big", ...members)
    const seen: string[] = []
    let cursor = "0"
    let calls = 0
    do {
      const [next, page] = (await client.call("SSCAN", "big", cursor, "COUNT", "50")) as [
        string,
        string[],
      ]
      seen.push(...page)
      cursor = next
      calls++
    } while (cursor !== "0" && calls < 100)
    expect(calls).toBeGreaterThan(1)
    expect([...seen].sort()).toEqual([...members].sort())
  })

  test("errors: wrong type, bad cursor, bad options, arity", async () => {
    const { client } = setup()
    await client.call("SET", "str", "v")
    await client.call("SADD", "s", "a")
    const wrong = "WRONGTYPE Operation against a key holding the wrong kind of value"
    expect(await rejects(client.call("HSCAN", "str", "0"))).toBe(wrong)
    expect(await rejects(client.call("SSCAN", "str", "0"))).toBe(wrong)
    expect(await rejects(client.call("ZSCAN", "str", "0"))).toBe(wrong)
    expect(await rejects(client.call("SSCAN", "s", "abc"))).toBe("ERR invalid cursor")
    expect(await rejects(client.call("SSCAN", "s", "0", "COUNT", "0"))).toBe("ERR syntax error")
    expect(await rejects(client.call("SSCAN", "s", "0", "COUNT", "x"))).toBe(
      "ERR value is not an integer or out of range",
    )
    expect(await rejects(client.call("SSCAN", "s", "0", "BOGUS"))).toBe("ERR syntax error")
    expect(await rejects(client.call("HSCAN", "h"))).toBe(
      "ERR wrong number of arguments for 'hscan' command",
    )
  })
})

describe("ZUNIONSTORE (#507)", () => {
  test("sums scores and stores the union", async () => {
    const { client } = setup()
    await client.call("ZADD", "z1", "1", "a")
    await client.call("ZADD", "z2", "2", "a", "5", "b")
    expect(await client.call("ZUNIONSTORE", "out", "2", "z1", "z2")).toBe(2)
    expect(await client.call("ZSCORE", "out", "a")).toBe("3")
    expect(await client.call("ZSCORE", "out", "b")).toBe("5")
  })

  test("WEIGHTS, AGGREGATE, plain sets (score 1) and replacing the destination", async () => {
    const { client } = setup()
    await client.call("ZADD", "z1", "1", "a")
    await client.call("ZADD", "z2", "2", "a")
    await client.call("SADD", "s", "a", "c")
    await client.call("SET", "out", "old")
    expect(
      await client.call(
        "ZUNIONSTORE",
        "out",
        "2",
        "z1",
        "z2",
        "WEIGHTS",
        "2",
        "3",
        "AGGREGATE",
        "MAX",
      ),
    ).toBe(1)
    expect(await client.call("ZSCORE", "out", "a")).toBe("6")
    expect(await client.call("ZUNIONSTORE", "out2", "3", "z1", "z2", "s", "AGGREGATE", "MIN")).toBe(
      2,
    )
    expect(await client.call("ZSCORE", "out2", "a")).toBe("1")
    expect(await client.call("ZSCORE", "out2", "c")).toBe("1")
  })

  test("an empty union deletes the destination; errors leave it untouched", async () => {
    const { client } = setup()
    await client.call("SET", "out", "old")
    expect(await client.call("ZUNIONSTORE", "out", "1", "missing")).toBe(0)
    expect(await client.call("EXISTS", "out")).toBe(0)
    await client.call("SET", "out", "old")
    await client.call("SET", "str", "v")
    expect(await rejects(client.call("ZUNIONSTORE", "out", "1", "str"))).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
    expect(await rejects(client.call("ZUNIONSTORE", "out", "0", "z"))).toBe(
      "ERR at least 1 input key is needed for 'zunionstore' command",
    )
    expect(await rejects(client.call("ZUNIONSTORE", "out", "3", "z"))).toBe("ERR syntax error")
    expect(await client.call("GET", "out")).toBe("old")
  })
})

describe("LMPOP, BLMOVE and BRPOPLPUSH (#507)", () => {
  test("LMPOP pops from the first non-empty list and is null when all are empty", async () => {
    const { client } = setup()
    await client.call("RPUSH", "l1", "a", "b", "c")
    expect(await client.call("LMPOP", "2", "l2", "l1", "LEFT", "COUNT", "1")).toEqual(["l1", ["a"]])
    expect(await client.call("LMPOP", "2", "l2", "l1", "RIGHT", "COUNT", "5")).toEqual([
      "l1",
      ["c", "b"],
    ])
    expect(await client.call("EXISTS", "l1")).toBe(0)
    expect(await client.call("LMPOP", "2", "l2", "l1", "LEFT")).toBeNull()
  })

  test("LMPOP validates its arguments", async () => {
    const { client } = setup()
    await client.call("SET", "str", "v")
    expect(await rejects(client.call("LMPOP", "0", "l", "LEFT"))).toBe(
      "ERR numkeys should be greater than 0",
    )
    expect(await rejects(client.call("LMPOP", "1", "l", "MIDDLE"))).toBe("ERR syntax error")
    expect(await rejects(client.call("LMPOP", "1", "l", "LEFT", "COUNT", "0"))).toBe(
      "ERR count should be greater than 0",
    )
    expect(await rejects(client.call("LMPOP", "1", "str", "LEFT"))).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
  })

  test("BLMOVE and BRPOPLPUSH move an element when one is ready", async () => {
    const { client } = setup()
    await client.call("RPUSH", "src", "x", "y")
    expect(await client.call("BLMOVE", "src", "dst", "LEFT", "RIGHT", "0.01")).toBe("x")
    expect(await client.call("BRPOPLPUSH", "src", "dst2", "0.01")).toBe("y")
    expect(await client.call("LRANGE", "dst", "0", "-1")).toEqual(["x"])
    expect(await client.call("LRANGE", "dst2", "0", "-1")).toEqual(["y"])
    expect(await client.call("EXISTS", "src")).toBe(0)
  })

  test("on an empty source both block until the timeout and then reply null", async () => {
    const { redis, client } = setup()
    const first = client.call("BLMOVE", "src", "dst", "LEFT", "RIGHT", "0.01")
    const second = client.call("BRPOPLPUSH", "src", "dst", "1")
    await Bun.sleep(10)
    expect(redis.waiterCount()).toBe(2)
    redis.advance(2000)
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(await client.call("EXISTS", "dst")).toBe(0)
  })

  test("a blocked BRPOPLPUSH is served by a later push and an infinite timeout waits", async () => {
    const { redis, client } = setup()
    const waiting = client.call("BRPOPLPUSH", "src", "dst", "0")
    await Bun.sleep(10)
    const pusher = redis.client()
    await pusher.call("RPUSH", "src", "a")
    expect(await waiting).toBe("a")
    expect(await client.call("LRANGE", "dst", "0", "-1")).toEqual(["a"])
  })

  test("argument errors", async () => {
    const { client } = setup()
    expect(await rejects(client.call("BLMOVE", "a", "b", "UP", "LEFT", "1"))).toBe(
      "ERR syntax error",
    )
    expect(await rejects(client.call("BRPOPLPUSH", "a", "b", "x"))).toBe(
      "ERR timeout is not a float or out of range",
    )
    expect(await rejects(client.call("BRPOPLPUSH", "a", "b", "-1"))).toBe("ERR timeout is negative")
    expect(await rejects(client.call("BRPOPLPUSH", "a", "b"))).toBe(
      "ERR wrong number of arguments for 'brpoplpush' command",
    )
  })
})

describe("MSETNX, COPY and EXPIRETIME (#507)", () => {
  test("MSETNX sets nothing when any key exists and everything otherwise", async () => {
    const { client } = setup()
    await client.call("SET", "a", "1")
    expect(await client.call("MSETNX", "a", "1", "b", "2")).toBe(0)
    expect(await client.call("EXISTS", "b")).toBe(0)
    expect(await client.call("MSETNX", "c", "1", "d", "2")).toBe(1)
    expect(await client.call("MGET", "c", "d")).toEqual(["1", "2"])
    expect(await rejects(client.call("MSETNX", "k"))).toBe(
      "ERR wrong number of arguments for 'msetnx' command",
    )
  })

  test("COPY keeps the value and TTL, refuses an existing destination unless REPLACE", async () => {
    const { client } = setup()
    await client.call("SET", "a", "1", "EX", "100")
    expect(await client.call("COPY", "a", "a2")).toBe(1)
    expect(await client.call("GET", "a2")).toBe("1")
    expect(await client.call("TTL", "a2")).toBe(100)
    expect(await client.call("COPY", "a", "a2")).toBe(0)
    await client.call("SET", "a", "2")
    expect(await client.call("COPY", "a", "a2", "REPLACE")).toBe(1)
    expect(await client.call("GET", "a2")).toBe("2")
    expect(await client.call("TTL", "a2")).toBe(-1)
    expect(await client.call("COPY", "missing", "x")).toBe(0)
  })

  test("COPY is deep, copies any type, and DB moves it across databases", async () => {
    const { client } = setup()
    await client.call("RPUSH", "l", "a", "b")
    expect(await client.call("COPY", "l", "l2")).toBe(1)
    await client.call("RPUSH", "l", "c")
    expect(await client.call("LRANGE", "l2", "0", "-1")).toEqual(["a", "b"])
    expect(await client.call("COPY", "l", "l3", "DB", "2")).toBe(1)
    expect(await client.call("EXISTS", "l3")).toBe(0)
    await client.call("SELECT", "2")
    expect(await client.call("LRANGE", "l3", "0", "-1")).toEqual(["a", "b", "c"])
    expect(await rejects(client.call("COPY", "l3", "l3"))).toBe(
      "ERR source and destination objects are the same",
    )
    expect(await rejects(client.call("COPY", "l3", "x", "DB", "99"))).toBe(
      "ERR DB index is out of range",
    )
    expect(await rejects(client.call("COPY", "l3", "x", "BOGUS"))).toBe("ERR syntax error")
  })

  test("EXPIRETIME and PEXPIRETIME report the absolute expiry, -1 and -2", async () => {
    const { client } = setup()
    await client.call("SET", "a", "1")
    expect(await client.call("EXPIRETIME", "a")).toBe(-1)
    expect(await client.call("PEXPIRETIME", "a")).toBe(-1)
    await client.call("PEXPIREAT", "a", "4102444800123")
    expect(await client.call("EXPIRETIME", "a")).toBe(4102444800)
    expect(await client.call("PEXPIRETIME", "a")).toBe(4102444800123)
    expect(await client.call("EXPIRETIME", "missing")).toBe(-2)
    expect(await client.call("PEXPIRETIME", "missing")).toBe(-2)
  })
})

describe("HEXPIRE (#507)", () => {
  test("sets a per-field TTL: [1], then the field is gone once the clock passes it", async () => {
    const { redis, client } = setup()
    await client.call("HSET", "h", "f1", "v1", "f2", "v2")
    expect(await client.call("HEXPIRE", "h", "100", "FIELDS", "1", "f1")).toEqual([1])
    expect(await client.call("HTTL", "h", "FIELDS", "2", "f1", "f2")).toEqual([100, -1])
    redis.advance(101_000)
    expect(await client.call("HGETALL", "h")).toEqual(["f2", "v2"])
  })

  test("per-field results: missing field -2, condition not met 0, past time 2; missing key -2", async () => {
    const { client } = setup()
    await client.call("HSET", "h", "f1", "v1", "f2", "v2")
    expect(await client.call("HEXPIRE", "h", "100", "FIELDS", "2", "f1", "nope")).toEqual([1, -2])
    expect(await client.call("HEXPIRE", "h", "50", "GT", "FIELDS", "1", "f1")).toEqual([0])
    expect(await client.call("HEXPIRE", "h", "200", "XX", "FIELDS", "1", "f2")).toEqual([0])
    expect(await client.call("HEXPIRE", "h", "0", "FIELDS", "1", "f2")).toEqual([2])
    expect(await client.call("HEXPIRE", "gone", "10", "FIELDS", "1", "f")).toEqual([-2])
  })

  test("argument errors", async () => {
    const { client } = setup()
    await client.call("HSET", "h", "f1", "v1")
    expect(await rejects(client.call("HEXPIRE", "h", "10", "FIELDS", "2", "f1"))).toBe(
      "ERR The `numfields` parameter must match the number of arguments",
    )
    expect(await rejects(client.call("HEXPIRE", "h", "10", "NOFIELDS", "1", "f1"))).toBe(
      "ERR Mandatory argument FIELDS is missing or not at the right position",
    )
    expect(await rejects(client.call("HEXPIRE", "h", "x", "FIELDS", "1", "f1"))).toBe(
      "ERR value is not an integer or out of range",
    )
  })
})

describe("SLOWLOG (#507)", () => {
  test("the slow log never records: GET is empty, LEN is 0, RESET is OK", async () => {
    const { client } = setup()
    await client.call("SET", "k", "v")
    expect(await client.call("SLOWLOG", "GET")).toEqual([])
    expect(await client.call("SLOWLOG", "GET", "5")).toEqual([])
    expect(await client.call("SLOWLOG", "LEN")).toBe(0)
    expect(await client.call("SLOWLOG", "RESET")).toBe("OK")
    expect(await rejects(client.call("SLOWLOG", "GET", "-5"))).toBe(
      "ERR count should be greater than or equal to -1",
    )
    expect(await rejects(client.call("SLOWLOG", "NOPE"))).toBe(
      "ERR unknown subcommand 'NOPE'. Try SLOWLOG HELP.",
    )
  })
})

describe("ACL (#507)", () => {
  test("WHOAMI, USERS and LIST describe the configured users", async () => {
    const redis = createRedis({
      password: "pw",
      users: [{ name: "reader", password: "rpw", readOnly: true }],
    })
    const client = redis.client()
    await client.call("AUTH", "default", "pw")
    expect(await client.call("ACL", "WHOAMI")).toBe("default")
    expect(await client.call("ACL", "USERS")).toEqual(["default", "reader"])
    const list = (await client.call("ACL", "LIST")) as string[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatch(/^user default on sanitize-payload #[0-9a-f]{64} ~\* &\* \+@all$/)
    expect(list[1]).toMatch(
      /^user reader on sanitize-payload #[0-9a-f]{64} ~\* &\* \+@all -@write$/,
    )
    expect(list.join(" ")).not.toContain("rpw")
    const reader = redis.client()
    await reader.call("AUTH", "reader", "rpw")
    expect(await reader.call("ACL", "WHOAMI")).toBe("reader")
  })

  test("an open server has the nopass default user", async () => {
    const { client } = setup()
    expect(await client.call("ACL", "WHOAMI")).toBe("default")
    expect(await client.call("ACL", "LIST")).toEqual([
      "user default on nopass sanitize-payload ~* &* +@all",
    ])
  })

  test("rule-changing and auditing subcommands are explicit unsupported errors and change nothing", async () => {
    const { client } = setup()
    for (const sub of [
      "SETUSER",
      "GETUSER",
      "DELUSER",
      "CAT",
      "LOG",
      "GENPASS",
      "DRYRUN",
      "LOAD",
      "SAVE",
      "HELP",
    ]) {
      expect(await rejects(client.call("ACL", sub, "x"))).toBe(
        `ERR ACL ${sub} is not supported by the Mockingbird Redis emulator`,
      )
    }
    expect(await client.call("ACL", "USERS")).toEqual(["default"])
    expect(await rejects(client.call("ACL", "NOPE"))).toBe(
      "ERR unknown subcommand 'NOPE'. Try ACL HELP.",
    )
  })
})

describe("COMMAND (#507)", () => {
  test("COUNT is a positive integer and LIST names every command", async () => {
    const { client } = setup()
    const count = (await client.call("COMMAND", "COUNT")) as number
    expect(count).toBeGreaterThan(100)
    const names = (await client.call("COMMAND", "LIST")) as string[]
    expect(names).toHaveLength(count)
    expect(names).toContain("get")
    expect(names).toContain("hexpire")
  })

  test("INFO returns name, arity, flags and key positions; unknown names are null", async () => {
    const { client } = setup()
    const [get, nothing] = (await client.call("COMMAND", "INFO", "get", "nosuch")) as unknown[][]
    expect(get?.slice(0, 6)).toEqual(["get", 2, ["readonly", "fast"], 1, 1, 1])
    expect(nothing).toBeNull()
    expect(((await client.call("COMMAND", "INFO", "SET")) as unknown[][])[0]?.[0]).toBe("set")
  })

  test("DOCS describes a command", async () => {
    const { client } = setup()
    const docs = (await client.call("COMMAND", "DOCS", "get")) as unknown
    expect(JSON.stringify(docs)).toContain("get")
    expect(JSON.stringify(docs)).toContain("summary")
  })

  test("GETKEYS extracts key arguments", async () => {
    const { client } = setup()
    expect(await client.call("COMMAND", "GETKEYS", "SET", "a", "b")).toEqual(["a"])
    expect(await client.call("COMMAND", "GETKEYS", "MSET", "a", "1", "b", "2")).toEqual(["a", "b"])
    expect(await client.call("COMMAND", "GETKEYS", "ZUNIONSTORE", "out", "2", "x", "y")).toEqual([
      "out",
      "x",
      "y",
    ])
    expect(await client.call("COMMAND", "GETKEYS", "LMPOP", "2", "l1", "l2", "LEFT")).toEqual([
      "l1",
      "l2",
    ])
    expect(await client.call("COMMAND", "GETKEYS", "EVAL", "return 1", "1", "k")).toEqual(["k"])
    expect(await rejects(client.call("COMMAND", "GETKEYS", "PING"))).toBe(
      "ERR The command has no key arguments",
    )
    expect(await rejects(client.call("COMMAND", "GETKEYS", "NOSUCH", "x"))).toBe(
      "ERR Invalid command specified",
    )
    expect(await rejects(client.call("COMMAND", "GETKEYS", "GET"))).toBe(
      "ERR Invalid number of arguments specified for command",
    )
  })

  test("GETKEYSANDFLAGS and HELP are explicit unsupported errors", async () => {
    const { client } = setup()
    expect(await rejects(client.call("COMMAND", "GETKEYSANDFLAGS", "GET", "a"))).toBe(
      "ERR COMMAND GETKEYSANDFLAGS is not supported by the Mockingbird Redis emulator",
    )
    expect(await rejects(client.call("COMMAND", "HELP"))).toBe(
      "ERR COMMAND HELP is not supported by the Mockingbird Redis emulator",
    )
  })
})
