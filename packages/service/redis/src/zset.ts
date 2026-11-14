/**
 * Sorted-set range and set-algebra commands: the `ZRANGE` family (by rank, score and lex, with
 * `REV` and `LIMIT`), `ZRANGESTORE`, `ZLEXCOUNT`, `ZREMRANGEBYLEX`, `ZUNION`/`ZINTER`/`ZDIFF` and
 * their `STORE` forms, `ZINTERCARD` and `ZRANDMEMBER`. Replies that carry scores follow the
 * connection's protocol: flat `member, "score"` in RESP2 (and inside scripts), `[member, double]`
 * pairs in RESP3, as Redis 7 does.
 */
import { cmpBytes, latin1, parseI64, utf8 } from "./bytes.ts"
import {
  arityError,
  arr,
  bulk,
  err,
  formatScore,
  int,
  nil,
  notInteger,
  type Protocol,
  queued,
  type Reply,
  syntaxError,
  wrongType,
} from "./protocol.ts"
import { type Database, memberKey, type Value, type ZMember } from "./store.ts"

export interface ZsetContext {
  database: Database
  /** The protocol replies are shaped for: RESP2 inside a script, else the connection's. */
  proto: Protocol
  apply: boolean
  random(): number
  wake(key: string): void
}

export const ZSET_WRITES = [
  "zunionstore",
  "zinterstore",
  "zdiffstore",
  "zrangestore",
  "zremrangebylex",
] as const

type Zset = Extract<Value, { kind: "zset" }>

const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")
const upper = (bytes: Uint8Array | undefined): string => text(bytes).toUpperCase()

/** A score as a reply: a bulk string in RESP2, a double in RESP3. */
export function scoreReply(score: number, proto: Protocol): Reply {
  return proto === 3 ? { t: "double", v: score } : bulk(formatScore(score))
}

/** Members with optional scores: flat in RESP2, `[member, score]` pairs in RESP3. */
export function scoredReply(items: ZMember[], withScores: boolean, proto: Protocol): Reply {
  if (!withScores) return arr(items.map((item) => ({ t: "bulk", v: item.member })))
  if (proto === 3)
    return arr(items.map((item) => arr([{ t: "bulk", v: item.member }, scoreReply(item.score, 3)])))
  return arr(items.flatMap((item) => [{ t: "bulk", v: item.member }, scoreReply(item.score, 2)]))
}

export function ordered(zset: Zset): ZMember[] {
  return [...zset.members.values()].sort((a, b) =>
    a.score !== b.score ? a.score - b.score : cmpBytes(a.member, b.member),
  )
}

function zsetAt(database: Database, key: string): Zset | Reply | null {
  const value = database.get(key)
  if (!value) return null
  return value.kind === "zset" ? value : wrongType()
}

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && "t" in value

function store(ctx: ZsetContext, dest: string, items: ZMember[]): Reply {
  ctx.database.delete(dest)
  if (items.length === 0) return int(0)
  const members = new Map<string, ZMember>()
  for (const item of items) members.set(memberKey(item.member), { ...item })
  ctx.database.put(dest, { kind: "zset", members })
  ctx.wake(dest)
  return int(members.size)
}

// ---------------------------------------------------------------------------------------------
// Ranges

interface ScoreBound {
  value: number
  exclusive: boolean
}

function parseFloatText(raw: string): number | null {
  const value = raw.trim().toLowerCase()
  if (value === "inf" || value === "+inf") return Infinity
  if (value === "-inf") return -Infinity
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isNaN(parsed) ? null : parsed
}

function parseScoreBound(raw: string): ScoreBound | null {
  const exclusive = raw.startsWith("(")
  const value = parseFloatText(exclusive ? raw.slice(1) : raw)
  return value === null ? null : { value, exclusive }
}

type LexBound =
  | { kind: "min" }
  | { kind: "max" }
  | { kind: "at"; value: Uint8Array; exclusive: boolean }

function parseLexBound(raw: Uint8Array | undefined): LexBound | null {
  if (!raw || raw.length === 0) return null
  const head = raw[0]
  if (raw.length === 1 && head === 0x2d) return { kind: "min" }
  if (raw.length === 1 && head === 0x2b) return { kind: "max" }
  if (head === 0x5b || head === 0x28)
    return { kind: "at", value: raw.slice(1), exclusive: head === 0x28 }
  return null
}

function aboveMin(member: Uint8Array, min: LexBound): boolean {
  if (min.kind === "min") return true
  if (min.kind === "max") return false
  const order = cmpBytes(member, min.value)
  return min.exclusive ? order > 0 : order >= 0
}

function belowMax(member: Uint8Array, max: LexBound): boolean {
  if (max.kind === "max") return true
  if (max.kind === "min") return false
  const order = cmpBytes(member, max.value)
  return max.exclusive ? order < 0 : order <= 0
}

const inScore = (score: number, min: ScoreBound, max: ScoreBound): boolean =>
  (min.exclusive ? score > min.value : score >= min.value) &&
  (max.exclusive ? score < max.value : score <= max.value)

type RangeCommand =
  | "zrange"
  | "zrevrange"
  | "zrangebyscore"
  | "zrevrangebyscore"
  | "zrangebylex"
  | "zrevrangebylex"
  | "zrangestore"

/**
 * The shared `ZRANGE` parser and walker (Redis `zrangeGenericCommand`). `args` start at the source
 * key. Returns the selected members in reply order, or an error reply.
 */
function selectRange(
  ctx: ZsetContext,
  command: RangeCommand,
  args: Uint8Array[],
): { items: ZMember[]; withScores: boolean } | Reply {
  let by: "rank" | "score" | "lex" = command.includes("byscore")
    ? "score"
    : command.includes("bylex")
      ? "lex"
      : "rank"
  let rev = command.startsWith("zrev")
  const modern = command === "zrange" || command === "zrangestore"
  let withScores = false
  let offset = 0n
  let limit = -1n
  for (let i = 3; i < args.length; i++) {
    const option = upper(args[i])
    if (option === "WITHSCORES" && command !== "zrangestore") withScores = true
    else if (option === "LIMIT" && i + 2 < args.length) {
      const o = parseI64(args[i + 1] ?? utf8(""))
      const c = parseI64(args[i + 2] ?? utf8(""))
      if (o === null || c === null) return notInteger()
      offset = o
      limit = c
      i += 2
    } else if (modern && option === "BYSCORE" && by === "rank") by = "score"
    else if (modern && option === "BYLEX" && by === "rank") by = "lex"
    else if (modern && option === "REV") rev = true
    else return syntaxError()
  }
  if (withScores && by === "lex")
    return err("ERR syntax error, WITHSCORES not supported in combination with BYLEX")
  if ((offset !== 0n || limit !== -1n) && by === "rank")
    return err(
      "ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX",
    )
  // The by-score and by-lex forms name the upper bound first when reversed.
  const swap = rev && by !== "rank"
  const minArg = swap ? args[2] : args[1]
  const maxArg = swap ? args[1] : args[2]
  let pick: (members: ZMember[]) => ZMember[]
  if (by === "rank") {
    const start = parseI64(minArg ?? utf8(""))
    const end = parseI64(maxArg ?? utf8(""))
    if (start === null || end === null) return notInteger()
    pick = (members) => {
      const length = BigInt(members.length)
      let from = start < 0n ? length + start : start
      let to = end < 0n ? length + end : end
      if (from < 0n) from = 0n
      if (from > to || from >= length) return []
      if (to >= length) to = length - 1n
      const source = rev ? members.slice().reverse() : members
      return source.slice(Number(from), Number(to) + 1)
    }
  } else {
    let test: (item: ZMember) => boolean
    if (by === "score") {
      const min = parseScoreBound(text(minArg))
      const max = parseScoreBound(text(maxArg))
      if (!min || !max) return err("ERR min or max is not a float")
      test = (item) => inScore(item.score, min, max)
    } else {
      const min = parseLexBound(minArg)
      const max = parseLexBound(maxArg)
      if (!min || !max) return err("ERR min or max not valid string range item")
      test = (item) => aboveMin(item.member, min) && belowMax(item.member, max)
    }
    pick = (members) => {
      if (offset < 0n) return []
      const source = (rev ? members.slice().reverse() : members).filter(test)
      const from = Number(offset)
      return limit < 0n ? source.slice(from) : source.slice(from, from + Number(limit))
    }
  }
  const zset = zsetAt(ctx.database, text(args[0]))
  if (isReply(zset)) return zset
  return { items: zset ? pick(ordered(zset)) : [], withScores }
}

export function cmdZrange(ctx: ZsetContext, command: RangeCommand, args: Uint8Array[]): Reply {
  if (command === "zrangestore") {
    if (args.length < 4) return arityError(command)
    const selected = selectRange(ctx, command, args.slice(1))
    if (isReply(selected)) return selected
    if (!ctx.apply) return queued()
    return store(ctx, text(args[0]), selected.items)
  }
  if (args.length < 3) return arityError(command)
  const selected = selectRange(ctx, command, args)
  if (isReply(selected)) return selected
  return scoredReply(selected.items, selected.withScores, ctx.proto)
}

export function cmdZlex(
  ctx: ZsetContext,
  command: "zlexcount" | "zremrangebylex",
  args: Uint8Array[],
): Reply {
  if (args.length !== 3) return arityError(command)
  const min = parseLexBound(args[1])
  const max = parseLexBound(args[2])
  if (!min || !max) return err("ERR min or max not valid string range item")
  const key = text(args[0])
  const zset = zsetAt(ctx.database, key)
  if (isReply(zset)) return zset
  if (!zset) return int(0)
  const matched = ordered(zset).filter(
    (item) => aboveMin(item.member, min) && belowMax(item.member, max),
  )
  if (command === "zlexcount") return int(matched.length)
  if (!ctx.apply) return queued()
  for (const item of matched) zset.members.delete(memberKey(item.member))
  if (matched.length > 0) {
    if (zset.members.size === 0) ctx.database.delete(key)
    else ctx.database.put(key, zset)
  }
  return int(matched.length)
}

// ---------------------------------------------------------------------------------------------
// ZUNION / ZINTER / ZDIFF and their STORE forms, ZINTERCARD

type AlgebraCommand = "zunionstore" | "zinterstore" | "zdiffstore" | "zunion" | "zinter" | "zdiff"

/** Every input's members with their scores; a plain set counts as score 1. */
function inputs(database: Database, keys: string[]): Array<Map<string, ZMember> | null> | Reply {
  const out: Array<Map<string, ZMember> | null> = []
  for (const key of keys) {
    const value = database.get(key)
    if (!value) out.push(null)
    else if (value.kind === "zset") out.push(value.members)
    else if (value.kind === "set") {
      const members = new Map<string, ZMember>()
      for (const [id, member] of value.members) members.set(id, { member, score: 1 })
      out.push(members)
    } else return wrongType()
  }
  return out
}

const nanToZero = (value: number): number => (Number.isNaN(value) ? 0 : value)

export function cmdZalgebra(ctx: ZsetContext, command: AlgebraCommand, args: Uint8Array[]): Reply {
  const stored = command.endsWith("store")
  const base = stored ? 1 : 0
  if (args.length < base + 2) return arityError(command)
  const numkeys = parseI64(args[base] ?? utf8(""))
  if (numkeys === null) return notInteger()
  if (numkeys < 1n) return err(`ERR at least 1 input key is needed for '${command}' command`)
  if (numkeys > BigInt(args.length - base - 1)) return syntaxError()
  const count = Number(numkeys)
  const keys = args.slice(base + 1, base + 1 + count).map(text)
  const diff = command.startsWith("zdiff")
  const weights = keys.map(() => 1)
  let aggregate: "SUM" | "MIN" | "MAX" = "SUM"
  let withScores = false
  for (let i = base + 1 + count; i < args.length; i++) {
    const option = upper(args[i])
    if (option === "WEIGHTS" && !diff && i + count < args.length) {
      for (let j = 0; j < count; j++) {
        const weight = parseFloatText(text(args[i + 1 + j]))
        if (weight === null) return err("ERR weight value is not a float")
        weights[j] = weight
      }
      i += count
    } else if (option === "AGGREGATE" && !diff && i + 1 < args.length) {
      const kind = upper(args[++i])
      if (kind !== "SUM" && kind !== "MIN" && kind !== "MAX") return syntaxError()
      aggregate = kind
    } else if (option === "WITHSCORES" && !stored) withScores = true
    else return syntaxError()
  }
  const sets = inputs(ctx.database, keys)
  if (isReply(sets)) return sets
  const combine = (left: number, right: number) =>
    aggregate === "SUM"
      ? nanToZero(left + right)
      : aggregate === "MIN"
        ? Math.min(left, right)
        : Math.max(left, right)
  const weighted = (score: number, index: number) => nanToZero(score * (weights[index] ?? 1))
  const result = new Map<string, ZMember>()
  if (command.startsWith("zunion")) {
    sets.forEach((members, index) => {
      for (const [id, item] of members ?? []) {
        const score = weighted(item.score, index)
        const current = result.get(id)
        result.set(id, {
          member: item.member,
          score: current ? combine(current.score, score) : score,
        })
      }
    })
  } else if (command.startsWith("zinter")) {
    const [first, ...rest] = sets
    for (const [id, item] of first ?? []) {
      let score = weighted(item.score, 0)
      let everywhere = true
      rest.forEach((members, offset) => {
        const other = members?.get(id)
        if (!other) everywhere = false
        else score = combine(score, weighted(other.score, offset + 1))
      })
      if (everywhere) result.set(id, { member: item.member, score })
    }
  } else {
    const [first, ...rest] = sets
    for (const [id, item] of first ?? [])
      if (!rest.some((members) => members?.has(id))) result.set(id, { ...item })
  }
  const items = [...result.values()].sort((a, b) =>
    a.score !== b.score ? a.score - b.score : cmpBytes(a.member, b.member),
  )
  if (!stored) return scoredReply(items, withScores, ctx.proto)
  if (!ctx.apply) return queued()
  return store(ctx, text(args[0]), items)
}

export function cmdZintercard(ctx: ZsetContext, args: Uint8Array[]): Reply {
  if (args.length < 2) return arityError("zintercard")
  const numkeys = parseI64(args[0] ?? utf8(""))
  if (numkeys === null) return notInteger()
  if (numkeys < 1n) return err("ERR at least 1 input key is needed for 'zintercard' command")
  if (numkeys > BigInt(args.length - 1)) return syntaxError()
  const count = Number(numkeys)
  let limit = 0n
  for (let i = 1 + count; i < args.length; i++) {
    if (upper(args[i]) !== "LIMIT" || i + 1 >= args.length) return syntaxError()
    const parsed = parseI64(args[++i] ?? utf8(""))
    if (parsed === null || parsed < 0n) return err("ERR LIMIT can't be negative")
    limit = parsed
  }
  const sets = inputs(ctx.database, args.slice(1, 1 + count).map(text))
  if (isReply(sets)) return sets
  const [first, ...rest] = sets
  let found = 0
  for (const id of first?.keys() ?? []) {
    if (!rest.every((members) => members?.has(id))) continue
    found++
    if (limit > 0n && BigInt(found) >= limit) break
  }
  return int(found)
}

// ---------------------------------------------------------------------------------------------
// ZRANDMEMBER

export function cmdZrandmember(ctx: ZsetContext, args: Uint8Array[]): Reply {
  if (args.length < 1 || args.length > 3) return arityError("zrandmember")
  if (args.length === 3 && upper(args[2]) !== "WITHSCORES") return syntaxError()
  const count = args.length >= 2 ? parseI64(args[1] ?? utf8("")) : null
  if (args.length >= 2 && count === null) return notInteger()
  const zset = zsetAt(ctx.database, text(args[0]))
  if (isReply(zset)) return zset
  if (count === null) {
    if (!zset) return nil()
    const items = ordered(zset)
    const item = items[Math.floor(ctx.random() * items.length)]
    return item ? { t: "bulk", v: item.member } : nil()
  }
  if (!zset || count === 0n) return arr([])
  const pool = ordered(zset)
  const picked: ZMember[] = []
  if (count < 0n) {
    for (let i = 0n; i < -count; i++) {
      const item = pool[Math.floor(ctx.random() * pool.length)]
      if (item) picked.push(item)
    }
  } else {
    const take = Math.min(pool.length, Number(count))
    for (let i = 0; i < take; i++) {
      const [item] = pool.splice(Math.floor(ctx.random() * pool.length), 1)
      if (item) picked.push(item)
    }
  }
  return scoredReply(picked, args.length === 3, ctx.proto)
}
