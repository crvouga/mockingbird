import { describe, expect, test } from "bun:test"
import { Queue, Worker } from "bullmq"
import { createRedis, manualClock, RedisReplyError } from "../src/index.ts"
import { serve } from "../src/server.ts"
import { sha1Hex } from "../src/sha1.ts"

// Expected values were observed on redis-server 8.4.0 running the same scripts; the error replies
// below keep the script digest Redis puts in them, which is the SHA-1 of the script text.

async function evalReply(script: string, ...rest: Array<string | number>): Promise<unknown> {
  const redis = createRedis()
  try {
    return await redis.client().call("EVAL", script, ...(rest.length === 0 ? [0] : rest))
  } finally {
    redis.close()
  }
}

async function evalError(script: string, ...rest: Array<string | number>): Promise<string> {
  const redis = createRedis()
  try {
    await redis.client().call("EVAL", script, ...(rest.length === 0 ? [0] : rest))
  } catch (error) {
    if (error instanceof RedisReplyError) return error.message
    throw error
  } finally {
    redis.close()
  }
  throw new Error("expected the script to fail")
}

/** CPU time of this process in ms, which a loaded machine inflates far less than wall time. */
function cpuMs(): number {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

function scriptFailure(script: string, message: string, line = 1): string {
  return `${message} script: ${sha1Hex(Buffer.from(script))}, on @user_script:${line}.`
}

describe("Lua string library (issue #497)", () => {
  const cases: Array<[string, string, unknown]> = [
    ["string.match with a capture", "return string.match('5000:c::a', '^(%d+):')", "5000"],
    ["string.match without a capture", "return string.match('abc', 'b')", "b"],
    [
      "string.gmatch",
      "local n = 0 for _ in string.gmatch('a b c', '%a') do n = n + 1 end return n",
      3,
    ],
    ["string.gsub", "return (string.gsub('a-b', '-', '_'))", "a_b"],
    ["string.format %.0f", "return string.format('%.0f', 1.5e12)", "1500000000000"],
    ["string.format %05.1f", "return string.format('%05.1f', 3.14159)", "003.1"],
    ["string.format %d-%s", "return string.format('%d-%s', 5, 'x')", "5-x"],
    ["method call on a string", "return ('abc'):upper()", "ABC"],
    [
      "string.format with every flag",
      "return string.format('%5.2f|%-5d|%+d|%x|%5s|%-5s|%c|%e|%g|%%', 3.14159, 42, 5, 255, 'ab', 'cd', 65, 12345.678, 0.0001)",
      " 3.14|42   |+5|ff|   ab|cd   |A|1.234568e+04|0.0001|%",
    ],
    [
      "string.format integer conversions",
      "return string.format('%i|%u|%o|%X|%#x|%03d|% d|%.3d', 5, 5, 8, 255, 255, 7, 5, 7)",
      "5|5|10|FF|0xff|007| 5|007",
    ],
    [
      "string.format rounds half to even on the exact value",
      "return string.format('%.0f %.0f %.0f', 0.5, 1.5, 2.5)",
      "0 2 2",
    ],
    ["string.format truncates %d", "return string.format('%d', 3.7)", "3"],
    ["string.format %10.3s", "return string.format('%10.3s|', 'abcdef')", "       abc|"],
    ["string.format %q", "return string.format('%q','a\"b')", '"a\\"b"'],
    [
      "gsub with captures",
      "return (string.gsub('hello world', '(%w+)', '<%1>'))",
      "<hello> <world>",
    ],
    ["gsub with a replacement table", "return (string.gsub('hello', 'l', {l = 'L'}))", "heLLo"],
    [
      "gsub with a function",
      "return (string.gsub('hello', '(l)', function(c) return c:upper() end))",
      "heLLo",
    ],
    ["gsub counts replacements", "return select(2, string.gsub('hello world', 'o', '0'))", 2],
    ["gsub with an anchor", "return (string.gsub('hello', '^h', 'J'))", "Jello"],
    ["gsub with an empty pattern", "return (string.gsub('abc', '', '-'))", "-a-b-c-"],
    [
      "gmatch with two captures",
      "local r = {} for a, b in string.gmatch('k1=v1, k2=v2', '(%w+)=(%w+)') do r[#r+1] = a .. ':' .. b end return r",
      ["k1:v1", "k2:v2"],
    ],
    ["find with captures", "return {string.find('hello', '(l)(l)')}", [3, 4, "l", "l"]],
    ["find plain", "return {string.find('a.b', '.', 1, true)}", [2, 2]],
    ["match with position captures", "return {string.match('abc', '()b()')}", [2, 3]],
    ["match with a balanced pattern", "return string.match('f(a(b)c)d', '%b()')", "(a(b)c)"],
    [
      "match with a frontier pattern",
      "return string.match('THE (quick) fox', '%f[%a]%a+', 5)",
      "quick",
    ],
    ["match trims whitespace", "return string.match('  trim  ', '^%s*(.-)%s*$')", "trim"],
    ["sub with negative indexes", "return string.sub('abcdef', -3, -2)", "de"],
    ["byte over a range", "return {string.byte('abc', 1, -1)}", [97, 98, 99]],
    ["rep", "return ('x'):rep(3)", "xxx"],
  ]
  for (const [name, script, expected] of cases) {
    test(name, async () => {
      expect(await evalReply(script)).toEqual(expected)
    })
  }

  test("a script that uses string.match and string.format keeps its writes and sets the expiry", async () => {
    const clock = manualClock(1_700_000_000_000)
    const redis = createRedis({ clock })
    const client = redis.client()
    const script =
      "local lifetime = tonumber(string.match(ARGV[1], '^(%d+):')) " +
      "redis.call('SET', KEYS[1], 'v') " +
      "redis.call('PEXPIREAT', KEYS[1], string.format('%.0f', tonumber(ARGV[2]) + lifetime)) " +
      "return lifetime"
    const now = redis.clock.now()
    expect(await client.call("EVAL", script, 1, "k", "5000:c::a", now + 100_000)).toBe(5000)
    expect(await client.call("GET", "k")).toBe("v")
    expect(await client.call("PTTL", "k")).toBe(105_000)
    redis.close()
  })

  test("malformed patterns raise Redis's messages", async () => {
    const unfinished = "return string.match('abc','(()')"
    expect(await evalError(unfinished)).toBe(
      scriptFailure(unfinished, "ERR user_script:1: unfinished capture"),
    )
    const trailing = "return string.match('abc', '%')"
    expect(await evalError(trailing)).toBe(
      scriptFailure(trailing, "ERR user_script:1: malformed pattern (ends with '%')"),
    )
    const badFormat = "return string.format('%y', 1)"
    expect(await evalError(badFormat)).toBe(
      scriptFailure(badFormat, "ERR user_script:1: invalid option '%y' to 'format'"),
    )
  })
})

describe("Lua base library and result conversion (issue #505)", () => {
  const cases: Array<[string, string, unknown]> = [
    ["pcall", "local ok = pcall(function() error('x') end) return tostring(ok)", "false"],
    [
      "xpcall",
      "return tostring((xpcall(function() error('x') end, function(m) return m end)))",
      "false",
    ],
    [
      "setmetatable",
      "local t = setmetatable({}, {__index = function(_, k) return k .. '!' end}) return t.x",
      "x!",
    ],
    ["getmetatable", "return type(getmetatable('abc'))", "table"],
    ["rawget", "return rawget({a = 1}, 'a')", 1],
    ["table.sort", "local t = {3, 1, 2} table.sort(t) return t", [1, 2, 3]],
    ["table.getn", "return table.getn({1, 2, 3})", 3],
    ["table.unpack is absent, as in Redis", "return type(table.unpack)", "nil"],
    ["math.sqrt", "return math.sqrt(16)", 4],
    ["math.fmod", "return math.fmod(7, 3)", 1],
    ["math.max, min, abs", "return {math.max(1, 5), math.min(2, 3), math.abs(-2)}", [5, 2, 2]],
    ["math.random", "return type(math.random())", "number"],
    ["math.pi", "return type(math.pi)", "number"],
    ["bit.band", "return bit.band(5, 3)", 1],
    ["bit.tohex", "return bit.tohex(255)", "000000ff"],
    ["os.clock", "return type(os.clock())", "number"],
    ["struct", "return type(struct)", "table"],
    ["repeat..until", "local i = 0 repeat i = i + 1 until i >= 3 return i", 3],
    ["tonumber with a base", "return tonumber('ff', 16)", 255],
    ["tonumber of a hex string", "return tonumber('0x10')", 16],
    ["a float return truncates", "return 3.7", 3],
    ["a negative float return truncates toward zero", "return -3.7", -3],
    ["floats in a returned table truncate", "return {1.5, 2.5}", [1, 2]],
    ["a returned table stops at the first nil", "return {1, 2, 3, nil, 5}", [1, 2, 3]],
    ["true becomes 1 and false becomes nil", "return {1 < 2, 2 < 1}", [1, null]],
    ["a table with an ok field is a status reply", "return {ok = 'FINE'}", "FINE"],
    ["os has only clock", "return type(os.time)", "nil"],
    ["numbers return as integers beyond 2^53", "return 2^63", 9223372036854775807n],
  ]
  for (const [name, script, expected] of cases) {
    test(name, async () => {
      const actual = await evalReply(script)
      if (typeof expected === "bigint") expect(BigInt(actual as number | bigint)).toBe(expected)
      else expect(actual).toEqual(expected)
    })
  }

  test("the bit library follows LuaBitOp", async () => {
    expect(
      await evalReply("return {bit.bor(1, 2, 4), bit.bxor(5, 1), bit.lshift(1, 31), bit.bnot(0)}"),
    ).toEqual([7, 4, -2147483648, -1])
    expect(
      await evalReply(
        "return {bit.rshift(-1, 28), bit.arshift(-16, 2), bit.rol(1, 33), bit.ror(1, 1)}",
      ),
    ).toEqual([15, -4, 2, -2147483648])
    expect(
      await evalReply(
        "return {bit.tohex(-1), bit.tohex(255, -4), bit.tohex(255, 2), bit.bswap(1)}",
      ),
    ).toEqual(["ffffffff", "00FF", "ff", 16777216])
    expect(await evalReply("return {bit.tobit(2^32 + 5), bit.tobit(2.5), bit.tobit(3.5)}")).toEqual(
      [5, 2, 4],
    )
  })

  test("the struct library packs and unpacks binary data", async () => {
    expect(await evalReply("return {struct.pack('>I2', 258):byte(1, -1)}")).toEqual([1, 2])
    expect(await evalReply("return {struct.pack('<i4', -2):byte(1, -1)}")).toEqual([
      254, 255, 255, 255,
    ])
    expect(
      await evalReply("return {struct.unpack('<i4 b', struct.pack('<i4 b', -2, -3))}"),
    ).toEqual([-2, -3, 6])
    expect(await evalReply("return struct.size('>I2 i4 b')")).toBe(7)
    expect(await evalReply("return {struct.unpack('s', struct.pack('s', 'hello'))}")).toEqual([
      "hello",
      7,
    ])
    expect(await evalReply("return tostring((struct.unpack('d', struct.pack('d', 1.5))))")).toBe(
      "1.5",
    )
  })

  test("math, table and tonumber follow Lua 5.1", async () => {
    expect(await evalReply("return {math.floor(2.5), math.ceil(2.1), math.modf(-2.5)}")).toEqual([
      2, 3, -2, 0,
    ])
    expect(await evalReply("return {math.frexp(8)}")).toEqual([0, 4])
    expect(await evalReply("return {7 % -3, -7 % 3, math.fmod(-7, 3)}")).toEqual([-2, 2, -1])
    expect(
      await evalReply(
        "local t = {5, 2, 8, 1} table.sort(t, function(a, b) return a > b end) return t",
      ),
    ).toEqual([8, 5, 2, 1])
    expect(await evalReply("local t = {1, 2, 3} table.insert(t, 2, 99) return t")).toEqual([
      1, 99, 2, 3,
    ])
    expect(await evalReply("local t = {1, 2, 3} return {table.remove(t, 1), #t}")).toEqual([1, 2])
    expect(await evalReply("return table.concat({1, 2, 3}, '-', 2, 3)")).toBe("2-3")
    expect(
      await evalReply("return {tonumber('10', 2), tonumber('z', 36), tonumber(' 12 ')}"),
    ).toEqual([2, 35, 12])
    expect(await evalReply("return tonumber('1 2')")).toBeNull()
    expect(await evalReply("return {select('#', 1, nil, nil), select(-1, 1, 2, 3)}")).toEqual([
      3, 3,
    ])
    expect(await evalReply("return {unpack({1, 2, 3}, 2)}")).toEqual([2, 3])
  })

  test("closures, varargs, metamethods and loops follow Lua 5.1", async () => {
    expect(
      await evalReply(
        "local fns = {} for i = 1, 3 do fns[i] = function() return i end end return {fns[1](), fns[2](), fns[3]()}",
      ),
    ).toEqual([1, 2, 3])
    expect(
      await evalReply(
        "local function counter() local c = 0 return function() c = c + 1 return c end end local a = counter() a() a() return a()",
      ),
    ).toBe(3)
    expect(
      await evalReply("local function f(...) return select('#', ...) end return f(nil, nil, nil)"),
    ).toBe(3)
    expect(
      await evalReply(
        "local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end return fib(20)",
      ),
    ).toBe(6765)
    expect(
      await evalReply(
        "local mt = {__add = function() return 42 end} return setmetatable({}, mt) + 1",
      ),
    ).toBe(42)
    expect(
      await evalReply(
        "local mt = {__call = function(self, x) return x + 1 end} return setmetatable({}, mt)(1)",
      ),
    ).toBe(2)
    expect(
      await evalReply(
        "local mt = {__tostring = function() return 'T!' end} return tostring(setmetatable({}, mt))",
      ),
    ).toBe("T!")
    expect(
      await evalReply(
        "local t = setmetatable({}, {__newindex = function(t, k, v) rawset(t, k, v * 2) end}) t.x = 4 return t.x",
      ),
    ).toBe(8)
    expect(await evalReply("local s = 0 for i = 10, 1, -3 do s = s + i end return s")).toBe(22)
    expect(
      await evalReply(
        "local s = 0 for i = 1, 3 do for j = 1, 3 do if j == 2 then break end s = s + 1 end end return s",
      ),
    ).toBe(3)
    expect(await evalReply("return loadstring('return 1 + 1')()")).toBe(2)
    expect(await evalReply("return 'a\\65\\066' .. [[x]] .. [==[a]]b]==]")).toBe("aABxa]]b")
  })

  test("scripts cannot create globals or touch library tables, and unknown globals fail", async () => {
    const assign = "x = 1 return 1"
    expect(await evalError(assign)).toBe(
      scriptFailure(assign, "ERR user_script:1: Attempt to modify a readonly table"),
    )
    const library = "string.foo = 1"
    expect(await evalError(library)).toBe(
      scriptFailure(library, "ERR user_script:1: Attempt to modify a readonly table"),
    )
    const missing = "return x.y"
    expect(await evalError(missing)).toBe(
      scriptFailure(
        missing,
        "ERR user_script:1: Script attempted to access nonexistent global variable 'x'",
      ),
    )
    expect(await evalReply("return type(_G)")).toBe("table")
    expect(await evalReply("return rawget(_G, 'nope')")).toBeNull()
  })

  test("runtime errors name the variable like Lua 5.1 and carry the script digest and line", async () => {
    const cases: Array<[string, string]> = [
      ["local a; a()", "attempt to call local 'a' (a nil value)"],
      ["local t = {} t.x()", "attempt to call field 'x' (a nil value)"],
      ["local t = {} t:m()", "attempt to call method 'm' (a nil value)"],
      ["local a; return a + 1", "attempt to perform arithmetic on local 'a' (a nil value)"],
      ["local t = {} return t.x + 1", "attempt to perform arithmetic on field 'x' (a nil value)"],
      ["return 1 + {}", "attempt to perform arithmetic on a table value"],
      ["local a; return a .. 'x'", "attempt to concatenate local 'a' (a nil value)"],
      ["return 1 < 'x'", "attempt to compare number with string"],
      ["return {} < {}", "attempt to compare two table values"],
      ["local a; return #a", "attempt to get length of local 'a' (a nil value)"],
      ["local t = {} t[nil] = 1", "table index is nil"],
      ["for i = 1, 'x' do end", "'for' limit must be a number"],
      ["return math.floor('a')", "bad argument #1 to 'floor' (number expected, got string)"],
      ["return math.floor()", "bad argument #1 to 'floor' (number expected, got no value)"],
      [
        "return setmetatable(1, {})",
        "bad argument #1 to 'setmetatable' (table expected, got number)",
      ],
      ["return assert(false)", "assertion failed!"],
      ["return assert(false, 'msg')", "msg"],
      ["error('boom')", "boom"],
      ["local function f() return 1 + f() end return f()", "stack overflow"],
    ]
    for (const [script, message] of cases) {
      expect(await evalError(script)).toBe(scriptFailure(script, `ERR user_script:1: ${message}`))
    }
    const second = "local a = 1\nlocal b = a + nil"
    expect(await evalError(second)).toBe(
      scriptFailure(second, "ERR user_script:2: attempt to perform arithmetic on a nil value", 2),
    )
  })

  test("pcall returns the error value and error tables flatten to their message", async () => {
    expect(await evalReply("local ok, e = pcall(function() error('x') end) return e")).toBe(
      "user_script:1: x",
    )
    expect(await evalReply("local ok, e = pcall(error, 'x') return e")).toBe("x")
    expect(
      await evalReply("local ok, e = pcall(function() local a = nil; return a.b end) return e"),
    ).toBe("user_script:1: attempt to index local 'a' (a nil value)")
    expect(await evalReply("local ok, e = pcall(redis.call, 'nosuch') return e")).toBe(
      "ERR Unknown Redis command called from script",
    )
    expect(await evalReply("return {pcall(function() return 1, 2 end)}")).toEqual([1, 1, 2])
  })

  test("syntax errors use Lua's wording and are not cached", async () => {
    const cases: Array<[string, string]> = [
      ["local a = ", "unexpected symbol near '<eof>'"],
      ["if x then", "'end' expected near '<eof>'"],
      ["return 1 2", "'<eof>' expected near '2'"],
      ["break", "no loop to break near '<eof>'"],
      ["return 1..2", "malformed number near '1..2'"],
      ["goto x", "'=' expected near 'x'"],
      ["local function end", "'<name>' expected near 'end'"],
    ]
    for (const [script, message] of cases) {
      expect(await evalError(script)).toBe(
        `ERR Error compiling script (new function): user_script:1: ${message}`,
      )
    }
    const redis = createRedis()
    const client = redis.client()
    await expect(client.call("EVAL", "return +", 0)).rejects.toThrow("Error compiling script")
    expect(await client.call("SCRIPT", "EXISTS", sha1Hex(Buffer.from("return +")))).toEqual([0])
    await expect(client.call("SCRIPT", "LOAD", "return +")).rejects.toThrow(
      "Error compiling script",
    )
    expect(await client.call("SCRIPT", "EXISTS", sha1Hex(Buffer.from("return +")))).toEqual([0])
    redis.close()
  })
})

describe("cjson, cmsgpack and redis.* from scripts", () => {
  test("cjson encodes and decodes like lua-cjson", async () => {
    expect(await evalReply("return cjson.encode({1, 2, 3})")).toBe("[1,2,3]")
    expect(await evalReply("return cjson.encode({})")).toBe("{}")
    expect(await evalReply("return cjson.encode({1, 2, nil, 4})")).toBe("[1,2,null,4]")
    expect(await evalReply("return cjson.encode('a/b\"c\\\\\\n\\1')")).toBe(
      '"a\\/b\\"c\\\\\\n\\u0001"',
    )
    expect(
      await evalReply("return cjson.encode({1.5, 100000000000000, 0.1, 12345678901234567})"),
    ).toBe("[1.5,1e+14,0.1,1.2345678901235e+16]")
    expect(await evalReply('return cjson.encode(cjson.decode(\'{"a":[1,2,{"b":null}]}\'))')).toBe(
      '{"a":[1,2,{"b":null}]}',
    )
    expect(await evalReply("return cjson.decode('[1,2,{\"a\":null}]')[3].a == cjson.null")).toBe(1)
    expect(await evalReply("return cjson.decode('\"\\\\u00e9\\\\ud83d\\\\ude00\"')")).toBe("é😀")
    expect(await evalReply("return cjson.encode(cjson.decode('[]'))")).toBe("{}")
    const sparse = "return cjson.encode({[1] = 1, [20] = 2})"
    expect(await evalError(sparse)).toBe(
      scriptFailure(sparse, "ERR user_script:1: Cannot serialise table: excessively sparse array"),
    )
    const trailing = "return cjson.decode('[1,2,3]x')"
    expect(await evalError(trailing)).toBe(
      scriptFailure(
        trailing,
        "ERR user_script:1: Expected the end but found invalid token at character 8",
      ),
    )
    const empty = "return cjson.decode('')"
    expect(await evalError(empty)).toBe(
      scriptFailure(empty, "ERR user_script:1: Expected value but found T_END at character 1"),
    )
  })

  test("cmsgpack packs the bytes lua-cmsgpack does", async () => {
    const bytes = (expression: string) => evalReply(`return {(${expression}):byte(1, -1)}`)
    expect(await bytes("cmsgpack.pack({})")).toEqual([0x90])
    expect(await bytes("cmsgpack.pack(1.5)")).toEqual([0xca, 0x3f, 0xc0, 0, 0])
    expect(await bytes("cmsgpack.pack(0.1)")).toEqual([
      0xcb, 0x3f, 0xb9, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a,
    ])
    expect(await bytes("cmsgpack.pack(300)")).toEqual([0xcd, 1, 0x2c])
    expect(await bytes("cmsgpack.pack(-33)")).toEqual([0xd0, 0xdf])
    expect(await bytes("cmsgpack.pack({1, 2, 3})")).toEqual([0x93, 1, 2, 3])
    expect(await bytes("cmsgpack.pack({a = 1})")).toEqual([0x81, 0xa1, 0x61, 1])
    expect(await bytes("cmsgpack.pack({1, nil, 3})")).toEqual([0x82, 1, 1, 3, 3])
    expect(await bytes("cmsgpack.pack(1, 'a', true)")).toEqual([1, 0xa1, 0x61, 0xc3])
    expect(await bytes("cmsgpack.pack(2^64)")).toEqual([0xca, 0x5f, 0x80, 0, 0])
    expect(
      await bytes("cmsgpack.pack(string.rep('a', 40))").then((b) => (b as number[]).slice(0, 2)),
    ).toEqual([0xd9, 40])
    expect(
      await evalReply(
        "return cjson.encode({cmsgpack.unpack(cmsgpack.pack(-5, 70000, 3.25, 'str', true, false))})",
      ),
    ).toBe('[-5,70000,3.25,"str",true,false]')
    expect(await evalReply("return {cmsgpack.unpack_one(cmsgpack.pack(1, 2), 0)}")).toEqual([1, 1])
  })

  test("redis.call and redis.pcall convert replies the way Redis does", async () => {
    const redis = createRedis()
    const client = redis.client()
    const run = (script: string, ...rest: Array<string | number>) =>
      client.call("EVAL", script, ...rest)
    expect(await run("return redis.call('set', KEYS[1], 'v')", 1, "k")).toBe("OK")
    expect(await run("return type(redis.call('set', KEYS[1], 'v'))", 1, "k")).toBe("table")
    expect(await run("return redis.call('set', KEYS[1], 'v').ok", 1, "k")).toBe("OK")
    expect(await run("return redis.call('get', KEYS[1])", 1, "nokey")).toBeNull()
    expect(await run("return redis.call('get', KEYS[1]) == false", 1, "nokey")).toBe(1)
    expect(await run("return redis.call('rpush', KEYS[1], 'x', 'y')", 1, "l")).toBe(2)
    expect(await run("return redis.call('lrange', KEYS[1], 0, -1)", 1, "l")).toEqual(["x", "y"])
    expect(await run("return redis.call('set', KEYS[1], 3 / 2)", 1, "half")).toBe("OK")
    expect(await run("return redis.call('get', 'half')", 0)).toBe("1.5")
    expect(await run("return redis.pcall('incr', KEYS[1]).err", 1, "l")).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    )
    expect(await run("return type(redis.pcall('incr', KEYS[1]))", 1, "l")).toBe("table")
    expect(await run("return redis.pcall('foo').err", 0)).toBe(
      "ERR Unknown Redis command called from script",
    )
    expect(await run("return {redis.status_reply('S'), redis.sha1hex('abc')}", 0)).toEqual([
      "S",
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    ])
    expect(await run("return {err = 'E1'}", 0).catch((error: Error) => error.message)).toBe("E1")
    expect(
      await run("return redis.error_reply('My Error')", 0).catch((error: Error) => error.message),
    ).toBe("My Error")
    expect(await run("return {ARGV[1], ARGV[2], #ARGV, #KEYS}", 2, "k1", "k2", "a", "b")).toEqual([
      "a",
      "b",
      2,
      2,
    ])
    expect(await run("return {redis.REPL_ALL, redis.LOG_NOTICE}", 0)).toEqual([3, 2])
    const wrongType = "return redis.call('incr', KEYS[1])"
    await expect(run(wrongType, 1, "l")).rejects.toThrow(
      scriptFailure(wrongType, "WRONGTYPE Operation against a key holding the wrong kind of value"),
    )
    const unknown = "return redis.call('foo')"
    await expect(run(unknown, 0)).rejects.toThrow(
      scriptFailure(unknown, "ERR Unknown Redis command called from script"),
    )
    const arity = "return redis.call('get')"
    await expect(run(arity, 0)).rejects.toThrow(
      scriptFailure(arity, "ERR Wrong number of args calling Redis command from script"),
    )
    const badArgument = "return redis.call('get', {})"
    await expect(run(badArgument, 0)).rejects.toThrow(
      scriptFailure(badArgument, "ERR Lua redis lib command arguments must be strings or integers"),
    )
    const nested = "return redis.call('eval', 'return 1', 0)"
    await expect(run(nested, 0)).rejects.toThrow(
      scriptFailure(nested, "ERR This Redis command is not allowed from script"),
    )
    redis.close()
  })

  test("a failed script keeps the writes made before the error, as in Redis", async () => {
    const redis = createRedis()
    const client = redis.client()
    await expect(
      client.call("EVAL", "redis.call('set', KEYS[1], 'kept') local x = nil + 1", 1, "k"),
    ).rejects.toThrow("attempt to perform arithmetic")
    expect(await client.call("GET", "k")).toBe("kept")
    redis.close()
  })

  test("coroutines are reported as unsupported rather than silently missing", async () => {
    expect(await evalReply("return type(coroutine)")).toBe("table")
    const create = "return coroutine.create(function() end)"
    expect(await evalError(create)).toBe(
      scriptFailure(
        create,
        "ERR user_script:1: coroutine.create is not supported by this emulator's Lua runtime",
      ),
    )
  })
})

describe("Lua execution speed (issue #504)", () => {
  async function perCall(
    client: ReturnType<ReturnType<typeof createRedis>["client"]>,
    digest: string,
  ): Promise<number> {
    for (let i = 0; i < 20; i++) await client.call("EVALSHA", digest, 0)
    let best = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3; round++) {
      const start = cpuMs()
      for (let i = 0; i < 200; i++) await client.call("EVALSHA", digest, 0)
      best = Math.min(best, (cpuMs() - start) / 200)
    }
    return best
  }

  test("the cost of EVALSHA does not grow with the length of the script", async () => {
    const redis = createRedis()
    const client = redis.client()
    const small = (await client.call("SCRIPT", "LOAD", "return 1")) as string
    // A trivial body behind 200 KB of dead code and comments: parsing it again per call would show.
    const padding = "local unused = 1 -- ".concat("x".repeat(60), "\n").repeat(3000)
    const big = (await client.call("SCRIPT", "LOAD", `${padding}return 1`)) as string
    const huge = (await client.call("SCRIPT", "LOAD", `${padding.repeat(4)}return 1`)) as string
    const base = await perCall(client, small)
    const bigCost = await perCall(client, big)
    const hugeCost = await perCall(client, huge)
    // Locals are cheap to run once and free to look up; allow generous slack for a loaded machine.
    expect(bigCost).toBeLessThan(Math.max(base * 20, 0.3))
    expect(hugeCost).toBeLessThan(Math.max(base * 40, 0.6))
    redis.close()
  })

  test("a tight Lua loop runs at interpreter speed", async () => {
    const redis = createRedis()
    const client = redis.client()
    const script = "local s = 0 for i = 1, 10000 do s = s + i end return s"
    expect(await client.call("EVAL", script, 0)).toBe(50005000)
    const start = cpuMs()
    for (let i = 0; i < 200; i++) await client.call("EVAL", script, 0)
    // redis-server needs about 18 ms for 200 runs; the old tree walker needed 335 to 455.
    expect(cpuMs() - start).toBeLessThan(250)
    redis.close()
  })

  test("BullMQ adds and drains 2000 jobs without per-call script overhead", async () => {
    const redis = createRedis()
    const server = await serve(redis as never, { port: 0 })
    const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
    const queue = new Queue("perf", { connection })
    try {
      const start = cpuMs()
      await queue.addBulk(Array.from({ length: 2000 }, (_, i) => ({ name: "j", data: { i } })))
      let done = 0
      await new Promise<void>((resolve) => {
        const worker = new Worker(
          "perf",
          async () => {
            done++
            if (done === 2000) setTimeout(() => worker.close().then(() => resolve()), 0)
          },
          { connection, concurrency: 20 },
        )
      })
      expect(done).toBe(2000)
      // About 0.6 s of CPU here; the old interpreter needed 4 to 6 s. CPU time, so a busy machine does not fail it.
      expect(cpuMs() - start).toBeLessThan(3000)
    } finally {
      await queue.close()
      await server.close()
      redis.close()
    }
  }, 20_000)
})
