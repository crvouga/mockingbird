/**
 * Keyspace, list, sorted-set and hash-field-expiry commands added after the first command table:
 * `HSCAN` `SSCAN` `ZSCAN`, `ZUNIONSTORE`, `LMPOP`, `BLMOVE` `BRPOPLPUSH`, `MSETNX`, `COPY`,
 * `EXPIRETIME` `PEXPIRETIME`, and the `HEXPIRE` family. The engine routes unknown command names
 * here; every handler returns `undefined` for a name that is not its own.
 */
import { cmpBytes, fromLatin1, globMatch, latin1, parseI64, utf8 } from "./bytes.ts"
import { isCompact } from "./introspect.ts"
import {
  arityError,
  arr,
  bulk,
  err,
  int,
  nil,
  nilArray,
  notInteger,
  queued,
  type Reply,
  syntaxError,
  wrongType,
} from "./protocol.ts"
import type { Database, Value } from "./store.ts"
import { memberKey } from "./store.ts"

export interface ExtraSession {
  db: number
  inExec: boolean
}

export interface ExtraHost<S extends ExtraSession> {
  now(): number
  databaseCount(): number
  scriptDepth(): number
  consumersPaused(): boolean
  database(index: number): Database
  wake(db: number, key: string): void
  block(spec: {
    session: S
    db: number
    key: string
    side: "left" | "right"
    destKey: string
    destSide: "left" | "right"
    deadline?: number
  }): Promise<Reply>
}

export const EXTRA_WRITES = [
  "zunionstore",
  "lmpop",
  "blmove",
  "brpoplpush",
  "msetnx",
  "hexpire",
  "hpexpire",
  "hexpireat",
  "hpexpireat",
  "hpersist",
] as const

const upper = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes).toUpperCase() : "")
const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")

export function extraCommand<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: string,
  args: Uint8Array[],
  apply: boolean,
): Reply | Promise<Reply> | undefined {
  switch (command) {
    case "hscan":
    case "sscan":
    case "zscan":
      return cmdCollectionScan(host, session, command, args)
    case "zunionstore":
      return cmdZunionstore(host, session, args, apply)
    case "lmpop":
      return cmdLmpop(host, session, args, apply)
    case "blmove":
    case "brpoplpush":
      return cmdBlockingMove(host, session, command, args, apply)
    case "msetnx":
      return cmdMsetnx(host, session, args, apply)
    case "copy":
      return cmdCopy(host, session, args, apply)
    case "expiretime":
    case "pexpiretime":
      return cmdExpireTime(host, session, command, args)
    case "hexpire":
    case "hpexpire":
    case "hexpireat":
    case "hpexpireat":
      return cmdHashExpire(host, session, command, args, apply)
    case "httl":
    case "hpttl":
    case "hexpiretime":
    case "hpexpiretime":
    case "hpersist":
      return cmdHashTtl(host, session, command, args, apply)
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// HSCAN / SSCAN / ZSCAN

const MAX_CURSOR = 18446744073709551615n

/**
 * Best guess, not oracle-verified beyond small collections. Redis returns a compact (listpack or
 * intset) collection whole in one call whatever `COUNT` says, and walks a hash table with an
 * opaque reverse-binary cursor. The emulator returns compact collections whole with cursor `0`,
 * and pages larger ones by element offset, `COUNT` elements per call (default 10). `MATCH`
 * filters the examined page, so a page may be empty while the cursor is not `0`.
 */
function cmdCollectionScan<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: "hscan" | "sscan" | "zscan",
  args: Uint8Array[],
): Reply {
  if (args.length < 2) return arityError(command)
  const cursorText = text(args[1])
  if (!/^\d+$/.test(cursorText) || BigInt(cursorText) > MAX_CURSOR) return err("ERR invalid cursor")
  const value = host.database(session.db).get(text(args[0]))
  if (!value) return arr([bulk("0"), arr([])])
  const kind = command === "hscan" ? "hash" : command === "sscan" ? "set" : "zset"
  if (value.kind !== kind) return wrongType()
  let pattern: string | null = null
  let count = 10
  let noValues = false
  for (let i = 2; i < args.length; i++) {
    const option = upper(args[i])
    if (option === "MATCH") {
      const pattern_ = args[++i]
      if (!pattern_) return syntaxError()
      pattern = text(pattern_)
    } else if (option === "COUNT") {
      const raw = args[++i]
      if (!raw) return syntaxError()
      const parsed = parseI64(raw)
      if (parsed === null) return notInteger()
      if (parsed < 1n) return syntaxError()
      count = Number(parsed)
    } else if (option === "NOVALUES" && command === "hscan") noValues = true
    else return syntaxError()
  }
  const entries = scanEntries(host.database(session.db), value, noValues)
  const compact = isCompact(value)
  const start = compact ? 0 : Math.min(entries.length, Number(BigInt(cursorText) % 0x100000000n))
  const end = compact ? entries.length : Math.min(entries.length, start + count)
  const page = entries.slice(start, end)
  const items: Reply[] = []
  for (const entry of page) {
    if (pattern !== null && !globMatch(pattern, entry.name)) continue
    items.push(...entry.reply)
  }
  return arr([bulk(end >= entries.length ? "0" : String(end)), arr(items)])
}

function scanEntries(
  database: Database,
  value: Value,
  noValues: boolean,
): Array<{ name: string; reply: Reply[] }> {
  if (value.kind === "hash") {
    return [...value.fields].map(([field, bytes]) => ({
      name: field,
      reply: noValues ? [bulk(fromLatin1(field))] : [bulk(fromLatin1(field)), bulk(bytes)],
    }))
  }
  if (value.kind === "set") {
    return [...value.members.values()]
      .sort(cmpBytes)
      .map((member) => ({ name: latin1(member), reply: [bulk(member)] }))
  }
  if (value.kind === "zset") {
    return database.zsetOrdered(value).map((item) => ({
      name: latin1(item.member),
      reply: [bulk(item.member), bulk(formatScore(item.score))],
    }))
  }
  return []
}

export function formatScore(score: number): string {
  if (Number.isNaN(score)) return "nan"
  if (score === Infinity) return "inf"
  if (score === -Infinity) return "-inf"
  return String(score)
}

// ---------------------------------------------------------------------------------------------
// ZUNIONSTORE

function parseFloatArg(bytes: Uint8Array | undefined): number | null {
  const value = text(bytes).trim().toLowerCase()
  if (value === "inf" || value === "+inf") return Infinity
  if (value === "-inf") return -Infinity
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cmdZunionstore<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 3) return arityError("zunionstore")
  const numkeys = parseI64(args[1] ?? utf8(""))
  if (numkeys === null) return notInteger()
  if (numkeys < 1n) return err("ERR at least 1 input key is needed for 'zunionstore' command")
  if (numkeys > BigInt(args.length - 2)) return syntaxError()
  const count = Number(numkeys)
  const keys = args.slice(2, 2 + count).map(text)
  const weights: number[] = keys.map(() => 1)
  let aggregate: "SUM" | "MIN" | "MAX" = "SUM"
  for (let i = 2 + count; i < args.length; i++) {
    const option = upper(args[i])
    if (option === "WEIGHTS") {
      if (i + count >= args.length) return syntaxError()
      for (let j = 0; j < count; j++) {
        const weight = parseFloatArg(args[i + 1 + j])
        if (weight === null) return err("ERR weight value is not a float")
        weights[j] = weight
      }
      i += count
    } else if (option === "AGGREGATE") {
      const kind = upper(args[++i])
      if (kind !== "SUM" && kind !== "MIN" && kind !== "MAX") return syntaxError()
      aggregate = kind
    } else return syntaxError()
  }
  const database = host.database(session.db)
  const scores = new Map<string, { member: Uint8Array; score: number }>()
  keys.forEach((key, index) => {
    const value = database.get(key)
    if (!value) return
    if (value.kind !== "zset" && value.kind !== "set") return
    const weight = weights[index] ?? 1
    const members =
      value.kind === "zset"
        ? [...value.members.values()]
        : [...value.members.values()].map((member) => ({ member, score: 1 }))
    for (const { member, score } of members) {
      const scaled = Number.isNaN(score * weight) ? 0 : score * weight
      const id = memberKey(member)
      const current = scores.get(id)
      if (!current) scores.set(id, { member, score: scaled })
      else if (aggregate === "SUM") current.score = nanToZero(current.score + scaled)
      else if (aggregate === "MIN") current.score = Math.min(current.score, scaled)
      else current.score = Math.max(current.score, scaled)
    }
  })
  // A wrong-typed input is reported before anything is written.
  for (const key of keys) {
    const value = database.get(key)
    if (value && value.kind !== "zset" && value.kind !== "set") return wrongType()
  }
  if (!apply) return queued()
  const dest = text(args[0])
  database.delete(dest)
  if (scores.size === 0) return int(0)
  const members = new Map<string, { member: Uint8Array; score: number }>()
  for (const [id, item] of scores) members.set(id, item)
  database.put(dest, { kind: "zset", members })
  host.wake(session.db, dest)
  return int(members.size)
}

const nanToZero = (value: number): number => (Number.isNaN(value) ? 0 : value)

// ---------------------------------------------------------------------------------------------
// LMPOP, BLMOVE, BRPOPLPUSH

function cmdLmpop<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 3) return arityError("lmpop")
  const numkeys = parseI64(args[0] ?? utf8(""))
  if (numkeys === null || numkeys < 1n) return err("ERR numkeys should be greater than 0")
  const count = Number(numkeys)
  if (count > args.length - 2) return syntaxError()
  const keys = args.slice(1, 1 + count).map(text)
  const where = upper(args[1 + count])
  if (where !== "LEFT" && where !== "RIGHT") return syntaxError()
  let take = 1
  let counted = false
  for (let i = 2 + count; i < args.length; i++) {
    if (upper(args[i]) !== "COUNT" || counted || i + 1 >= args.length) return syntaxError()
    const parsed = parseI64(args[i + 1] ?? utf8(""))
    if (parsed === null || parsed < 1n) return err("ERR count should be greater than 0")
    take = Number(parsed > 0x7fffffffn ? 0x7fffffffn : parsed)
    counted = true
    i++
  }
  const database = host.database(session.db)
  for (const key of keys) {
    const value = database.get(key)
    if (!value) continue
    if (value.kind !== "list") return wrongType()
    if (value.items.length === 0) continue
    if (!apply) return queued()
    if (host.consumersPaused()) return nilArray()
    const popped =
      where === "LEFT" ? value.items.splice(0, take) : value.items.splice(-take).reverse()
    database.dropIfEmpty(key)
    if (database.has(key)) database.put(key, value)
    return arr([bulk(key), arr(popped.map((item) => bulk(item)))])
  }
  return apply ? nilArray() : queued()
}

function parseTimeoutSeconds(bytes: Uint8Array | undefined): number | Reply {
  const raw = text(bytes)
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw))
    return err("ERR timeout is not a float or out of range")
  const value = Number(raw)
  if (!Number.isFinite(value) || value * 1000 > Number.MAX_SAFE_INTEGER)
    return err("ERR timeout is out of range")
  if (value < 0) return err("ERR timeout is negative")
  return value
}

/**
 * Pop `from` of `src` and push the element on `to` of `dst`; null when `src` has nothing to move.
 * The engine also calls this to wake a blocked `BLMOVE` / `BRPOPLPUSH`.
 */
export function moveList<S extends ExtraSession>(
  host: ExtraHost<S>,
  dbIndex: number,
  src: string,
  dst: string,
  from: "left" | "right",
  to: "left" | "right",
): Reply | null {
  if (host.consumersPaused()) return null
  const database = host.database(dbIndex)
  const list = database.get(src)
  if (!list) return null
  if (list.kind !== "list") return wrongType()
  const existing = src === dst ? list : database.get(dst)
  if (existing && existing.kind !== "list") return wrongType()
  const item = from === "left" ? list.items.shift() : list.items.pop()
  if (!item) return null
  database.dropIfEmpty(src)
  if (database.has(src)) database.put(src, list)
  const target: Extract<Value, { kind: "list" }> =
    database.get(dst)?.kind === "list"
      ? (database.get(dst) as Extract<Value, { kind: "list" }>)
      : { kind: "list", items: [] }
  if (to === "left") target.items.unshift(item)
  else target.items.push(item)
  database.put(dst, target)
  host.wake(dbIndex, dst)
  return bulk(item)
}

function cmdBlockingMove<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: "blmove" | "brpoplpush",
  args: Uint8Array[],
  apply: boolean,
): Reply | Promise<Reply> {
  if (args.length !== (command === "blmove" ? 5 : 3)) return arityError(command)
  let from: "left" | "right" = "right"
  let to: "left" | "right" = "left"
  if (command === "blmove") {
    const a = upper(args[2])
    const b = upper(args[3])
    if ((a !== "LEFT" && a !== "RIGHT") || (b !== "LEFT" && b !== "RIGHT")) return syntaxError()
    from = a === "LEFT" ? "left" : "right"
    to = b === "LEFT" ? "left" : "right"
  }
  const timeout = parseTimeoutSeconds(args[args.length - 1])
  if (typeof timeout !== "number") return timeout
  const src = text(args[0])
  const dst = text(args[1])
  const database = host.database(session.db)
  const source = database.get(src)
  if (source && source.kind !== "list") return wrongType()
  if (source) {
    const target = database.get(dst)
    if (target && target.kind !== "list") return wrongType()
  }
  if (!apply) return queued()
  const moved = moveList(host, session.db, src, dst, from, to)
  if (moved) return moved
  if (session.inExec || host.scriptDepth() > 0) return nil()
  return host.block({
    session,
    db: session.db,
    key: src,
    side: from,
    destKey: dst,
    destSide: to,
    ...(timeout > 0 ? { deadline: host.now() + timeout * 1000 } : {}),
  })
}

// ---------------------------------------------------------------------------------------------
// MSETNX, COPY, EXPIRETIME

function cmdMsetnx<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 2 || args.length % 2 !== 0) return arityError("msetnx")
  const database = host.database(session.db)
  for (let i = 0; i < args.length; i += 2) if (database.has(text(args[i]))) return int(0)
  if (!apply) return queued()
  for (let i = 0; i < args.length; i += 2) {
    database.put(text(args[i]), { kind: "string", bytes: args[i + 1] ?? utf8("") })
  }
  return int(1)
}

function cmdCopy<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 2) return arityError("copy")
  let destDb = session.db
  let replace = false
  for (let i = 2; i < args.length; i++) {
    const option = upper(args[i])
    if (option === "REPLACE") replace = true
    else if (option === "DB" && i + 1 < args.length) {
      const parsed = parseI64(args[++i] ?? utf8(""))
      if (parsed === null) return notInteger()
      if (parsed < 0n || parsed >= BigInt(host.databaseCount()))
        return err("ERR DB index is out of range")
      destDb = Number(parsed)
    } else return syntaxError()
  }
  const sourceKey = text(args[0])
  const destKey = text(args[1])
  if (destDb === session.db && sourceKey === destKey)
    return err("ERR source and destination objects are the same")
  const source = host.database(session.db)
  const dest = host.database(destDb)
  const value = source.get(sourceKey)
  if (!value) return int(0)
  if (dest.has(destKey) && !replace) return int(0)
  if (!apply) return queued()
  const expiry = source.expiry(sourceKey)
  dest.delete(destKey)
  dest.put(destKey, structuredClone(value))
  if (expiry !== null) dest.setExpiry(destKey, expiry)
  host.wake(destDb, destKey)
  return int(1)
}

function cmdExpireTime<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: "expiretime" | "pexpiretime",
  args: Uint8Array[],
): Reply {
  if (args.length !== 1) return arityError(command)
  const database = host.database(session.db)
  const key = text(args[0])
  if (!database.has(key)) return int(-2)
  const at = database.expiry(key)
  if (at === null) return int(-1)
  return int(command === "pexpiretime" ? at : Math.floor(at / 1000))
}

// ---------------------------------------------------------------------------------------------
// HEXPIRE family (hash field TTLs, Redis 7.4+)

const HASH_EXPIRE_MAX_MS = 2 ** 48 - 1

function fieldsClause(args: Uint8Array[], at: number): { fields: string[] } | { error: Reply } {
  if (upper(args[at]) !== "FIELDS")
    return { error: err("ERR Mandatory argument FIELDS is missing or not at the right position") }
  const declared = parseI64(args[at + 1] ?? utf8(""))
  if (declared === null || declared < 1n)
    return { error: err("ERR Parameter `numFields` should be greater than 0") }
  if (declared !== BigInt(args.length - at - 2))
    return { error: err("ERR The `numfields` parameter must match the number of arguments") }
  return { fields: args.slice(at + 2).map((field) => memberKey(field)) }
}

function hashAt(database: Database, key: string): Extract<Value, { kind: "hash" }> | Reply | null {
  const value = database.get(key)
  if (!value) return null
  return value.kind === "hash" ? value : wrongType()
}

function cmdHashExpire<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: "hexpire" | "hpexpire" | "hexpireat" | "hpexpireat",
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 5) return arityError(command)
  const amount = parseI64(args[1] ?? utf8(""))
  if (amount === null) return notInteger()
  if (amount < 0n) return err("ERR invalid expire time, must be >= 0")
  const condition = upper(args[2])
  const hasCondition = ["NX", "XX", "GT", "LT"].includes(condition)
  const clause = fieldsClause(args, hasCondition ? 3 : 2)
  if ("error" in clause) return clause.error
  const database = host.database(session.db)
  const now = host.now()
  const millis = command === "hexpire" || command === "hexpireat" ? amount * 1000n : amount
  const absolute = command === "hexpire" || command === "hpexpire" ? BigInt(now) + millis : millis
  if (absolute > BigInt(HASH_EXPIRE_MAX_MS) || millis > BigInt(HASH_EXPIRE_MAX_MS))
    return err(`ERR invalid expire time in '${command}' command`)
  const key = text(args[0])
  const hash = hashAt(database, key)
  if (hash !== null && !("fields" in hash)) return hash
  if (hash === null) return apply ? arr(clause.fields.map(() => int(-2))) : queued()
  if (!apply) return queued()
  const at = Number(absolute)
  const results: Reply[] = []
  for (const field of clause.fields) {
    if (!hash.fields.has(field)) {
      results.push(int(-2))
      continue
    }
    const current = hash.fieldExpires?.get(field)
    const allowed =
      !hasCondition ||
      (condition === "NX" && current === undefined) ||
      (condition === "XX" && current !== undefined) ||
      (condition === "GT" && current !== undefined && at > current) ||
      (condition === "LT" && (current === undefined || at < current))
    if (!allowed) {
      results.push(int(0))
      continue
    }
    if (at <= now) {
      hash.fields.delete(field)
      hash.fieldExpires?.delete(field)
      results.push(int(2))
      continue
    }
    hash.fieldExpires ??= new Map()
    hash.fieldExpires.set(field, at)
    results.push(int(1))
  }
  database.dropIfEmpty(key)
  if (database.has(key)) database.put(key, hash)
  return arr(results)
}

function cmdHashTtl<S extends ExtraSession>(
  host: ExtraHost<S>,
  session: S,
  command: "httl" | "hpttl" | "hexpiretime" | "hpexpiretime" | "hpersist",
  args: Uint8Array[],
  apply: boolean,
): Reply {
  if (args.length < 4) return arityError(command)
  const clause = fieldsClause(args, 1)
  if ("error" in clause) return clause.error
  const database = host.database(session.db)
  const key = text(args[0])
  const hash = hashAt(database, key)
  if (hash !== null && !("fields" in hash)) return hash
  if (command === "hpersist" && !apply) return queued()
  const now = host.now()
  const results = clause.fields.map((field): Reply => {
    if (!hash || !hash.fields.has(field)) return int(-2)
    const at = hash.fieldExpires?.get(field)
    if (at === undefined) return int(-1)
    switch (command) {
      case "hpersist":
        hash.fieldExpires?.delete(field)
        return int(1)
      case "hpttl":
        return int(Math.max(0, at - now))
      case "httl":
        return int(Math.ceil(Math.max(0, at - now) / 1000))
      case "hpexpiretime":
        return int(at)
      default:
        return int(Math.ceil(at / 1000))
    }
  })
  if (command === "hpersist" && hash && results.some((reply) => reply.t === "int" && reply.v === 1))
    database.put(key, hash)
  return arr(results)
}
