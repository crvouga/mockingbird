/**
 * Keyspace notifications (`notify-keyspace-events`): the flag string `CONFIG SET` accepts and
 * `CONFIG GET` prints, and the events each write command publishes. Event names, classes and
 * their order were observed against redis-server 7.4.12; see `SUPPORT.md` for the events this
 * emulator does not publish.
 */
import { latin1 } from "./bytes.ts"
import type { Reply } from "./protocol.ts"

export const NOTIFY_KEYSPACE = 1 << 0
export const NOTIFY_KEYEVENT = 1 << 1
export const NOTIFY_GENERIC = 1 << 2
export const NOTIFY_STRING = 1 << 3
export const NOTIFY_LIST = 1 << 4
export const NOTIFY_SET = 1 << 5
export const NOTIFY_HASH = 1 << 6
export const NOTIFY_ZSET = 1 << 7
export const NOTIFY_EXPIRED = 1 << 8
export const NOTIFY_EVICTED = 1 << 9
export const NOTIFY_STREAM = 1 << 10
export const NOTIFY_KEY_MISS = 1 << 11
export const NOTIFY_MODULE = 1 << 13
export const NOTIFY_NEW = 1 << 14
/** `A`: every class except key-miss (`m`) and new-key (`n`). */
export const NOTIFY_ALL =
  NOTIFY_GENERIC |
  NOTIFY_STRING |
  NOTIFY_LIST |
  NOTIFY_SET |
  NOTIFY_HASH |
  NOTIFY_ZSET |
  NOTIFY_EXPIRED |
  NOTIFY_EVICTED |
  NOTIFY_STREAM |
  NOTIFY_MODULE

const CLASSES: Record<string, number> = {
  A: NOTIFY_ALL,
  g: NOTIFY_GENERIC,
  $: NOTIFY_STRING,
  l: NOTIFY_LIST,
  s: NOTIFY_SET,
  h: NOTIFY_HASH,
  z: NOTIFY_ZSET,
  x: NOTIFY_EXPIRED,
  e: NOTIFY_EVICTED,
  K: NOTIFY_KEYSPACE,
  E: NOTIFY_KEYEVENT,
  t: NOTIFY_STREAM,
  m: NOTIFY_KEY_MISS,
  d: NOTIFY_MODULE,
  n: NOTIFY_NEW,
}

/** Redis `keyspaceEventsStringToFlags`; null for a character that is not a class. */
export function parseNotifyFlags(value: string): number | null {
  let flags = 0
  for (const char of value) {
    const flag = CLASSES[char]
    if (flag === undefined) return null
    flags |= flag
  }
  return flags
}

/** Redis `keyspaceEventsFlagsToString`, including its quirk of dropping `n` next to `A`. */
export function formatNotifyFlags(flags: number): string {
  let out = ""
  if ((flags & NOTIFY_ALL) === NOTIFY_ALL) out += "A"
  else {
    const order: Array<[string, number]> = [
      ["g", NOTIFY_GENERIC],
      ["$", NOTIFY_STRING],
      ["l", NOTIFY_LIST],
      ["s", NOTIFY_SET],
      ["h", NOTIFY_HASH],
      ["z", NOTIFY_ZSET],
      ["x", NOTIFY_EXPIRED],
      ["e", NOTIFY_EVICTED],
      ["t", NOTIFY_STREAM],
      ["d", NOTIFY_MODULE],
      ["n", NOTIFY_NEW],
    ]
    for (const [char, flag] of order) if (flags & flag) out += char
  }
  if (flags & NOTIFY_KEYSPACE) out += "K"
  if (flags & NOTIFY_KEYEVENT) out += "E"
  if (flags & NOTIFY_KEY_MISS) out += "m"
  return out
}

/** What the engine records about a key before and after a command. */
export interface KeyState {
  exists: boolean
  gen: number
  /** Stream length, for `XADD` trimming. */
  size: number
}

export interface KeyEvent {
  cls: number
  event: string
  key: string
}

const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")
const hasOption = (args: Uint8Array[], ...names: string[]) =>
  args.some((arg) => names.includes(text(arg).toUpperCase()))
const intOf = (reply: Reply): number =>
  reply.t === "int" ? Number(reply.v) : reply.t === "bool" ? Number(reply.v) : 0

/** Commands whose keyspace effects publish events. */
export const NOTIFIED = new Set([
  "set",
  "setnx",
  "setex",
  "psetex",
  "getset",
  "mset",
  "msetnx",
  "getex",
  "getdel",
  "incr",
  "incrby",
  "decr",
  "decrby",
  "incrbyfloat",
  "append",
  "setrange",
  "setbit",
  "del",
  "unlink",
  "expire",
  "pexpire",
  "expireat",
  "pexpireat",
  "persist",
  "rename",
  "renamenx",
  "lpush",
  "rpush",
  "lpushx",
  "rpushx",
  "lpop",
  "rpop",
  "lset",
  "linsert",
  "lrem",
  "ltrim",
  "lmove",
  "rpoplpush",
  "blmove",
  "brpoplpush",
  "lmpop",
  "blpop",
  "brpop",
  "sadd",
  "srem",
  "spop",
  "smove",
  "sinterstore",
  "sunionstore",
  "sdiffstore",
  "hset",
  "hmset",
  "hsetnx",
  "hdel",
  "hincrby",
  "hincrbyfloat",
  "zadd",
  "zincrby",
  "zrem",
  "zpopmin",
  "zpopmax",
  "bzpopmin",
  "bzpopmax",
  "zremrangebyscore",
  "zremrangebyrank",
  "zremrangebylex",
  "zunionstore",
  "zinterstore",
  "zdiffstore",
  "zrangestore",
  "xadd",
  "xdel",
  "xtrim",
  "xgroup",
  "pfadd",
  "pfmerge",
])

/** The keys whose state decides a command's events. */
export function notifiedKeys(command: string, args: Uint8Array[]): string[] {
  switch (command) {
    case "mset":
    case "msetnx":
      return args.filter((_, index) => index % 2 === 0).map(text)
    case "del":
    case "unlink":
      return args.map(text)
    case "rename":
    case "renamenx":
    case "lmove":
    case "rpoplpush":
    case "blmove":
    case "brpoplpush":
    case "smove":
      return [text(args[0]), text(args[1])]
    case "lmpop": {
      const count = Number(text(args[0]))
      return Number.isInteger(count) && count > 0 ? args.slice(1, 1 + count).map(text) : []
    }
    case "blpop":
    case "brpop":
    case "bzpopmin":
    case "bzpopmax":
      return args.slice(0, -1).map(text)
    case "xgroup":
      return [text(args[1])]
    default:
      return [text(args[0])]
  }
}

const POP: Record<string, string> = { left: "lpop", right: "rpop" }
const PUSH: Record<string, string> = { left: "lpush", right: "rpush" }

/** List pop then push events of a move (`LMOVE` and friends, also a woken `BLMOVE`). */
export function moveEvents(
  src: string,
  dst: string,
  from: "left" | "right",
  to: "left" | "right",
  srcGone: boolean,
): KeyEvent[] {
  const events: KeyEvent[] = [
    { cls: NOTIFY_LIST, event: PUSH[to] ?? "lpush", key: dst },
    { cls: NOTIFY_LIST, event: POP[from] ?? "lpop", key: src },
  ]
  if (srcGone) events.push({ cls: NOTIFY_GENERIC, event: "del", key: src })
  return events
}

/**
 * The events a successful (non-error) command publishes, in Redis's order. `before` and `after`
 * describe each key from `notifiedKeys`.
 */
export function commandEvents(
  command: string,
  args: Uint8Array[],
  reply: Reply,
  before: (key: string) => KeyState,
  after: (key: string) => KeyState,
): KeyEvent[] {
  const events: KeyEvent[] = []
  const emit = (cls: number, event: string, key: string) => events.push({ cls, event, key })
  const changed = (key: string) => before(key).gen !== after(key).gen
  const gone = (key: string) => before(key).exists && !after(key).exists
  const key = text(args[0])
  const delIfGone = (target = key) => {
    if (gone(target)) emit(NOTIFY_GENERIC, "del", target)
  }
  const simple = (cls: number, event: string) => {
    if (changed(key)) emit(cls, event, key)
  }
  for (const name of notifiedKeys(command, args))
    if (!before(name).exists && after(name).exists) emit(NOTIFY_NEW, "new", name)
  switch (command) {
    case "set":
      if (!changed(key)) break
      emit(NOTIFY_STRING, "set", key)
      if (hasOption(args.slice(2), "EX", "PX", "EXAT", "PXAT")) emit(NOTIFY_GENERIC, "expire", key)
      break
    case "setex":
    case "psetex":
      emit(NOTIFY_STRING, "set", key)
      emit(NOTIFY_GENERIC, "expire", key)
      break
    case "setnx":
    case "getset":
      simple(NOTIFY_STRING, "set")
      break
    case "mset":
    case "msetnx":
      for (const name of notifiedKeys(command, args))
        if (changed(name)) emit(NOTIFY_STRING, "set", name)
      break
    case "getex":
      if (!changed(key)) break
      if (gone(key)) emit(NOTIFY_GENERIC, "del", key)
      else if (hasOption(args.slice(1), "PERSIST")) emit(NOTIFY_GENERIC, "persist", key)
      else emit(NOTIFY_GENERIC, "expire", key)
      break
    case "getdel":
      delIfGone()
      break
    case "incr":
    case "incrby":
    case "decr":
    case "decrby":
      simple(NOTIFY_STRING, "incrby")
      break
    case "incrbyfloat":
    case "append":
    case "setrange":
    case "setbit":
      simple(NOTIFY_STRING, command)
      break
    case "del":
    case "unlink":
      for (const name of notifiedKeys(command, args)) delIfGone(name)
      break
    case "expire":
    case "pexpire":
    case "expireat":
    case "pexpireat":
      if (!changed(key)) break
      if (gone(key)) emit(NOTIFY_GENERIC, "del", key)
      else emit(NOTIFY_GENERIC, "expire", key)
      break
    case "persist":
      if (intOf(reply) === 1) emit(NOTIFY_GENERIC, "persist", key)
      break
    case "rename":
    case "renamenx":
      if (reply.t === "simple" || intOf(reply) === 1) {
        emit(NOTIFY_GENERIC, "rename_from", key)
        emit(NOTIFY_GENERIC, "rename_to", text(args[1]))
      }
      break
    case "lpush":
    case "lpushx":
      simple(NOTIFY_LIST, "lpush")
      break
    case "rpush":
    case "rpushx":
      simple(NOTIFY_LIST, "rpush")
      break
    case "lpop":
    case "rpop":
    case "ltrim":
      if (!changed(key)) break
      emit(NOTIFY_LIST, command, key)
      delIfGone()
      break
    case "lset":
    case "linsert":
      simple(NOTIFY_LIST, command)
      break
    case "lrem":
      if (intOf(reply) === 0) break
      emit(NOTIFY_LIST, "lrem", key)
      delIfGone()
      break
    case "lmove":
    case "blmove":
    case "rpoplpush":
    case "brpoplpush": {
      if (reply.t !== "bulk" || reply.v === null) break
      const rpoplpush = command.endsWith("rpoplpush")
      const from = rpoplpush ? "right" : text(args[2]).toLowerCase()
      const to = rpoplpush ? "left" : text(args[3]).toLowerCase()
      const dst = text(args[1])
      events.push(
        ...moveEvents(
          key,
          dst,
          from === "left" ? "left" : "right",
          to === "left" ? "left" : "right",
          gone(key),
        ),
      )
      break
    }
    case "lmpop":
    case "blpop":
    case "brpop": {
      if (reply.t !== "array" || !reply.v) break
      const [popped] = reply.v
      const name = popped?.t === "bulk" && popped.v ? latin1(popped.v) : ""
      const left =
        command === "blpop" ||
        (command === "lmpop" && args.some((arg) => text(arg).toUpperCase() === "LEFT"))
      emit(NOTIFY_LIST, left ? "lpop" : "rpop", name)
      delIfGone(name)
      break
    }
    case "sadd":
      if (intOf(reply) > 0) emit(NOTIFY_SET, "sadd", key)
      break
    case "srem":
      if (intOf(reply) === 0) break
      emit(NOTIFY_SET, "srem", key)
      delIfGone()
      break
    case "spop":
      if (!changed(key)) break
      emit(NOTIFY_SET, "spop", key)
      delIfGone()
      break
    case "smove": {
      if (intOf(reply) !== 1) break
      const dst = text(args[1])
      emit(NOTIFY_SET, "srem", key)
      delIfGone()
      if (changed(dst)) emit(NOTIFY_SET, "sadd", dst)
      break
    }
    case "sinterstore":
    case "sunionstore":
    case "sdiffstore":
      if (after(key).exists) emit(NOTIFY_SET, command, key)
      else if (before(key).exists) emit(NOTIFY_GENERIC, "del", key)
      break
    case "hset":
    case "hmset":
      simple(NOTIFY_HASH, "hset")
      break
    case "hsetnx":
      if (intOf(reply) === 1) emit(NOTIFY_HASH, "hset", key)
      break
    case "hincrby":
    case "hincrbyfloat":
      simple(NOTIFY_HASH, command)
      break
    case "hdel":
      if (intOf(reply) === 0) break
      emit(NOTIFY_HASH, "hdel", key)
      delIfGone()
      break
    case "zadd":
      simple(NOTIFY_ZSET, hasOption(args.slice(1), "INCR") ? "zincr" : "zadd")
      break
    case "zincrby":
      simple(NOTIFY_ZSET, "zincr")
      break
    case "zrem":
    case "zremrangebyscore":
    case "zremrangebyrank":
    case "zremrangebylex":
      if (intOf(reply) === 0) break
      emit(NOTIFY_ZSET, command, key)
      delIfGone()
      break
    case "zpopmin":
    case "zpopmax":
      if (!changed(key)) break
      emit(NOTIFY_ZSET, command, key)
      delIfGone()
      break
    case "bzpopmin":
    case "bzpopmax": {
      if (reply.t !== "array" || !reply.v) break
      const [popped] = reply.v
      const name = popped?.t === "bulk" && popped.v ? latin1(popped.v) : ""
      emit(NOTIFY_ZSET, command.slice(1), name)
      delIfGone(name)
      break
    }
    case "zunionstore":
    case "zinterstore":
    case "zdiffstore":
    case "zrangestore":
      if (after(key).exists) emit(NOTIFY_ZSET, command, key)
      else if (before(key).exists) emit(NOTIFY_GENERIC, "del", key)
      break
    case "xadd":
      if (reply.t !== "bulk" || reply.v === null) break
      emit(NOTIFY_STREAM, "xadd", key)
      if (after(key).size < before(key).size + 1) emit(NOTIFY_STREAM, "xtrim", key)
      break
    case "xdel":
    case "xtrim":
      if (intOf(reply) > 0) emit(NOTIFY_STREAM, command, key)
      break
    case "xgroup": {
      const sub = text(args[0]).toLowerCase()
      const known = ["create", "setid", "destroy", "createconsumer", "delconsumer"]
      if (!known.includes(sub)) break
      if ((sub === "destroy" || sub === "createconsumer") && intOf(reply) !== 1) break
      emit(NOTIFY_STREAM, `xgroup-${sub}`, text(args[1]))
      break
    }
    case "pfadd":
      if (intOf(reply) === 1) emit(NOTIFY_STRING, "pfadd", key)
      break
    case "pfmerge":
      emit(NOTIFY_STRING, "pfadd", key)
      break
    default:
      break
  }
  return events
}
