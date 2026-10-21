/**
 * Introspection commands: `OBJECT`, `MEMORY`, `SLOWLOG`, `ACL`, `COMMAND`, plus the `MONITOR`
 * line format. Everything here is deterministic: sizes are a documented model, the slow log never
 * records, and the command table is a snapshot of Redis 8.4.0 (see `scripts/command-table.ts`).
 */
import { fromLatin1, latin1, parseI64, utf8 } from "./bytes.ts"
import { COMMAND_TABLE, type CommandRow } from "./command-table.ts"
import {
  arityError,
  arr,
  bulk,
  err,
  int,
  map,
  nil,
  notInteger,
  ok,
  type Reply,
  simple,
  syntaxError,
} from "./protocol.ts"
import { sha256Hex } from "./sha256.ts"
import type { Database, Value } from "./store.ts"

const upper = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes).toUpperCase() : "")
const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")

const unknownSubcommand = (name: string, sub: Uint8Array | undefined): Reply =>
  err(`ERR unknown subcommand '${text(sub)}'. Try ${name.toUpperCase()} HELP.`)

const unsupported = (what: string): Reply =>
  err(`ERR ${what} is not supported by the Mockingbird Redis emulator`)

// ---------------------------------------------------------------------------------------------
// Encodings and sizes

const isInt64Text = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0 || bytes.length > 20) return false
  const value = latin1(bytes)
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) return false
  return parseI64(bytes) !== null
}

/** The `OBJECT ENCODING` name, using the default listpack / intset thresholds of Redis 8.4.0. */
export function encodingOf(value: Value): string {
  switch (value.kind) {
    case "string":
      if (isInt64Text(value.bytes)) return "int"
      return value.bytes.length <= 44 ? "embstr" : "raw"
    case "list": {
      const size = value.items.reduce((sum, item) => sum + item.length + 2, 0)
      return size <= 8192 ? "listpack" : "quicklist"
    }
    case "hash": {
      const small =
        value.fields.size <= 512 &&
        [...value.fields].every(([field, bytes]) => field.length <= 64 && bytes.length <= 64)
      if (!small) return "hashtable"
      return value.fieldExpires?.size ? "listpackex" : "listpack"
    }
    case "set": {
      const members = [...value.members.values()]
      if (members.every(isInt64Text) && members.length <= 512) return "intset"
      return members.length <= 128 && members.every((member) => member.length <= 64)
        ? "listpack"
        : "hashtable"
    }
    case "zset": {
      const small =
        value.members.size <= 128 &&
        [...value.members.values()].every((item) => item.member.length <= 64)
      return small ? "listpack" : "skiplist"
    }
    case "stream":
      return "stream"
    default: {
      const never: never = value
      return never
    }
  }
}

/** Compact encodings are returned whole by `HSCAN` / `SSCAN` / `ZSCAN`. */
export function isCompact(value: Value): boolean {
  const encoding = encodingOf(value)
  return encoding === "listpack" || encoding === "listpackex" || encoding === "intset"
}

/**
 * Best guess, not oracle-verified: a deterministic model (24 bytes of key and object overhead
 * plus a per-element overhead) rather than Redis's allocator. It is always positive and grows
 * with the key length and the value's size.
 */
export function memoryUsage(key: string, value: Value): number {
  const base = 24 + key.length
  switch (value.kind) {
    case "string":
      return base + value.bytes.length
    case "list":
      return base + value.items.reduce((sum, item) => sum + item.length + 8, 0)
    case "set":
      return base + [...value.members.values()].reduce((sum, item) => sum + item.length + 16, 0)
    case "zset":
      return (
        base + [...value.members.values()].reduce((sum, item) => sum + item.member.length + 24, 0)
      )
    case "hash":
      return (
        base +
        [...value.fields].reduce((sum, [field, bytes]) => sum + field.length + bytes.length + 16, 0)
      )
    case "stream":
      return (
        base +
        64 +
        value.stream.entries.reduce(
          (sum, entry) =>
            sum + entry.id.length + 16 + entry.fields.reduce((inner, f) => inner + f.length, 0),
          0,
        )
      )
    default: {
      const never: never = value
      return never
    }
  }
}

// ---------------------------------------------------------------------------------------------
// OBJECT, MEMORY, SLOWLOG

const OBJECT_HELP = [
  "OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "ENCODING <key>",
  "    Return the kind of internal representation used in order to store the value",
  "    associated with a <key>.",
  "FREQ <key>",
  "    Return the access frequency index of the <key>. The returned integer is",
  "    proportional to the logarithm of the recent access frequency of the key.",
  "IDLETIME <key>",
  "    Return the idle time of the <key>, that is the approximated number of",
  "    seconds elapsed since the last access to the key.",
  "REFCOUNT <key>",
  "    Return the number of references of the value associated with the specified",
  "    <key>.",
  "HELP",
  "    Print this help.",
]

const SLOWLOG_HELP = [
  "SLOWLOG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "GET [<count>]",
  "    Return top <count> entries from the slowlog (default: 10, -1 mean all).",
  "    Entries are made of:",
  "    id, timestamp, time in microseconds, arguments array, client IP and port,",
  "    client name",
  "LEN",
  "    Return the length of the slowlog.",
  "RESET",
  "    Reset the slowlog.",
  "HELP",
  "    Print this help.",
]

const LFU_OFF =
  "ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust."

export function cmdObject(database: Database, args: Uint8Array[]): Reply {
  const sub = upper(args[0])
  if (args.length === 0) return arityError("object")
  if (sub === "HELP") {
    return args.length === 1 ? arr(OBJECT_HELP.map(simple)) : arityError("object|help")
  }
  if (!["ENCODING", "FREQ", "IDLETIME", "REFCOUNT"].includes(sub))
    return unknownSubcommand("object", args[0])
  if (args.length !== 2) return arityError(`object|${sub.toLowerCase()}`)
  const key = text(args[1])
  const value = database.peek(key)
  if (!value) return nil()
  if (sub === "ENCODING") return bulk(encodingOf(value))
  if (sub === "REFCOUNT") return int(1)
  if (sub === "FREQ") return err(LFU_OFF)
  return int(Math.floor((database.idleMs(key) ?? 0) / 1000))
}

export function cmdMemory(database: Database, args: Uint8Array[]): Reply {
  const sub = upper(args[0])
  if (args.length === 0) return arityError("memory")
  if (sub === "PURGE") return args.length === 1 ? ok() : arityError("memory|purge")
  if (sub === "USAGE") {
    if (args.length < 2) return arityError("memory|usage")
    for (let i = 2; i < args.length; i += 2) {
      if (upper(args[i]) !== "SAMPLES" || i + 1 >= args.length) return syntaxError()
      const samples = parseI64(args[i + 1] ?? utf8(""))
      if (samples === null) return notInteger()
      if (samples < 0n) return syntaxError()
    }
    const key = text(args[1])
    const value = database.peek(key)
    return value ? int(memoryUsage(key, value)) : nil()
  }
  if (["DOCTOR", "STATS", "MALLOC-STATS", "HELP"].includes(sub)) return unsupported(`MEMORY ${sub}`)
  return unknownSubcommand("memory", args[0])
}

/** The slow log never records: the emulator has no wall-clock command latency to threshold on. */
export function cmdSlowlog(args: Uint8Array[]): Reply {
  const sub = upper(args[0])
  if (args.length === 0) return arityError("slowlog")
  if (sub === "HELP")
    return args.length === 1 ? arr(SLOWLOG_HELP.map(simple)) : arityError("slowlog|help")
  if (sub === "LEN") return args.length === 1 ? int(0) : arityError("slowlog|len")
  if (sub === "RESET") return args.length === 1 ? ok() : arityError("slowlog|reset")
  if (sub === "GET") {
    if (args.length > 2) return arityError("slowlog|get")
    if (args.length === 2) {
      const count = parseI64(args[1] ?? utf8(""))
      if (count === null || count < -1n)
        return err("ERR count should be greater than or equal to -1")
    }
    return arr([])
  }
  return unknownSubcommand("slowlog", args[0])
}

// ---------------------------------------------------------------------------------------------
// ACL

export interface AclUser {
  name: string
  password: string | undefined
  readOnly: boolean
}

function aclLine(user: AclUser): string {
  const password = user.password === undefined ? "nopass" : `#${sha256Hex(utf8(user.password))}`
  const flags =
    user.password === undefined ? "on nopass sanitize-payload" : `on sanitize-payload ${password}`
  return `user ${user.name} ${flags} ~* &* +@all${user.readOnly ? " -@write" : ""}`
}

/**
 * `ACL WHOAMI`, `USERS` and `LIST` describe the users given to `createRedis`. Rules are fixed at
 * construction, so every subcommand that would change or audit them answers an explicit error.
 */
export function cmdAcl(users: AclUser[], whoami: string, args: Uint8Array[]): Reply {
  const sub = upper(args[0])
  if (args.length === 0) return arityError("acl")
  const sorted = [...users].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (sub === "WHOAMI") return args.length === 1 ? bulk(whoami) : arityError("acl|whoami")
  if (sub === "USERS")
    return args.length === 1 ? arr(sorted.map((u) => bulk(u.name))) : arityError("acl|users")
  if (sub === "LIST")
    return args.length === 1 ? arr(sorted.map((u) => bulk(aclLine(u)))) : arityError("acl|list")
  if (
    [
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
    ].includes(sub)
  )
    return unsupported(`ACL ${sub}`)
  return unknownSubcommand("acl", args[0])
}

// ---------------------------------------------------------------------------------------------
// COMMAND

const BY_NAME = new Map<string, CommandRow>(COMMAND_TABLE.map((row) => [row[0], row]))

export const commandNames = (): string[] => COMMAND_TABLE.map((row) => row[0])

export function commandFlags(name: string): string[] {
  return (BY_NAME.get(name)?.[2] ?? "").split(" ").filter(Boolean)
}

const words = (value: string): Reply[] => value.split(" ").filter(Boolean).map(simple)

function infoEntry(row: CommandRow): Reply {
  return arr([
    bulk(row[0]),
    int(row[1]),
    arr(words(row[2])),
    int(row[3]),
    int(row[4]),
    int(row[5]),
    arr(words(row[6])),
    arr([]),
    arr([]),
    arr([]),
  ])
}

function docsEntry(row: CommandRow): Reply {
  return map([
    [bulk("summary"), bulk(row[7])],
    [bulk("since"), bulk(row[8])],
    [bulk("group"), bulk(row[9])],
    [bulk("complexity"), bulk(row[10])],
  ])
}

/** Argument positions (0-based within the arguments after the command name) that hold keys. */
function keyPositions(row: CommandRow, args: Uint8Array[]): number[] | Reply {
  const name = row[0]
  const numkeysAt = (at: number, first: number, store = false): number[] | Reply => {
    const declared = parseI64(args[at] ?? utf8(""))
    if (declared === null || declared < 1n || declared > BigInt(args.length - first))
      return err("ERR Invalid arguments specified for command")
    const positions = Array.from({ length: Number(declared) }, (_, i) => first + i)
    return store ? [0, ...positions] : positions
  }
  if (name === "eval" || name === "evalsha") {
    const declared = parseI64(args[1] ?? utf8(""))
    if (declared === null || declared < 1n || declared > BigInt(args.length - 2)) return []
    return Array.from({ length: Number(declared) }, (_, i) => 2 + i)
  }
  if (name === "zunionstore" || name === "zinterstore" || name === "zdiffstore")
    return numkeysAt(1, 2, true)
  if (name === "zunion" || name === "zinter" || name === "zdiff" || name === "sintercard")
    return numkeysAt(0, 1)
  if (name === "lmpop" || name === "zmpop") return numkeysAt(0, 1)
  if (name === "blmpop" || name === "bzmpop") return numkeysAt(1, 2)
  if (name === "xread" || name === "xreadgroup") {
    const at = args.findIndex((arg) => upper(arg) === "STREAMS")
    const tail = at < 0 ? 0 : args.length - at - 1
    if (at < 0 || tail === 0 || tail % 2 !== 0)
      return err("ERR Invalid arguments specified for command")
    return Array.from({ length: tail / 2 }, (_, i) => at + 1 + i)
  }
  const [, , , first, last, step] = row
  if (first === 0) return err("ERR The command has no key arguments")
  const end = last < 0 ? args.length + 1 + last : last
  const positions: number[] = []
  for (let at = first; at <= end && at <= args.length; at += step || 1) positions.push(at - 1)
  return positions
}

export function cmdCommand(args: Uint8Array[]): Reply {
  const sub = upper(args[0])
  if (args.length === 0) return arr(COMMAND_TABLE.map(infoEntry))
  if (sub === "COUNT")
    return args.length === 1 ? int(COMMAND_TABLE.length) : arityError("command|count")
  if (sub === "INFO") {
    if (args.length === 1) return arr(COMMAND_TABLE.map(infoEntry))
    return arr(
      args.slice(1).map((arg) => {
        const row = BY_NAME.get(text(arg).toLowerCase())
        return row ? infoEntry(row) : nil()
      }),
    )
  }
  if (sub === "DOCS") {
    const rows =
      args.length === 1
        ? COMMAND_TABLE
        : args
            .slice(1)
            .map((arg) => BY_NAME.get(text(arg).toLowerCase()))
            .filter((row): row is CommandRow => row !== undefined)
    return map(rows.map((row) => [bulk(row[0]), docsEntry(row)]))
  }
  if (sub === "LIST") {
    if (args.length === 1) return arr(commandNames().map((name) => bulk(name)))
    if (args.length !== 4 || upper(args[1]) !== "FILTERBY") return syntaxError()
    const kind = upper(args[2])
    const operand = text(args[3])
    if (kind === "MODULE") return arr([])
    if (kind === "ACLCAT")
      return arr(
        COMMAND_TABLE.filter((row) =>
          words(row[6]).some((c) => c.t === "simple" && c.v === `@${operand.toLowerCase()}`),
        ).map((row) => bulk(row[0])),
      )
    if (kind === "PATTERN")
      return arr(
        COMMAND_TABLE.filter((row) => globToRegExp(operand).test(row[0])).map((row) =>
          bulk(row[0]),
        ),
      )
    return syntaxError()
  }
  if (sub === "GETKEYS") {
    if (args.length < 2) return arityError("command|getkeys")
    const row = BY_NAME.get(text(args[1]).toLowerCase())
    if (!row) return err("ERR Invalid command specified")
    const rest = args.slice(2)
    const given = rest.length + 1
    if (row[1] > 0 ? given !== row[1] : given < -row[1])
      return err("ERR Invalid number of arguments specified for command")
    const positions = keyPositions(row, rest)
    if (!Array.isArray(positions)) return positions
    return arr(positions.map((at) => bulk(rest[at] ?? fromLatin1(""))))
  }
  if (sub === "GETKEYSANDFLAGS") return unsupported("COMMAND GETKEYSANDFLAGS")
  if (sub === "HELP") return unsupported("COMMAND HELP")
  return unknownSubcommand("command", args[0])
}

function globToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")))
    .join("")
  return new RegExp(`^${body}$`, "i")
}

// ---------------------------------------------------------------------------------------------
// MONITOR

/** `sdscatrepr`: the quoting Redis uses for every argument on the `MONITOR` stream. */
export function monitorRepr(bytes: Uint8Array): string {
  let out = '"'
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte)
    if (ch === '"' || ch === "\\") out += `\\${ch}`
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (byte === 7) out += "\\a"
    else if (byte === 8) out += "\\b"
    else if (byte >= 0x20 && byte <= 0x7e) out += ch
    else out += `\\x${byte.toString(16).padStart(2, "0")}`
  }
  return `${out}"`
}

/** `+<seconds>.<microseconds> [<db> <addr>] "name" "arg" ...` without the leading `+`. */
export function monitorLine(
  nowMs: number,
  db: number,
  origin: string,
  name: string,
  args: Uint8Array[],
): string {
  const seconds = Math.floor(nowMs / 1000)
  const micros = String(Math.floor((nowMs % 1000) * 1000)).padStart(6, "0")
  const shown = [fromLatin1(name), ...args].map(monitorRepr).join(" ")
  return `${seconds}.${micros} [${db} ${origin}] ${shown}`
}

/** Arguments Redis replaces with `(redacted)` before showing a command to monitors. */
export function monitorArgs(command: string, args: Uint8Array[]): Uint8Array[] {
  const hidden = utf8("(redacted)")
  if (command === "auth") return args.map(() => hidden)
  if (command === "hello") {
    const out = [...args]
    const at = out.findIndex((arg, i) => i > 0 && upper(arg) === "AUTH")
    if (at > 0) for (const secret of [at + 1, at + 2]) if (secret < out.length) out[secret] = hidden
    return out
  }
  return args
}

/** Replies `processCommand` would have refused before the command ran: not shown to monitors. */
export function monitorSkips(reply: Reply): boolean {
  if (reply.t === "simple") return reply.v === "QUEUED"
  if (reply.t !== "error") return false
  return /^(?:ERR unknown (?:sub)?command|ERR wrong number of arguments|NOAUTH|NOPERM|OOM|BUSY|READONLY|ERR Can't execute|ERR Replica can't)/.test(
    reply.v,
  )
}
