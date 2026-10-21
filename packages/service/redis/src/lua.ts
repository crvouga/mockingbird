/**
 * The Lua 5.1 runtime behind EVAL / EVALSHA: the globals Redis gives a script (`redis`, `cjson`,
 * `cmsgpack`, `struct`, `bit`, the standard libraries) and a compile cache keyed by script digest.
 */

import { fromLatin1 } from "./bytes.ts"
import { cjsonLib } from "./lua/cjson.ts"
import { cmsgpackLib } from "./lua/cmsgpack.ts"
import { type Chunk, compileChunk, first } from "./lua/interp.ts"
import { LuaSyntaxError, parseChunk } from "./lua/parse.ts"
import {
  baseLib,
  bitLib,
  checkString,
  coroutineLib,
  freeze,
  makeLib,
  mathLib,
  osLib,
  stringLib,
  tableLib,
  tostringValue,
} from "./lua/stdlib.ts"
import { structLib } from "./lua/struct.ts"
import { LuaError, LuaTable, type LuaValue, pos, rtError } from "./lua/value.ts"
import { sha1Hex } from "./sha1.ts"

export { LuaError, LuaTable, type LuaValue }

/** What a script's `redis.call` and `redis.pcall` reach. `raise` is true for `redis.call`. */
export interface ScriptHost {
  call(args: LuaValue[], raise: boolean): LuaValue
}

/** A script that did not finish; `message` is the whole error reply, code first. */
export class ScriptFailure extends Error {}

/** The table Redis uses for an error reply: `{ err = message }`. */
export function errorTable(message: string): LuaTable {
  const table = new LuaTable()
  table.set("err", message)
  return table
}

/** Raise `message` from inside a script the way a failing `redis.call` does. */
export function raiseError(message: string): never {
  throw new LuaError(errorTable(message))
}

export function statusTable(message: string): LuaTable {
  const table = new LuaTable()
  table.set("ok", message)
  return table
}

interface RunState {
  host: ScriptHost | null
  version: string
}

const state: RunState = { host: null, version: "7.2.4" }

/** An error a `redis.*` function raises itself: a plain message, with no `user_script:N:` prefix. */
function libError(message: string): never {
  throw new LuaError(message)
}

function activeHost(): ScriptHost {
  if (state.host === null) rtError("redis.call() is only available while a script runs")
  return state.host
}

function chunkId(source: string, name: string | undefined): string {
  const label = name ?? source
  if (label.startsWith("=") || label.startsWith("@")) return label.slice(1)
  const newline = label.indexOf("\n")
  const room = 45
  if (newline < 0 && label.length < room) return `[string "${label}"]`
  const end = newline >= 0 ? Math.min(newline, room) : room
  return `[string "${label.slice(0, end)}..."]`
}

function redisLib(): LuaTable {
  const lib = makeLib({
    call: (...args: LuaValue[]) => activeHost().call(args, true),
    pcall: (...args: LuaValue[]) => activeHost().call(args, false),
    error_reply: (...args: LuaValue[]) => {
      if (args.length !== 1 || typeof args[0] !== "string") {
        libError("wrong number or type of arguments")
      }
      return errorTable(args[0])
    },
    status_reply: (...args: LuaValue[]) => {
      if (args.length !== 1 || typeof args[0] !== "string") {
        libError("wrong number or type of arguments")
      }
      return statusTable(args[0])
    },
    sha1hex: (...args: LuaValue[]) => {
      if (args.length !== 1) libError("wrong number of arguments")
      return sha1Hex(fromLatin1(checkString(args, 0, "sha1hex")))
    },
    log: (...args: LuaValue[]) => {
      if (args.length < 2) libError("redis.log() requires two arguments or more.")
      if (typeof args[0] !== "number") libError("First argument must be a number (log level).")
      if (args[0] < 0 || args[0] > 3) libError("Invalid debug level.")
      return []
    },
    replicate_commands: () => true,
    set_repl: (...args: LuaValue[]) => {
      if (args.length !== 1) libError("redis.set_repl() requires one argument.")
      const flags = args[0]
      if (typeof flags !== "number" || flags < 0 || flags > 3) {
        libError("Invalid replication flags. Use REPL_AOF, REPL_REPLICA, REPL_ALL or REPL_NONE.")
      }
      return []
    },
    setresp: (...args: LuaValue[]) => {
      if (args.length !== 1) libError("redis.setresp() requires one argument.")
      if (args[0] !== 2) {
        libError("redis.setresp(): only RESP2 replies are supported from scripts by this emulator")
      }
      return []
    },
    breakpoint: () => false,
    debug: () => [],
    LOG_DEBUG: 0,
    LOG_VERBOSE: 1,
    LOG_NOTICE: 2,
    LOG_WARNING: 3,
    REPL_NONE: 0,
    REPL_AOF: 1,
    REPL_SLAVE: 2,
    REPL_REPLICA: 2,
    REPL_ALL: 3,
  })
  const [major = 0, minor = 0, patch = 0] = state.version.split(".").map(Number)
  lib.set("REDIS_VERSION", state.version)
  lib.set("REDIS_VERSION_NUM", (major << 16) | (minor << 8) | patch)
  return freeze(lib)
}

function loadstring(globals: LuaTable) {
  return (...args: LuaValue[]) => {
    const source = checkString(args, 0, "loadstring")
    const name = typeof args[1] === "string" ? args[1] : undefined
    try {
      const chunk = compileChunk(parseChunk(source, chunkId(source, name)))
      return chunk.run(globals)
    } catch (error) {
      if (error instanceof LuaSyntaxError) return [undefined, error.message]
      throw error
    }
  }
}

let shared: LuaTable | null = null

/** The globals every script sees. Built once; scripts cannot change them. */
function globals(): LuaTable {
  if (shared !== null) return shared
  const g = new LuaTable()
  baseLib(g)
  g.set("string", stringLib())
  g.set("table", tableLib())
  g.set("math", mathLib())
  g.set("os", osLib())
  g.set("coroutine", coroutineLib())
  g.set("bit", bitLib())
  g.set("struct", structLib())
  g.set("cjson", cjsonLib())
  g.set("cmsgpack", cmsgpackLib())
  g.set("redis", redisLib())
  g.set("loadstring", loadstring(g))
  g.set("_G", g)
  const meta = new LuaTable()
  meta.set("__index", (_table: LuaValue, key: LuaValue) =>
    rtError(`Script attempted to access nonexistent global variable '${tostringValue(key)}'`),
  )
  g.meta = meta
  g.readonly = true
  shared = g
  return g
}

const CACHE_LIMIT = 1024
const cache = new Map<string, Chunk>()

function compile(source: string, sha: string): Chunk {
  const cached = cache.get(sha)
  if (cached !== undefined) return cached
  let chunk: Chunk
  try {
    chunk = compileChunk(parseChunk(source))
  } catch (error) {
    if (error instanceof LuaSyntaxError) {
      throw new ScriptFailure(`ERR Error compiling script (new function): ${error.message}`)
    }
    throw error
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(sha, chunk)
  return chunk
}

/** Compile `source` into the cache without running it; throws `ScriptFailure` on a syntax error. */
export function compileScript(source: string, sha: string): void {
  compile(source, sha)
}

function failure(error: unknown, sha: string): never {
  if (error instanceof ScriptFailure) throw error
  let line = pos.line
  let text: string
  if (error instanceof LuaError) {
    line = error.line
    const value = error.value
    if (value instanceof LuaTable) {
      const message = value.getStr("err")
      text = typeof message === "string" ? message : "ERR unknown error"
    } else text = `ERR ${tostringValue(value)}`
  } else if (error instanceof RangeError) {
    text = `ERR user_script:${line}: stack overflow`
  } else throw error
  throw new ScriptFailure(`${text} script: ${sha}, on @user_script:${line}.`)
}

/**
 * Run `source` (identified by its SHA-1 `sha`) with `KEYS` and `ARGV` set, and return the first
 * value it returns. Throws `ScriptFailure` with the error reply when the script fails.
 */
export function runScript(
  source: string,
  sha: string,
  keys: string[],
  argv: string[],
  host: ScriptHost,
  version?: string,
): LuaValue {
  const chunk = compile(source, sha)
  const g = globals()
  const previous = { host: state.host, keys: g.getStr("KEYS"), argv: g.getStr("ARGV") }
  const keysTable = new LuaTable()
  keysTable.arr = keys
  const argvTable = new LuaTable()
  argvTable.arr = argv
  g.set("KEYS", keysTable)
  g.set("ARGV", argvTable)
  state.host = host
  if (version !== undefined) state.version = version
  pos.line = 0
  try {
    return first(chunk.run(g)())
  } catch (error) {
    return failure(error, sha)
  } finally {
    state.host = previous.host
    g.set("KEYS", previous.keys)
    g.set("ARGV", previous.argv)
  }
}
