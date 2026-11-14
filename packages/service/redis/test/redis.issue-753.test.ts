import { describe, expect, test } from "bun:test"
import { createRedis, encodeReply, manualClock, RedisReplyError } from "../src/index.ts"
import type { Reply } from "../src/protocol.ts"

// Issue #753. Unless a comment says "best guess", every expected value here was observed against
// redis-server 7.4.12 (the `redis:7.4` Docker image) with the same commands, byte for byte.

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

/** The wire bytes a reply is written as for the client's protocol. */
const wire = async (
  client: ReturnType<ReturnType<typeof createRedis>["client"]>,
  ...command: string[]
) => {
  const [name = "", ...args] = command
  const reply: Reply = await client.raw(name, ...args)
  return Buffer.from(encodeReply(reply, client.protocol)).toString("latin1")
}

describe("XREVRANGE takes end then start (#753)", () => {
  test("XREVRANGE xs + - returns every entry, newest first", async () => {
    const { redis, client } = setup()
    const first = await client.call("XADD", "xs", "*", "a", "1")
    redis.advance(1)
    const second = await client.call("XADD", "xs", "*", "a", "1")
    expect(await client.call("XRANGE", "xs", "-", "+")).toEqual([
      [first, ["a", "1"]],
      [second, ["a", "1"]],
    ])
    expect(await client.call("XREVRANGE", "xs", "+", "-")).toEqual([
      [second, ["a", "1"]],
      [first, ["a", "1"]],
    ])
    redis.close()
  })

  test("incomplete, exclusive and invalid IDs, and COUNT, follow Redis", async () => {
    const { redis, client } = setup()
    await client.call("XADD", "xs", "1-1", "a", "1")
    await client.call("XADD", "xs", "1-2", "a", "2")
    await client.call("XADD", "xs", "2-0", "a", "3")
    const ids = (reply: unknown) => (reply as Array<[string]>).map(([id]) => id)
    expect(ids(await client.call("XRANGE", "xs", "1", "1"))).toEqual(["1-1", "1-2"])
    expect(ids(await client.call("XREVRANGE", "xs", "1", "1"))).toEqual(["1-2", "1-1"])
    expect(ids(await client.call("XREVRANGE", "xs", "2", "1"))).toEqual(["2-0", "1-2", "1-1"])
    expect(ids(await client.call("XREVRANGE", "xs", "1", "2"))).toEqual([])
    expect(ids(await client.call("XRANGE", "xs", "(1-1", "+"))).toEqual(["1-2", "2-0"])
    expect(ids(await client.call("XREVRANGE", "xs", "(2-0", "-"))).toEqual(["1-2", "1-1"])
    expect(ids(await client.call("XREVRANGE", "xs", "2-1", "1-1", "COUNT", "1"))).toEqual(["2-0"])
    expect(ids(await client.call("XRANGE", "xs", "18446744073709551615", "+"))).toEqual([])
    expect(await client.call("XREVRANGE", "xs", "+", "-", "COUNT", "0")).toBeNull()
    expect(await client.call("XRANGE", "xs", "-", "+", "COUNT", "-1")).toBeNull()
    for (const bad of [
      ["abc", "+"],
      ["(-", "+"],
      ["1-x", "+"],
    ])
      expect(await rejects(client.call("XRANGE", "xs", ...bad))).toBe(
        "ERR Invalid stream ID specified as stream command argument",
      )
    expect(
      await rejects(client.call("XRANGE", "xs", "(18446744073709551615-18446744073709551615", "+")),
    ).toBe("ERR invalid start ID for the interval")
    expect(await rejects(client.call("XRANGE", "xs", "-", "+", "FOO", "1"))).toBe(
      "ERR syntax error",
    )
    redis.close()
  })
})

describe("RESP3 sorted-set replies (#753)", () => {
  test("ZRANGE WITHSCORES after HELLO 3 is an array of [member, double] pairs", async () => {
    const { redis, client } = setup()
    await client.call("ZADD", "z", "1", "a", "2.5", "b")
    // RESP2 stays flat with bulk-string scores.
    expect(await wire(client, "ZRANGE", "z", "0", "-1", "WITHSCORES")).toBe(
      "*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n",
    )
    await client.call("HELLO", "3")
    const pairs = "*2\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n"
    const reversed = "*2\r\n*2\r\n$1\r\nb\r\n,2.5\r\n*2\r\n$1\r\na\r\n,1\r\n"
    expect(await wire(client, "ZRANGE", "z", "0", "-1", "WITHSCORES")).toBe(pairs)
    expect(await wire(client, "ZRANGE", "z", "0", "-1")).toBe("*2\r\n$1\r\na\r\n$1\r\nb\r\n")
    expect(await wire(client, "ZREVRANGE", "z", "0", "-1", "WITHSCORES")).toBe(reversed)
    expect(await wire(client, "ZRANGEBYSCORE", "z", "-inf", "+inf", "WITHSCORES")).toBe(pairs)
    expect(await wire(client, "ZREVRANGEBYSCORE", "z", "+inf", "-inf", "WITHSCORES")).toBe(reversed)
    expect(await client.call("ZRANGE", "z", "0", "-1", "WITHSCORES")).toEqual([
      ["a", 1],
      ["b", 2.5],
    ])
    redis.close()
  })

  test("scores are RESP3 doubles across the sorted-set family", async () => {
    const { redis, client } = setup()
    await client.call("HELLO", "3")
    await client.call("ZADD", "z", "1", "a", "2.5", "b")
    expect(await wire(client, "ZSCORE", "z", "b")).toBe(",2.5\r\n")
    expect(await wire(client, "ZMSCORE", "z", "a", "b", "c")).toBe("*3\r\n,1\r\n,2.5\r\n_\r\n")
    expect(await wire(client, "ZINCRBY", "z", "1", "a")).toBe(",2\r\n")
    expect(await wire(client, "ZADD", "z", "INCR", "1", "a")).toBe(",3\r\n")
    expect(await wire(client, "ZRANK", "z", "a", "WITHSCORE")).toBe("*2\r\n:1\r\n,3\r\n")
    // Without COUNT a pop is one flat pair; with COUNT it is an array of pairs.
    expect(await wire(client, "ZPOPMIN", "z")).toBe("*2\r\n$1\r\nb\r\n,2.5\r\n")
    expect(await wire(client, "ZPOPMIN", "z", "2")).toBe("*1\r\n*2\r\n$1\r\na\r\n,3\r\n")
    await client.call("ZADD", "z", "1", "a", "2", "b", "3", "c")
    expect(await wire(client, "ZPOPMAX", "z")).toBe("*2\r\n$1\r\nc\r\n,3\r\n")
    expect(await wire(client, "ZPOPMAX", "z", "5")).toBe(
      "*2\r\n*2\r\n$1\r\nb\r\n,2\r\n*2\r\n$1\r\na\r\n,1\r\n",
    )
    await client.call("ZADD", "z", "1", "a", "2", "b", "3", "c")
    expect(await wire(client, "ZUNION", "1", "z", "WITHSCORES")).toBe(
      "*3\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2\r\n*2\r\n$1\r\nc\r\n,3\r\n",
    )
    expect(await wire(client, "BZPOPMIN", "z", "0")).toBe("*3\r\n$1\r\nz\r\n$1\r\na\r\n,1\r\n")
    redis.close()
  })

  test("scripts and RESP2 keep flat replies; scores print as Redis formats doubles", async () => {
    const { redis, client } = setup()
    await client.call(
      "ZADD",
      "z",
      "1e20",
      "a",
      "1.5e-7",
      "b",
      "0.00001",
      "c",
      "123456789012345678",
      "d",
    )
    expect(await client.call("ZRANGE", "z", "0", "-1", "WITHSCORES")).toEqual([
      "b",
      "1.5e-7",
      "c",
      "0.00001",
      "d",
      "123456789012345680",
      "a",
      "1e+20",
    ])
    await client.call("HELLO", "3")
    expect(await wire(client, "ZSCORE", "z", "a")).toBe(",1e+20\r\n")
    // A script always sees RESP2 replies (Redis default, redis.setresp(2)).
    expect(
      await client.call(
        "EVAL",
        "return redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')",
        "1",
        "z",
      ),
    ).toEqual(["b", "1.5e-7"])
    redis.close()
  })
})

describe("RESP3 maps (#753 follow-up)", () => {
  test("HGETALL and CONFIG GET are maps after HELLO 3, flat pairs in RESP2", async () => {
    const { redis, client } = setup()
    await client.call("HSET", "h", "a", "1")
    expect(await wire(client, "HGETALL", "h")).toBe("*2\r\n$1\r\na\r\n$1\r\n1\r\n")
    await client.call("HELLO", "3")
    expect(await wire(client, "HGETALL", "h")).toBe("%1\r\n$1\r\na\r\n$1\r\n1\r\n")
    expect(await wire(client, "HGETALL", "nokey")).toBe("%0\r\n")
    expect(await wire(client, "CONFIG", "GET", "maxmemory")).toBe(
      "%1\r\n$9\r\nmaxmemory\r\n$1\r\n0\r\n",
    )
    expect(await client.call("EVAL", "return redis.call('HGETALL', KEYS[1])", "1", "h")).toEqual([
      "a",
      "1",
    ])
    redis.close()
  })
})

describe("keyspace notifications (#753)", () => {
  const listen = async (flags: string) => {
    const { redis, client } = setup()
    const sub = redis.client()
    const events: string[] = []
    sub.onPush((reply) => {
      if (reply.t !== "push" && reply.t !== "array") return
      const parts = (reply.v ?? []).map((part) =>
        part.t === "bulk" && part.v ? Buffer.from(part.v).toString("latin1") : "",
      )
      if (parts[0] === "pmessage") events.push(`${parts[2]} ${parts[3]}`)
    })
    expect(await client.call("CONFIG", "SET", "notify-keyspace-events", flags)).toBe("OK")
    await sub.call("PSUBSCRIBE", "__key*__:*")
    return { redis, client, events, take: () => events.splice(0) }
  }

  test("CONFIG SET / GET notify-keyspace-events normalises the flags like Redis", async () => {
    const { redis, client } = setup()
    const get = async () =>
      ((await client.call("CONFIG", "GET", "notify-keyspace-events")) as string[])[1]
    expect(await client.call("CONFIG", "GET", "notify-keyspace-events")).toEqual([
      "notify-keyspace-events",
      "",
    ])
    const cases: Array<[string, string]> = [
      ["Ex", "xE"],
      ["KEA", "AKE"],
      ["A", "A"],
      ["Kgx$lshzetdmn", "AKm"],
      ["KEAn", "AKE"],
      ["KEAnm", "AKEm"],
      ["Kzhslg$", "g$lshzK"],
      ["Ktxe", "xetK"],
      ["Ed", "dE"],
      ["En", "nE"],
      ["", ""],
    ]
    for (const [given, shown] of cases) {
      expect(await client.call("CONFIG", "SET", "notify-keyspace-events", given)).toBe("OK")
      expect(await get()).toBe(shown)
    }
    expect(await rejects(client.call("CONFIG", "SET", "notify-keyspace-events", "Q"))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'notify-keyspace-events') - Invalid event class character. Use 'Ag$lshzxeKEtmdn'.",
    )
    expect(await get()).toBe("")
    expect(await client.call("CONFIG", "SET", "notify-keyspace-events", "xE")).toBe("OK")
    expect(await client.call("CONFIG", "GET", "notify*")).toEqual(["notify-keyspace-events", "xE"])
    expect(
      await client.call(
        "CONFIG",
        "SET",
        "notify-keyspace-events",
        "KEA",
        "maxmemory-policy",
        "noeviction",
      ),
    ).toBe("OK")
    expect(await get()).toBe("AKE")
    expect(
      await rejects(
        client.call(
          "CONFIG",
          "SET",
          "notify-keyspace-events",
          "KEA",
          "notify-keyspace-events",
          "E",
        ),
      ),
    ).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'notify-keyspace-events') - duplicate parameter",
    )
    redis.close()
  })

  test("Ex delivers an expired keyevent when the injected clock passes a key's TTL", async () => {
    const { redis, client, take } = await listen("Ex")
    await client.call("SET", "lock", "v", "PX", "100")
    await client.call("SET", "other", "v")
    expect(take()).toEqual([])
    redis.advance(200)
    expect(take()).toEqual(["__keyevent@0__:expired lock"])
    expect(await client.call("GET", "lock")).toBeNull()
    expect(take()).toEqual([])
    redis.close()
  })

  test("with the wall clock, an expiring key fires without any further command", async () => {
    const redis = createRedis()
    const client = redis.client()
    const sub = redis.client()
    const events: string[] = []
    sub.onPush((reply) => {
      if (reply.t === "push")
        events.push(
          reply.v.map((p) => (p.t === "bulk" && p.v ? Buffer.from(p.v).toString() : "")).join(" "),
        )
    })
    await client.call("CONFIG", "SET", "notify-keyspace-events", "Ex")
    await sub.call("SUBSCRIBE", "__keyevent@0__:expired")
    events.length = 0
    await client.call("SET", "lock", "v", "PX", "20")
    await Bun.sleep(250)
    expect(events).toEqual(["message __keyevent@0__:expired lock"])
    redis.close()
  })

  test("KEA reports the events Redis 7.4 publishes for each command", async () => {
    const { redis, client, take } = await listen("KEA")
    const expectEvents = async (command: string[], events: string[]) => {
      const [name = "", ...args] = command
      await client.raw(name, ...args)
      const got = take().map((line) => line.replace(/^__key(space|event)@0__:/, "$1 "))
      const want = events.flatMap((spec) => {
        const [event, key] = spec.split(" ")
        return [`space ${key} ${event}`, `event ${event} ${key}`]
      })
      expect({ command: command.join(" "), got }).toEqual({ command: command.join(" "), got: want })
    }
    await expectEvents(["SET", "k", "v"], ["set k"])
    await expectEvents(["SET", "k", "v", "EX", "1"], ["set k", "expire k"])
    await expectEvents(["SET", "k", "v", "NX"], [])
    await expectEvents(["SETEX", "k3", "1", "v"], ["set k3", "expire k3"])
    await expectEvents(["GETEX", "k3", "PERSIST"], ["persist k3"])
    await expectEvents(["GETEX", "k3", "EX", "10"], ["expire k3"])
    await expectEvents(["GETEX", "k3"], [])
    await expectEvents(["EXPIRE", "k3", "-1"], ["del k3"])
    await expectEvents(["MSET", "a", "1", "b", "2"], ["set a", "set b"])
    await expectEvents(["INCR", "n"], ["incrby n"])
    await expectEvents(["DECRBY", "n", "2"], ["incrby n"])
    await expectEvents(["INCRBYFLOAT", "n", "1.5"], ["incrbyfloat n"])
    await expectEvents(["APPEND", "n", "x"], ["append n"])
    await expectEvents(["SETRANGE", "n", "0", "y"], ["setrange n"])
    await expectEvents(["GETSET", "n", "z"], ["set n"])
    await expectEvents(["GETDEL", "n"], ["del n"])
    await expectEvents(["DEL", "a", "b", "nope"], ["del a", "del b"])
    await client.call("SET", "d", "1")
    take()
    await expectEvents(["EXPIRE", "d", "100"], ["expire d"])
    await expectEvents(["PERSIST", "d"], ["persist d"])
    await expectEvents(["PERSIST", "d"], [])
    await expectEvents(["RENAME", "d", "e"], ["rename_from d", "rename_to e"])
    await expectEvents(["COPY", "e", "f"], ["copy_to f"])
    await expectEvents(["LPUSH", "l", "a", "b"], ["lpush l"])
    await expectEvents(["RPUSHX", "l", "y"], ["rpush l"])
    await expectEvents(["LPOP", "l"], ["lpop l"])
    await expectEvents(["LSET", "l", "0", "q"], ["lset l"])
    await expectEvents(["LTRIM", "l", "0", "0"], ["ltrim l"])
    await expectEvents(["LMOVE", "l", "l2", "LEFT", "RIGHT"], ["rpush l2", "lpop l", "del l"])
    await expectEvents(["BLPOP", "nolist", "l2", "0"], ["lpop l2", "del l2"])
    await expectEvents(["SADD", "s", "a", "b", "c"], ["sadd s"])
    await expectEvents(["SREM", "s", "a"], ["srem s"])
    await expectEvents(["SMOVE", "s", "s2", "c"], ["srem s", "sadd s2"])
    await expectEvents(["SUNIONSTORE", "su", "s", "s2"], ["sunionstore su"])
    await expectEvents(["SINTERSTORE", "si", "s", "s2"], [])
    await expectEvents(["HSET", "h", "a", "1"], ["hset h"])
    await expectEvents(["HSET", "h", "a", "1"], ["hset h"])
    await expectEvents(["HINCRBY", "h", "c", "1"], ["hincrby h"])
    await expectEvents(["HDEL", "h", "a", "c"], ["hdel h", "del h"])
    await expectEvents(["ZADD", "z", "1", "a", "2", "b"], ["zadd z"])
    await expectEvents(["ZADD", "z", "1", "a"], [])
    await expectEvents(["ZINCRBY", "z", "1", "a"], ["zincr z"])
    await expectEvents(["ZREM", "z", "a"], ["zrem z"])
    await expectEvents(["ZPOPMIN", "z"], ["zpopmin z", "del z"])
    await client.call("ZADD", "z", "1", "a", "2", "b", "3", "c")
    take()
    await expectEvents(["ZUNIONSTORE", "zu", "1", "z"], ["zunionstore zu"])
    await expectEvents(["ZINTERSTORE", "zi", "1", "z"], ["zinterstore zi"])
    await expectEvents(["ZRANGESTORE", "zr", "z", "0", "0"], ["zrangestore zr"])
    await expectEvents(["ZREMRANGEBYLEX", "z", "-", "+"], ["zremrangebylex z", "del z"])
    await expectEvents(["XADD", "x", "1-1", "a", "1"], ["xadd x"])
    await expectEvents(["XADD", "x", "MAXLEN", "1", "2-1", "a", "1"], ["xadd x", "xtrim x"])
    await expectEvents(["XDEL", "x", "2-1"], ["xdel x"])
    await expectEvents(["XTRIM", "x", "MAXLEN", "0"], [])
    await expectEvents(["XGROUP", "CREATE", "x", "g", "$"], ["xgroup-create x"])
    await expectEvents(["XGROUP", "DESTROY", "x", "g"], ["xgroup-destroy x"])
    await expectEvents(["SETBIT", "bits", "1", "1"], ["setbit bits"])
    await expectEvents(["PFADD", "hll", "a"], ["pfadd hll"])
    await expectEvents(["PFMERGE", "hll2", "hll"], ["pfadd hll2"])
    await expectEvents(["FLUSHDB"], [])
    redis.close()
  })

  test("a blocked pop served by a push reports the push first, then the pop", async () => {
    const { redis, client, take } = await listen("KEA")
    const blpop = redis.client().call("BLPOP", "bl", "0")
    const blmove = redis.client().call("BLMOVE", "src", "dst", "RIGHT", "LEFT", "0")
    const bzpopmax = redis.client().call("BZPOPMAX", "bz", "0")
    await Bun.sleep(5)
    const events = () => take().filter((line) => line.startsWith("__keyevent"))
    await client.call("LPUSH", "bl", "a")
    expect(await blpop).toEqual(["bl", "a"])
    expect(events()).toEqual([
      "__keyevent@0__:lpush bl",
      "__keyevent@0__:lpop bl",
      "__keyevent@0__:del bl",
    ])
    await client.call("RPUSH", "src", "a", "b")
    expect(await blmove).toBe("b")
    expect(events()).toEqual([
      "__keyevent@0__:rpush src",
      "__keyevent@0__:lpush dst",
      "__keyevent@0__:rpop src",
    ])
    await client.call("ZADD", "bz", "1", "a")
    expect(await bzpopmax).toEqual(["bz", "a", "1"])
    expect(events()).toEqual([
      "__keyevent@0__:zadd bz",
      "__keyevent@0__:zpopmax bz",
      "__keyevent@0__:del bz",
    ])
    redis.close()
  })

  test("new-key events (n) are opt-in and precede the command's event", async () => {
    const { redis, client, take } = await listen("KEn")
    await client.call("SET", "a", "1")
    await client.call("SET", "a", "2")
    await client.call("LPUSH", "l", "x")
    await client.call("COPY", "l", "l2")
    expect(take()).toEqual([
      "__keyspace@0__:a new",
      "__keyevent@0__:new a",
      "__keyspace@0__:l new",
      "__keyevent@0__:new l",
      "__keyspace@0__:l2 new",
      "__keyevent@0__:new l2",
    ])
    redis.close()
  })

  test("only the selected classes and channel kinds are published", async () => {
    const { redis, client, take } = await listen("Kl")
    await client.call("SET", "k", "v")
    await client.call("LPUSH", "l", "a")
    expect(take()).toEqual(["__keyspace@0__:l lpush"])
    await client.call("CONFIG", "SET", "notify-keyspace-events", "")
    await client.call("LPUSH", "l", "a")
    expect(take()).toEqual([])
    redis.close()
  })

  test("events carry the database number and reach SUBSCRIBE on the exact channel", async () => {
    const { redis, client } = setup()
    const sub = redis.client()
    const messages: string[] = []
    sub.onPush((reply) => {
      if (reply.t !== "push") return
      messages.push(
        reply.v
          .map((part) => (part.t === "bulk" && part.v ? Buffer.from(part.v).toString() : ""))
          .join(" "),
      )
    })
    await client.call("CONFIG", "SET", "notify-keyspace-events", "Ex")
    await sub.call("SUBSCRIBE", "__keyevent@2__:expired")
    messages.length = 0
    await client.call("SELECT", "2")
    await client.call("SET", "session", "v", "EX", "1")
    redis.advance(1000)
    expect(messages).toEqual(["message __keyevent@2__:expired session"])
    redis.close()
  })
})

describe("commands reported unknown (#753)", () => {
  test("TOUCH counts existing keys", async () => {
    const { redis, client } = setup()
    await client.call("SET", "a", "1")
    await client.call("SET", "b", "2")
    expect(await client.call("TOUCH", "a", "b", "c")).toBe(2)
    expect(await rejects(client.call("TOUCH"))).toBe(
      "ERR wrong number of arguments for 'touch' command",
    )
    redis.close()
  })

  test("LPUSHX / RPUSHX only push onto an existing list", async () => {
    const { redis, client } = setup()
    expect(await client.call("LPUSHX", "l", "x")).toBe(0)
    expect(await client.call("EXISTS", "l")).toBe(0)
    await client.call("LPUSH", "l", "a")
    expect(await client.call("LPUSHX", "l", "x", "y")).toBe(3)
    expect(await client.call("RPUSHX", "l", "z")).toBe(4)
    expect(await client.call("RPUSHX", "nol", "z")).toBe(0)
    await client.call("SET", "s", "1")
    expect(await rejects(client.call("LPUSHX", "s", "x"))).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
    expect(await client.call("LRANGE", "l", "0", "-1")).toEqual(["y", "x", "a", "z"])
    redis.close()
  })

  test("SUNIONSTORE / SINTERSTORE / SDIFFSTORE / SINTERCARD", async () => {
    const { redis, client } = setup()
    await client.call("SADD", "s1", "a", "b", "c")
    await client.call("SADD", "s2", "c", "d")
    expect(await client.call("SUNIONSTORE", "d", "s1", "s2")).toBe(4)
    expect(await client.call("SMEMBERS", "d")).toEqual(["a", "b", "c", "d"])
    expect(await client.call("SINTERSTORE", "d", "s1", "s2")).toBe(1)
    expect(await client.call("SDIFFSTORE", "d", "s1", "s2")).toBe(2)
    expect(await client.call("SMEMBERS", "d")).toEqual(["a", "b"])
    expect(await client.call("SINTERSTORE", "d", "s1", "nokey")).toBe(0)
    expect(await client.call("EXISTS", "d")).toBe(0)
    await client.call("SET", "str", "x")
    expect(await rejects(client.call("SUNIONSTORE", "d", "str"))).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
    expect(await client.call("SINTERCARD", "2", "s1", "s2")).toBe(1)
    expect(await client.call("SINTERCARD", "2", "s1", "s1", "LIMIT", "2")).toBe(2)
    redis.close()
  })

  test("ZINTERSTORE, ZUNION, ZINTER, ZDIFF, ZDIFFSTORE and ZINTERCARD", async () => {
    const { redis, client } = setup()
    await client.call("ZADD", "z1", "1", "a", "2", "b", "3", "c")
    await client.call("ZADD", "z2", "10", "b", "20", "c", "30", "d")
    await client.call("SADD", "s1", "a", "b", "c")
    expect(await client.call("ZINTERSTORE", "out", "2", "z1", "z2")).toBe(2)
    expect(await client.call("ZRANGE", "out", "0", "-1", "WITHSCORES")).toEqual([
      "b",
      "12",
      "c",
      "23",
    ])
    expect(
      await client.call(
        "ZINTERSTORE",
        "out",
        "2",
        "z1",
        "z2",
        "WEIGHTS",
        "2",
        "1",
        "AGGREGATE",
        "MAX",
      ),
    ).toBe(2)
    expect(await client.call("ZRANGE", "out", "0", "-1", "WITHSCORES")).toEqual([
      "b",
      "10",
      "c",
      "20",
    ])
    expect(await client.call("ZINTERSTORE", "out", "2", "z1", "s1")).toBe(3)
    expect(await client.call("ZRANGE", "out", "0", "-1", "WITHSCORES")).toEqual([
      "a",
      "2",
      "b",
      "3",
      "c",
      "4",
    ])
    expect(await rejects(client.call("ZINTERSTORE", "out", "0", "z1"))).toBe(
      "ERR at least 1 input key is needed for 'zinterstore' command",
    )
    expect(await rejects(client.call("ZINTERSTORE", "out", "3", "z1", "z2"))).toBe(
      "ERR syntax error",
    )
    expect(await client.call("ZDIFFSTORE", "out", "2", "z1", "z2")).toBe(1)
    expect(await client.call("ZRANGE", "out", "0", "-1", "WITHSCORES")).toEqual(["a", "1"])
    expect(await client.call("ZUNION", "2", "z1", "z2")).toEqual(["a", "b", "c", "d"])
    expect(await client.call("ZUNION", "2", "z1", "z2", "WITHSCORES")).toEqual([
      "a",
      "1",
      "b",
      "12",
      "c",
      "23",
      "d",
      "30",
    ])
    expect(await client.call("ZINTER", "2", "z1", "z2", "WITHSCORES")).toEqual([
      "b",
      "12",
      "c",
      "23",
    ])
    expect(await client.call("ZDIFF", "2", "z1", "z2")).toEqual(["a"])
    expect(await client.call("ZINTERCARD", "2", "z1", "z2")).toBe(2)
    expect(await client.call("ZINTERCARD", "2", "z1", "z2", "LIMIT", "1")).toBe(1)
    expect(await rejects(client.call("ZINTERCARD", "0", "z1"))).toBe(
      "ERR at least 1 input key is needed for 'zintercard' command",
    )
    expect(await rejects(client.call("ZINTERCARD", "2", "z1"))).toBe("ERR syntax error")
    expect(await rejects(client.call("ZPOPMIN", "z1", "-1"))).toBe(
      "ERR value is out of range, must be positive",
    )
    redis.close()
  })

  test("ZRANGESTORE, ZRANGEBYLEX, ZREVRANGEBYLEX, ZLEXCOUNT, ZREMRANGEBYLEX and ZRANGE BYLEX", async () => {
    const { redis, client } = setup()
    await client.call("ZADD", "z1", "1", "a", "2", "b", "3", "c")
    expect(await client.call("ZRANGESTORE", "dst", "z1", "0", "-1")).toBe(3)
    expect(await client.call("ZRANGE", "dst", "0", "-1", "WITHSCORES")).toEqual([
      "a",
      "1",
      "b",
      "2",
      "c",
      "3",
    ])
    expect(
      await client.call("ZRANGESTORE", "dst", "z1", "(1", "+inf", "BYSCORE", "LIMIT", "0", "1"),
    ).toBe(1)
    expect(await client.call("ZRANGE", "dst", "0", "-1", "WITHSCORES")).toEqual(["b", "2"])
    expect(await client.call("ZRANGESTORE", "dst", "z1", "5", "10")).toBe(0)
    expect(await client.call("EXISTS", "dst")).toBe(0)
    expect(await rejects(client.call("ZRANGESTORE", "dst", "z1", "0", "-1", "WITHSCORES"))).toBe(
      "ERR syntax error",
    )
    expect(await client.call("ZRANGESTORE", "dst", "z1", "[a", "[b", "BYLEX")).toBe(2)
    expect(await client.call("ZRANGE", "dst", "0", "-1")).toEqual(["a", "b"])
    await client.call("ZADD", "lex", "0", "a", "0", "b", "0", "c", "0", "d", "0", "e")
    expect(await client.call("ZRANGEBYLEX", "lex", "-", "+")).toEqual(["a", "b", "c", "d", "e"])
    expect(await client.call("ZRANGEBYLEX", "lex", "[b", "(d")).toEqual(["b", "c"])
    expect(await client.call("ZRANGEBYLEX", "lex", "(a", "[c", "LIMIT", "1", "5")).toEqual(["c"])
    expect(await rejects(client.call("ZRANGEBYLEX", "lex", "b", "c"))).toBe(
      "ERR min or max not valid string range item",
    )
    expect(await client.call("ZREVRANGEBYLEX", "lex", "+", "-")).toEqual(["e", "d", "c", "b", "a"])
    expect(await client.call("ZREVRANGEBYLEX", "lex", "[d", "(a")).toEqual(["d", "c", "b"])
    expect(await client.call("ZRANGE", "lex", "[b", "[d", "BYLEX")).toEqual(["b", "c", "d"])
    expect(await client.call("ZRANGE", "lex", "[d", "[b", "BYLEX", "REV")).toEqual(["d", "c", "b"])
    expect(await rejects(client.call("ZRANGE", "lex", "-", "+", "BYLEX", "WITHSCORES"))).toBe(
      "ERR syntax error, WITHSCORES not supported in combination with BYLEX",
    )
    expect(await client.call("ZLEXCOUNT", "lex", "[b", "+")).toBe(4)
    expect(await client.call("ZREMRANGEBYLEX", "lex", "[a", "(c")).toBe(2)
    expect(await client.call("ZRANGE", "lex", "0", "-1")).toEqual(["c", "d", "e"])
    expect(await client.call("ZRANGEBYLEX", "lex", "-", "+", "LIMIT", "0", "-1")).toEqual([
      "c",
      "d",
      "e",
    ])
    expect(await client.call("ZRANGEBYLEX", "lex", "-", "+", "LIMIT", "-1", "2")).toEqual([])
    expect(await rejects(client.call("ZRANGE", "z1", "0", "-1", "LIMIT", "0", "1"))).toBe(
      "ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX",
    )
    redis.close()
  })

  test("ZRANDMEMBER returns distinct members, with scores on request", async () => {
    const { redis, client } = setup()
    await client.call("ZADD", "z", "1", "a", "2", "b", "3", "c")
    expect(["a", "b", "c"]).toContain((await client.call("ZRANDMEMBER", "z")) as string)
    const picked = (await client.call("ZRANDMEMBER", "z", "2", "WITHSCORES")) as string[]
    expect(picked).toHaveLength(4)
    expect(new Set([picked[0], picked[2]]).size).toBe(2)
    expect(await client.call("ZRANDMEMBER", "z", "-5")).toHaveLength(5)
    expect(await client.call("ZRANDMEMBER", "nokey")).toBeNull()
    expect(await client.call("ZRANDMEMBER", "nokey", "2")).toEqual([])
    redis.close()
  })

  test("PFADD / PFCOUNT / PFMERGE (exact counts: best guess, real HLL is approximate)", async () => {
    const { redis, client } = setup()
    expect(await client.call("PFADD", "hll", "a", "b", "c")).toBe(1)
    expect(await client.call("PFADD", "hll", "a")).toBe(0)
    expect(await client.call("PFADD", "hll")).toBe(0)
    expect(await client.call("PFADD", "hll2")).toBe(1)
    expect(await client.call("PFCOUNT", "hll")).toBe(3)
    expect(await client.call("PFCOUNT", "hll", "nokey")).toBe(3)
    await client.call("PFADD", "hll3", "c", "d")
    expect(await client.call("PFCOUNT", "hll", "hll3")).toBe(4)
    expect(await client.call("PFMERGE", "hm", "hll", "hll3")).toBe("OK")
    expect(await client.call("PFCOUNT", "hm")).toBe(4)
    expect(await client.call("PFMERGE", "hm2")).toBe("OK")
    expect(await client.call("EXISTS", "hm2")).toBe(1)
    expect(await client.call("TYPE", "hll")).toBe("string")
    await client.call("SET", "s", "x")
    expect(await rejects(client.call("PFADD", "s", "a"))).toBe(
      "WRONGTYPE Key is not a valid HyperLogLog string value.",
    )
    expect(await rejects(client.call("PFCOUNT", "s"))).toBe(
      "WRONGTYPE Key is not a valid HyperLogLog string value.",
    )
    redis.close()
  })

  test("SETBIT / GETBIT / BITCOUNT", async () => {
    const { redis, client } = setup()
    expect(await client.call("SETBIT", "bk", "7", "1")).toBe(0)
    expect(await client.call("SETBIT", "bk", "7", "0")).toBe(1)
    expect(await client.call("SETBIT", "bk", "100", "1")).toBe(0)
    expect(await client.call("STRLEN", "bk")).toBe(13)
    const raw = await client.raw("GET", "bk")
    expect(raw.t === "bulk" && raw.v ? [...raw.v] : []).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8,
    ])
    expect(await client.call("GETBIT", "bk", "100")).toBe(1)
    expect(await client.call("GETBIT", "bk", "1000")).toBe(0)
    expect(await client.call("GETBIT", "nokey", "1")).toBe(0)
    expect(await rejects(client.call("SETBIT", "bk", "1", "2"))).toBe(
      "ERR bit is not an integer or out of range",
    )
    for (const offset of ["-1", "4294967296"])
      expect(await rejects(client.call("SETBIT", "bk", offset, "1"))).toBe(
        "ERR bit offset is not an integer or out of range",
      )
    expect(await client.call("BITCOUNT", "bk")).toBe(1)
    await client.call("SET", "bc", "foobar")
    expect(await client.call("BITCOUNT", "bc")).toBe(26)
    expect(await client.call("BITCOUNT", "bc", "0", "0")).toBe(4)
    expect(await client.call("BITCOUNT", "bc", "1", "1")).toBe(6)
    expect(await client.call("BITCOUNT", "bc", "1", "-1")).toBe(22)
    expect(await client.call("BITCOUNT", "bc", "5", "30", "BIT")).toBe(17)
    expect(await rejects(client.call("BITCOUNT", "bc", "0"))).toBe("ERR syntax error")
    expect(await client.call("BITCOUNT", "nokey")).toBe(0)
    redis.close()
  })

  test("WAIT on a server without replicas answers 0 at once", async () => {
    const { redis, client } = setup()
    expect(await client.call("WAIT", "0", "0")).toBe(0)
    expect(await client.call("WAIT", "1", "100")).toBe(0)
    expect(await rejects(client.call("WAIT", "x", "0"))).toBe(
      "ERR value is not an integer or out of range",
    )
    expect(await rejects(client.call("WAIT", "0", "-1"))).toBe("ERR timeout is negative")
    redis.close()
  })

  test("EVAL_RO / EVALSHA_RO run read-only scripts and refuse writes", async () => {
    const { redis, client } = setup()
    await client.call("SET", "a", "v")
    expect(await client.call("EVAL_RO", "return redis.call('GET', KEYS[1])", "1", "a")).toBe("v")
    expect(await client.call("EVAL_RO", "return 1", "0")).toBe(1)
    expect(
      await rejects(client.call("EVAL_RO", "return redis.call('SET','a','b')", "1", "a")),
    ).toBe(
      "ERR Write commands are not allowed from read-only scripts. script: 0a9f75e991483d02789696e4c90d26c10395863e, on @user_script:1.",
    )
    expect(await client.call("GET", "a")).toBe("v")
    expect(
      await rejects(
        client.call("EVALSHA_RO", "fb2c0a6be06d4bac4ada3b27f15c5a6f8a8f52ec", "1", "a"),
      ),
    ).toBe("NOSCRIPT No matching script. Please use EVAL.")
    // EVAL_RO cached `return 1` by its SHA-1, as EVAL does.
    expect(await client.call("EVALSHA_RO", "e0e1f9fabfc9d4800c877a703b823ac0578ff8db", "0")).toBe(1)
    redis.close()
  })

  test("FUNCTION LOAD / LIST / DELETE / FLUSH and FCALL / FCALL_RO", async () => {
    const { redis, client } = setup()
    const library = [
      "#!lua name=mylib",
      "redis.register_function('echo', function(keys, args) return {keys[1], args[1]} end)",
      "redis.register_function{function_name='ro', callback=function(keys, args) return redis.call('GET', keys[1]) end, flags={'no-writes'}, description='read'}",
      "redis.register_function('w', function(keys, args) return redis.call('SET', keys[1], args[1]) end)",
    ].join("\n")
    expect(await rejects(client.call("FCALL", "nofn", "0"))).toBe("ERR Function not found")
    expect(await rejects(client.call("FCALL_RO", "nofn", "0"))).toBe("ERR Function not found")
    expect(await client.call("FUNCTION", "LIST")).toEqual([])
    expect(await client.call("FUNCTION", "LOAD", library)).toBe("mylib")
    expect(await client.call("FCALL", "echo", "1", "k", "a")).toEqual(["k", "a"])
    expect(await client.call("FCALL", "ro", "1", "k")).toBeNull()
    expect(await client.call("FCALL", "w", "1", "k", "v")).toBe("OK")
    expect(await client.call("FCALL_RO", "ro", "1", "k")).toBe("v")
    expect(await rejects(client.call("FCALL_RO", "w", "1", "k", "v"))).toBe(
      "ERR Can not execute a script with write flag using *_ro command.",
    )
    expect(await rejects(client.call("FUNCTION", "LOAD", library))).toBe(
      "ERR Library 'mylib' already exists",
    )
    const load = (code: string) => client.call("FUNCTION", "LOAD", code)
    expect(await rejects(load("redis.register_function('x', function() return 1 end)"))).toBe(
      "ERR Missing library metadata",
    )
    expect(
      await rejects(load("#!lua\nredis.register_function('x', function() return 1 end)")),
    ).toBe("ERR Library name was not given")
    expect(
      await rejects(
        load("#!lua name=other\nredis.register_function('echo', function() return 1 end)"),
      ),
    ).toBe("ERR Function echo already exists")
    expect(await rejects(load("#!lua name=empty\nlocal x = 1"))).toBe("ERR No functions registered")
    expect(await rejects(load("#!lua name=syn\nthis is bad"))).toBe(
      "ERR Error compiling function: user_function:2: '=' expected near 'is'",
    )
    expect(
      await rejects(
        load(
          "#!lua name=dup\nredis.register_function('d', function() return 1 end)\nredis.register_function('d', function() return 1 end)",
        ),
      ),
    ).toBe("ERR Error registering functions: ERR Function already exists in the library")
    expect(
      await load(
        "#!lua name=err\nredis.register_function('boom', function() error('kaput') end)\nredis.register_function('boom2', function() return redis.call('NOPE') end)",
      ),
    ).toBe("err")
    expect(await rejects(client.call("FCALL", "boom", "0"))).toBe(
      "ERR user_function:2: kaput script: boom, on @user_function:2.",
    )
    expect(await rejects(client.call("FCALL", "boom2", "0"))).toBe(
      "ERR Unknown Redis command called from script script: boom2, on @user_function:3.",
    )
    expect(await rejects(client.call("FCALL", "echo", "2", "a"))).toBe(
      "ERR Number of keys can't be greater than number of args",
    )
    expect(await rejects(client.call("FCALL", "echo", "x"))).toBe("ERR Bad number of keys provided")
    expect(
      await client.call(
        "FUNCTION",
        "LOAD",
        "REPLACE",
        "#!lua name=mylib\nredis.register_function('echo2', function() return 2 end)",
      ),
    ).toBe("mylib")
    expect(await rejects(client.call("FCALL", "echo", "0"))).toBe("ERR Function not found")
    expect(await client.call("FCALL", "echo2", "0")).toBe(2)
    // The in-process client decodes the reply's maps; on the wire (RESP2) they are flat arrays.
    expect(await client.call("FUNCTION", "LIST", "WITHCODE", "LIBRARYNAME", "my*")).toEqual([
      {
        library_name: "mylib",
        engine: "LUA",
        functions: [{ name: "echo2", description: null, flags: [] }],
        library_code: "#!lua name=mylib\nredis.register_function('echo2', function() return 2 end)",
      },
    ])
    expect(await wire(client, "FUNCTION", "LIST", "LIBRARYNAME", "my*")).toBe(
      "*1\r\n*6\r\n$12\r\nlibrary_name\r\n$5\r\nmylib\r\n$6\r\nengine\r\n$3\r\nLUA\r\n$9\r\nfunctions\r\n*1\r\n*6\r\n$4\r\nname\r\n$5\r\necho2\r\n$11\r\ndescription\r\n$-1\r\n$5\r\nflags\r\n*0\r\n",
    )
    expect(await rejects(client.call("FUNCTION", "DELETE", "nope"))).toBe("ERR Library not found")
    expect(await client.call("FUNCTION", "DELETE", "err")).toBe("OK")
    expect(await client.call("FUNCTION", "FLUSH")).toBe("OK")
    expect(await client.call("FUNCTION", "LIST")).toEqual([])
    redis.close()
  })

  test("SPUBLISH / SSUBSCRIBE deliver on one node as sharded pub/sub", async () => {
    const { redis, client } = setup()
    expect(await client.call("SPUBLISH", "ch", "hi")).toBe(0)
    const sub = redis.client()
    const got: unknown[] = []
    sub.onPush((reply) => {
      if (reply.t === "push")
        got.push(
          reply.v.map((part) =>
            part.t === "bulk" && part.v
              ? Buffer.from(part.v).toString()
              : part.t === "int"
                ? Number(part.v)
                : null,
          ),
        )
    })
    expect(await sub.call("SSUBSCRIBE", "ch")).toEqual(["ssubscribe", "ch", 1])
    expect(await client.call("PUBSUB", "SHARDCHANNELS")).toEqual(["ch"])
    expect(await client.call("PUBSUB", "SHARDNUMSUB", "ch", "x")).toEqual(["ch", 1, "x", 0])
    // A plain PUBLISH does not reach a shard channel subscriber.
    expect(await client.call("PUBLISH", "ch", "plain")).toBe(0)
    expect(await client.call("SPUBLISH", "ch", "hi")).toBe(1)
    expect(got).toEqual([["smessage", "ch", "hi"]])
    expect(await sub.call("SUNSUBSCRIBE", "ch")).toEqual(["sunsubscribe", "ch", 0])
    expect(await client.call("SPUBLISH", "ch", "hi")).toBe(0)
    redis.close()
  })

  test("the new commands are listed in COMMAND INFO", async () => {
    const { redis, client } = setup()
    const names = [
      "touch",
      "lpushx",
      "rpushx",
      "sunionstore",
      "sinterstore",
      "sdiffstore",
      "sintercard",
      "zinterstore",
      "zunion",
      "zinter",
      "zdiff",
      "zdiffstore",
      "zintercard",
      "zrangestore",
      "zrangebylex",
      "zrevrangebylex",
      "zlexcount",
      "zremrangebylex",
      "zrandmember",
      "pfadd",
      "pfcount",
      "pfmerge",
      "setbit",
      "getbit",
      "bitcount",
      "wait",
      "eval_ro",
      "evalsha_ro",
      "fcall",
      "fcall_ro",
      "function",
      "spublish",
      "ssubscribe",
      "sunsubscribe",
    ]
    const infos = (await client.call("COMMAND", "INFO", ...names)) as unknown[][]
    expect(infos.map((info) => info?.[0] ?? null)).toEqual(names)
    redis.close()
  })
})
