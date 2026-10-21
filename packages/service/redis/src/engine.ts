import { fromLatin1, globMatch, intReply, latin1, parseI64, utf8, utf8Text } from "./bytes.ts"
import { type RedisClock, wallClock } from "./clock.ts"
import { EXTRA_WRITES, type ExtraHost, extraCommand, moveList } from "./extra.ts"
import {
  type AclUser,
  cmdAcl,
  cmdCommand,
  cmdMemory,
  cmdObject,
  cmdSlowlog,
  commandFlags,
  monitorArgs,
  monitorLine,
  monitorSkips,
} from "./introspect.ts"
import { LuaFailure, LuaStatus, LuaTable, type LuaValue, luaGlobals, runLua } from "./lua.ts"
import { assertPortableDatabase, decodePortable, encodePortable } from "./portable.ts"
import {
  arityError,
  arr,
  authWithoutPassword,
  bulk,
  busyError,
  clusterDisabled,
  discardWithoutMulti,
  err,
  execAbort,
  execWithoutMulti,
  int,
  invalidExpire,
  map,
  nestedMulti,
  nil,
  nilArray,
  noAuth,
  noPerm,
  noScript,
  noSuchKey,
  notBusy,
  notFloat,
  notInteger,
  ok,
  oomError,
  pubsubOnly,
  push,
  queued,
  type Reply,
  readonlyError,
  scriptDenied,
  simple,
  syntaxError,
  unknownCommand,
  wrongPass,
  wrongType,
} from "./protocol.ts"
import { sha1Hex } from "./sha1.ts"
import {
  cmpId,
  Database,
  emptyStream,
  memberKey,
  parseStreamId,
  type StreamEntry,
  type Value,
} from "./store.ts"

export type { RedisClock } from "./clock.ts"
export type { Reply } from "./protocol.ts"

export class RedisConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RedisConnectionError"
  }
}

export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RedisReplyError"
  }
}

export interface RedisUser {
  name: string
  password: string
  readOnly?: boolean
}

export interface RedisOptions {
  clock?: RedisClock
  databases?: number
  password?: string
  users?: RedisUser[]
  maxmemory?: number
  maxmemoryPolicy?: "noeviction" | "allkeys-lru"
  seed?: number
}

export type RedisFault =
  | "readonly"
  | "oom"
  | "busy"
  | "disconnect"
  | "timeout"
  | "noscript"
  | { latencyMs: number }
  | null

interface Session {
  controlPrivileged?: boolean
  id: number
  db: number
  protocol: 2 | 3
  name: string
  libName: string
  libVer: string
  authenticated: boolean
  username: string
  readOnly: boolean
  multi: Array<{ name: string; args: Uint8Array[]; raw?: string }> | null
  multiFailed: boolean
  watching: Array<{ db: number; key: string; gen: number }>
  channels: Set<string>
  patterns: Set<string>
  dead: boolean
  quit: boolean
  inExec: boolean
  /** Port of the RESP listener this session arrived on, for INFO and CLIENT INFO. */
  localPort?: number | undefined
  /** `host:port` of the client socket, shown on the MONITOR stream. */
  remoteAddr?: string | undefined
  /** True after MONITOR: the connection receives every command other clients run. */
  monitor?: boolean
  onPush: (reply: Reply) => void
}

interface Waiter {
  kind: "list" | "zset" | "stream"
  keys: string[]
  db: number
  side: "left" | "right"
  destKey?: string
  destSide?: "left" | "right"
  deadline?: number
  group?: string
  consumer?: string
  streamIds?: string[]
  count: number
  noack?: boolean
  max?: boolean
  settled: boolean
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  unsub?: () => void
  timer?: ReturnType<typeof setTimeout>
}

const PREAUTH = new Set(["auth", "hello", "quit", "reset"])
const PUBSUB_OK = new Set([
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "ssubscribe",
  "sunsubscribe",
  "ping",
  "quit",
  "reset",
])
const IMMEDIATE = new Set([
  "exec",
  "discard",
  "multi",
  "watch",
  "unwatch",
  "quit",
  "reset",
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
])
const WRITES = new Set([
  "set",
  "setnx",
  "setex",
  "psetex",
  "mset",
  "append",
  "setrange",
  "incr",
  "incrby",
  "incrbyfloat",
  "decr",
  "decrby",
  "getset",
  "getdel",
  "getex",
  "del",
  "unlink",
  "expire",
  "pexpire",
  "expireat",
  "pexpireat",
  "persist",
  "rename",
  "renamenx",
  "copy",
  "flushdb",
  "flushall",
  "hset",
  "hmset",
  "hdel",
  "hincrby",
  "hincrbyfloat",
  "hsetnx",
  "lpush",
  "rpush",
  "lpop",
  "rpop",
  "lset",
  "lrem",
  "ltrim",
  "linsert",
  "lmove",
  "rpoplpush",
  "blpop",
  "brpop",
  "sadd",
  "srem",
  "spop",
  "smove",
  "zadd",
  "zrem",
  "zincrby",
  "zpopmin",
  "zpopmax",
  "bzpopmin",
  "bzpopmax",
  "zremrangebyrank",
  "zremrangebyscore",
  "xadd",
  "xdel",
  "xtrim",
  "xgroup",
  "xreadgroup",
  "xack",
  "xclaim",
  "xautoclaim",
  "eval",
  "evalsha",
  ...EXTRA_WRITES,
])
const SCRIPT_BLOCKED = new Set([
  "blpop",
  "brpop",
  "bzpopmin",
  "bzpopmax",
  "auth",
  "select",
  "watch",
  "multi",
  "exec",
  "discard",
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "shutdown",
  "monitor",
])

const VERSION = "7.2.4"
const I64_MAX = 9223372036854775807n
/** Nominal figures for what a real server measures from its process and host. */
const BASE_MEMORY = 1_048_576
const SYSTEM_MEMORY = 17_179_869_184

/** Redis `bytesToHuman`: bytes below 1 KiB, else two decimals with a K, M or G suffix. */
function humanBytes(value: number): string {
  if (value < 1024) return `${value}B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)}K`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)}M`
  return `${(value / 1024 ** 3).toFixed(2)}G`
}

function text(bytes: Uint8Array | undefined): string {
  return bytes ? latin1(bytes) : ""
}

function upper(bytes: Uint8Array | undefined): string {
  return text(bytes).toUpperCase()
}

function scoreText(score: number): string {
  if (Number.isNaN(score)) return "nan"
  if (score === Infinity) return "inf"
  if (score === -Infinity) return "-inf"
  if (Number.isInteger(score)) return String(score)
  return String(score)
}

function parseScore(bytes: Uint8Array | undefined): number | null {
  if (!bytes) return null
  const value = text(bytes).trim().toLowerCase()
  if (value === "+inf" || value === "inf") return Infinity
  if (value === "-inf") return -Infinity
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return null
  const score = Number(value)
  return Number.isFinite(score) ? score : null
}

function parseTimeout(bytes: Uint8Array | undefined): number | null {
  if (!bytes) return null
  const value = Number(text(bytes))
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

function decodeReply(reply: Reply): unknown {
  switch (reply.t) {
    case "simple":
      return reply.v
    case "error":
      throw new RedisReplyError(reply.v)
    case "int":
      return typeof reply.v === "bigint" ? intReply(reply.v) : reply.v
    case "bulk":
      return reply.v === null ? null : utf8Text(reply.v)
    case "array":
      return reply.v === null ? null : reply.v.map((item) => decodeReply(item))
    case "null":
      return null
    case "bool":
      return reply.v
    case "double":
      return reply.v
    case "map": {
      const record: Record<string, unknown> = {}
      for (const [key, value] of reply.v) record[String(decodeReply(key))] = decodeReply(value)
      return record
    }
    case "push":
      return reply.v.map((item) => decodeReply(item))
    default: {
      const never: never = reply
      return never
    }
  }
}

function luaToBytes(value: LuaValue): Uint8Array {
  if (typeof value === "string") return fromLatin1(value)
  if (typeof value === "number")
    return utf8(Number.isInteger(value) ? String(value) : String(value))
  if (typeof value === "boolean") return utf8(value ? "1" : "")
  if (value === null) return utf8("")
  if (value instanceof LuaStatus) return utf8(value.ok)
  return utf8("")
}

function replyToLua(reply: Reply): LuaValue {
  switch (reply.t) {
    case "error":
      throw new Error(reply.v)
    case "simple":
      return new LuaStatus(reply.v)
    case "int":
      return typeof reply.v === "bigint" ? Number(reply.v) : reply.v
    case "bulk":
      return reply.v === null ? false : latin1(reply.v)
    case "array":
    case "push": {
      if (reply.t === "array" && reply.v === null) return false
      const items = reply.v ?? []
      const table = new LuaTable()
      items.forEach((item, index) => {
        table.set(index + 1, replyToLua(item))
      })
      return table
    }
    case "null":
      return false
    case "bool":
      return reply.v
    case "double":
      return reply.v
    case "map": {
      const table = new LuaTable()
      for (const [key, value] of reply.v) {
        const luaKey = replyToLua(key)
        table.set(luaKey === false ? "" : luaKey, replyToLua(value))
      }
      return table
    }
    default: {
      const never: never = reply
      return never
    }
  }
}

function luaToReply(value: LuaValue): Reply {
  if (value === null || value === false) return nil()
  if (value === true) return int(1)
  if (value instanceof LuaStatus) return simple(value.ok)
  if (value instanceof LuaFailure) return err(value.err)
  if (typeof value === "number") {
    if (Number.isInteger(value)) return int(value)
    return bulk(String(value))
  }
  if (typeof value === "string") return { t: "bulk", v: fromLatin1(value) }
  if (value instanceof LuaTable) {
    const okField = value.get("ok")
    const errField = value.get("err")
    if (typeof okField === "string") return simple(okField)
    if (typeof errField === "string") return err(errField)
    const items: Reply[] = []
    for (let i = 1; value.has(i); i++) items.push(luaToReply(value.get(i)))
    return arr(items)
  }
  return nil()
}

function entryFields(entry: StreamEntry): Reply {
  return arr([bulk(entry.id), arr(entry.fields.map((field) => ({ t: "bulk", v: field })))])
}

export class Redis {
  readonly clock: RedisClock
  private readonly dbs: Database[]
  private readonly password: string | undefined
  private readonly users: RedisUser[]
  private readonly authRequired: boolean
  readonly maxmemory: number
  private policy: "noeviction" | "allkeys-lru"
  private rngState: number
  private readonly initialRngState: number
  private faultValue: RedisFault = null
  private tail: Promise<void> = Promise.resolve()
  private sessions = new Set<Session>()
  private nextClientId = 1
  private waiters: Waiter[] = []
  private channelSubs = new Map<string, Set<Session>>()
  private patternSubs = new Map<string, Set<Session>>()
  private scripts = new Map<string, string>()
  private invoked = ""
  private scriptDepth = 0
  private commandCount = 0
  private readonly commandStats = new Map<string, number>()
  private peakMemory = 0
  private startedAt = 0
  private closed = false
  private controlPaused = false
  private pendingCommands = 0
  private readonly pendingLatency = new Set<() => void>()
  private readonly snapshots = new WeakMap<
    object,
    {
      dbs: object[]
      scripts: Map<string, string>
      rng: number
      fault: RedisFault
      clock: ReturnType<RedisClock["state"]>
      paused: boolean
    }
  >()
  consumersPaused = false
  private readonly disconnectListeners = new Set<(session: Session) => void>()

  constructor(options: RedisOptions = {}) {
    this.clock = options.clock ?? wallClock()
    const count = options.databases ?? 16
    this.dbs = Array.from({ length: count }, () => new Database(this.clock))
    this.password = options.password
    this.users = options.users ?? []
    this.authRequired = options.password !== undefined || this.users.length > 0
    this.maxmemory = options.maxmemory ?? 0
    this.policy = options.maxmemoryPolicy ?? "noeviction"
    this.initialRngState = options.seed ?? 1
    this.rngState = this.initialRngState
    this.startedAt = this.clock.now()
  }

  client(): RedisClient {
    return new RedisClient(this, this.createSession())
  }

  advance(ms: number): void {
    this.clock.advance(ms)
  }

  fault(value: RedisFault): void {
    this.faultValue = value
    if (value === "busy") return
    if (value === "disconnect" || value === "timeout") {
      for (const session of [...this.sessions]) this.dropSession(session, value)
    }
  }

  pauseConsumers(paused = true): void {
    this.consumersPaused = paused
    if (!paused) this.enqueue(() => this.wakeAll())
  }

  waiterCount(): number {
    return this.waiters.length
  }
  connections(): number {
    return this.sessions.size
  }
  pendingJobs(): number {
    let count = 0
    for (const db of this.dbs)
      for (const key of db.keys()) {
        if (!/:(?:wait|paused|delayed|active|prioritized)$/.test(key)) continue
        const value = db.get(key)
        if (value?.kind === "list") count += value.items.length
        if (value?.kind === "zset") count += value.members.size
      }
    return count
  }
  activeCommands(): number {
    return (
      Math.max(0, this.pendingCommands - this.waiters.length) +
      [...this.sessions].filter((session) => session.multi !== null || session.watching.length > 0)
        .length
    )
  }
  nextEvent(): number | undefined {
    let earliest: number | undefined
    const consider = (time: number) => {
      if (earliest === undefined || time < earliest) earliest = time
    }
    for (const db of this.dbs) {
      const point = db.snapshot() as { values: Map<string, Value>; expires: Map<string, number> }
      for (const time of point.expires.values()) consider(time)
      for (const [key, value] of point.values)
        if (key.endsWith(":delayed") && value.kind === "zset")
          for (const member of value.members.values()) consider(Math.floor(member.score / 4096))
    }
    return earliest
  }
  settleTimers(): void {
    for (const db of this.dbs) db.keys()
  }
  activeJobs(): number {
    let count = 0
    for (const db of this.dbs)
      for (const key of db.keys()) {
        if (!key.endsWith(":active")) continue
        const value = db.get(key)
        if (value?.kind === "list") count += value.items.length
      }
    return count
  }
  fence(): () => void {
    if (this.controlPaused) throw new Error("Redis control in progress")
    this.controlPaused = true
    return () => {
      this.controlPaused = false
    }
  }
  snapshot(): object {
    if (this.pendingCommands > 0) throw new Error("Redis is not quiescent")
    const handle = {}
    this.snapshots.set(handle, {
      dbs: this.dbs.map((db) => db.snapshot()),
      scripts: new Map(this.scripts),
      rng: this.rngState,
      fault: structuredClone(this.faultValue),
      clock: this.clock.state(),
      paused: this.consumersPaused,
    })
    return handle
  }
  exportSnapshot(handle: unknown): unknown {
    const point =
      typeof handle === "object" && handle !== null ? this.snapshots.get(handle) : undefined
    if (!point) throw new Error("invalid Redis checkpoint")
    return { format: "mockingbird.redis/v1", data: encodePortable(point) }
  }
  importSnapshot(document: unknown): object {
    if (
      !document ||
      typeof document !== "object" ||
      (document as { format?: unknown }).format !== "mockingbird.redis/v1"
    )
      throw new Error("invalid Redis archive")
    const point = decodePortable((document as { data?: unknown }).data) as NonNullable<
      ReturnType<typeof this.snapshots.get>
    >
    if (
      !point ||
      !Array.isArray(point.dbs) ||
      point.dbs.length !== this.dbs.length ||
      !(point.scripts instanceof Map) ||
      !Number.isFinite(point.rng) ||
      typeof point.paused !== "boolean" ||
      !point.clock ||
      !Number.isFinite(point.clock.now) ||
      typeof point.clock.frozen !== "boolean"
    )
      throw new Error("invalid Redis archive state")
    for (const db of point.dbs) assertPortableDatabase(db)
    if (
      !Number.isSafeInteger(point.rng) ||
      point.rng < 0 ||
      point.rng > 0xffffffff ||
      [...point.scripts].some(
        ([key, script]) => typeof key !== "string" || typeof script !== "string",
      )
    )
      throw new Error("invalid Redis random/script state")
    const handle = {}
    this.snapshots.set(handle, point)
    return handle
  }
  restore(handle: unknown): void {
    const point =
      typeof handle === "object" && handle !== null ? this.snapshots.get(handle) : undefined
    if (!point || this.pendingCommands > 0) throw new Error("invalid Redis restore")
    this.dbs.forEach((db, i) => {
      db.restore(point.dbs[i] as object)
    })
    this.scripts = new Map(point.scripts)
    this.rngState = point.rng
    this.faultValue = structuredClone(point.fault)
    this.consumersPaused = point.paused
    this.clock.freeze()
    this.clock.set(point.clock.now)
    if (!point.clock.frozen) this.clock.unfreeze()
  }
  disconnect(session: Session): void {
    if (this.sessions.has(session)) this.dropSession(session, "disconnect")
  }

  inspect(db = 0): Array<{ key: string; type: string; pttl: number }> {
    const database = this.database(db)
    return database.keys().map((key) => ({
      key,
      type: database.get(key)?.kind ?? "none",
      pttl: database.pttl(key),
    }))
  }

  reset(): void {
    this.rngState = this.initialRngState
    for (const database of this.dbs) database.clear()
    this.scripts.clear()
    this.faultValue = null
    this.clock.reset()
    this.startedAt = this.clock.now()
    this.commandStats.clear()
    this.consumersPaused = false
    for (const waiter of [...this.waiters]) {
      this.finishWaiter(waiter, nilArray())
    }
    for (const session of this.sessions) {
      this.leavePubsub(session)
      session.multi = null
      session.multiFailed = false
      session.watching = []
    }
  }

  close(): void {
    this.closed = true
    for (const cancel of [...this.pendingLatency]) cancel()
    for (const waiter of [...this.waiters]) {
      this.failWaiter(waiter, new RedisConnectionError("Connection is closed"))
    }
    for (const session of [...this.sessions]) this.disconnect(session)
  }

  onDisconnect(listener: (session: Session) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  createSession(): Session {
    const session: Session = {
      id: this.nextClientId++,
      db: 0,
      protocol: 2,
      name: "",
      libName: "",
      libVer: "",
      authenticated: !this.authRequired,
      username: "default",
      readOnly: false,
      multi: null,
      multiFailed: false,
      watching: [],
      channels: new Set(),
      patterns: new Set(),
      dead: false,
      quit: false,
      inExec: false,
      onPush: () => undefined,
    }
    this.sessions.add(session)
    return session
  }

  perform(session: Session, name: string, args: Uint8Array[]): Promise<Reply> {
    if (this.controlPaused && !session.controlPrivileged)
      return Promise.resolve(err("BUSY fleet control in progress"))
    if (session.dead || this.closed) {
      return Promise.reject(new RedisConnectionError("Connection is closed"))
    }
    this.pendingCommands++
    return new Promise<Reply>((resolve, reject) => {
      this.enqueue(async () => {
        try {
          if (session.dead || this.closed) {
            reject(new RedisConnectionError("Connection is closed"))
            return
          }
          if (this.faultValue === "disconnect" || this.faultValue === "timeout") {
            const message = this.faultValue === "timeout" ? "Command timed out" : "Connection reset"
            this.dropSession(session, this.faultValue)
            reject(new RedisConnectionError(message))
            return
          }
          await this.applyLatency()
          if (session.dead || this.closed) {
            reject(new RedisConnectionError("Connection is closed"))
            return
          }
          const result = this.dispatch(session, name, args)
          if (result instanceof Promise) {
            result.then(resolve, reject)
            return
          }
          resolve(result)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }).finally(() => {
      this.pendingCommands--
    })
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.tail = this.tail.then(task, task).then(
      () => undefined,
      () => undefined,
    )
  }

  private applyLatency(): Promise<void> {
    const fault = this.faultValue
    if (fault === null || typeof fault === "string") return Promise.resolve()
    const target = this.clock.now() + fault.latencyMs
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (this.clock.now() < target) return
        unsub()
        this.pendingLatency.delete(cancel)
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      const cancel = () => {
        unsub()
        if (timer !== undefined) clearTimeout(timer)
        this.pendingLatency.delete(cancel)
        resolve()
      }
      const unsub = this.clock.subscribe(finish)
      this.pendingLatency.add(cancel)
      if (!this.clock.manual) timer = setTimeout(finish, fault.latencyMs)
      finish()
    })
  }

  private dropSession(session: Session, reason: "disconnect" | "timeout"): void {
    session.dead = true
    const message = reason === "timeout" ? "Command timed out" : "Connection reset"
    for (const waiter of [...this.waiters]) {
      if (waiter.db >= 0 && this.sessionOf(waiter) === session) {
        this.failWaiter(waiter, new RedisConnectionError(message))
      }
    }
    this.leavePubsub(session)
    this.sessions.delete(session)
    for (const listener of this.disconnectListeners) listener(session)
  }

  private sessionOf(waiter: Waiter): Session | null {
    for (const session of this.sessions) {
      if (session === waiterSession.get(waiter)) return session
    }
    return waiterSession.get(waiter) ?? null
  }

  private database(index: number): Database {
    const database = this.dbs[index]
    if (!database) throw new Error("db index out of range")
    return database
  }

  private random(): number {
    this.rngState = (Math.imul(1664525, this.rngState) + 1013904223) >>> 0
    return this.rngState / 4294967296
  }

  private memory(): number {
    return this.dbs.reduce((sum, database) => sum + database.memory(), 0)
  }

  private dispatch(session: Session, nameRaw: string, args: Uint8Array[]): Reply | Promise<Reply> {
    const command = nameRaw.toLowerCase()
    this.invoked = nameRaw
    this.commandCount++
    this.commandStats.set(command, (this.commandStats.get(command) ?? 0) + 1)
    if (this.authRequired && !session.authenticated && !PREAUTH.has(command)) return noAuth()
    if (session.channels.size + session.patterns.size > 0 && !PUBSUB_OK.has(command)) {
      return pubsubOnly(command)
    }
    if (this.faultValue === "busy" && command !== "script" && command !== "shutdown")
      return busyError()
    if (session.monitor && this.touchesKeyspace(command))
      return err("ERR Replica can't interact with the keyspace")
    if (session.multi && !IMMEDIATE.has(command)) {
      const checked = this.execCmd(session, command, args, false)
      if (checked instanceof Promise || checked.t === "error") {
        session.multiFailed = true
        return checked instanceof Promise ? syntaxError() : checked
      }
      session.multi.push({
        name: command,
        args: args.map((arg) => Uint8Array.from(arg)),
        raw: nameRaw,
      })
      return queued()
    }
    return this.execCmd(session, command, args, true, nameRaw)
  }

  /** What a MONITOR connection may not run: Redis treats it like a replica link. */
  private touchesKeyspace(command: string): boolean {
    if (command === "publish" || command === "spublish" || command === "eval") return true
    if (command === "evalsha") return true
    const flags = commandFlags(command)
    return flags.includes("readonly") || flags.includes("write")
  }

  /**
   * Runs one command and shows it to MONITOR connections. `raw` is the name as the client typed
   * it, which is what Redis prints. EVAL is shown before the script's own calls (origin `lua`);
   * everything else after it ran, so SELECT shows the new database. Commands Redis refuses
   * before running them (unknown, wrong arity, NOAUTH, queued in MULTI) are not shown.
   */
  private execCmd(
    session: Session,
    command: string,
    args: Uint8Array[],
    apply: boolean,
    raw: string = command,
  ): Reply | Promise<Reply> {
    if (!apply || !this.monitoring()) return this.execCommand(session, command, args, apply)
    const early = this.scriptDepth === 0 && (command === "eval" || command === "evalsha")
    if (early) this.feedMonitors(session, command, args, raw)
    const reply = this.execCommand(session, command, args, apply)
    if (early) return reply
    if (reply instanceof Promise) this.feedMonitors(session, command, args, raw)
    else if (!monitorSkips(reply)) this.feedMonitors(session, command, args, raw)
    return reply
  }

  private monitoring(): boolean {
    for (const session of this.sessions) if (session.monitor) return true
    return false
  }

  private feedMonitors(session: Session, command: string, args: Uint8Array[], raw: string): void {
    const flags = commandFlags(command)
    if (command === "monitor" || flags.includes("admin") || flags.includes("skip_monitor")) return
    const origin = this.scriptDepth > 0 ? "lua" : (session.remoteAddr ?? `127.0.0.1:${session.id}`)
    const line = monitorLine(this.clock.now(), session.db, origin, raw, monitorArgs(command, args))
    for (const other of this.sessions) if (other.monitor && !other.dead) other.onPush(simple(line))
  }

  private execCommand(
    session: Session,
    command: string,
    args: Uint8Array[],
    apply: boolean,
  ): Reply | Promise<Reply> {
    if (apply && this.scriptDepth > 0 && SCRIPT_BLOCKED.has(command)) return scriptDenied()
    if (
      apply &&
      command === "xread" &&
      args.some((arg) => text(arg).toUpperCase() === "BLOCK") &&
      this.scriptDepth > 0
    ) {
      return scriptDenied()
    }
    if (
      apply &&
      command === "xreadgroup" &&
      args.some((arg) => text(arg).toUpperCase() === "BLOCK") &&
      this.scriptDepth > 0
    ) {
      return scriptDenied()
    }
    const denied = this.guardWrite(session, command, apply)
    if (denied) return denied
    switch (command) {
      case "ping":
        return this.cmdPing(session, args)
      case "echo":
        return args.length === 1 ? bulk(args[0] ?? null) : arityError("echo")
      case "quit":
        session.quit = true
        return ok()
      case "auth":
        return this.cmdAuth(session, args)
      case "hello":
        return this.cmdHello(session, args)
      case "select":
        return this.cmdSelect(session, args)
      case "reset":
        return this.cmdReset(session)
      case "client":
        return this.cmdClient(session, args, apply)
      case "info":
        return bulk(
          this.info(
            session,
            args.map((arg) => text(arg)),
          ),
        )
      case "time":
        return this.cmdTime()
      case "role":
        return arr([simple("master"), int(0), arr([])])
      case "readonly":
      case "asking":
        return clusterDisabled()
      case "cluster":
        return clusterDisabled()
      case "module":
        return args.length >= 1 && upper(args[0]) === "LIST" ? arr([]) : arityError("module")
      case "command":
        return cmdCommand(args)
      case "monitor":
        if (args.length > 0) return arityError("monitor")
        if (!apply) return queued()
        session.monitor = true
        return ok()
      case "object":
        return cmdObject(this.database(session.db), args)
      case "memory":
        return cmdMemory(this.database(session.db), args)
      case "slowlog":
        return cmdSlowlog(args)
      case "acl":
        return cmdAcl(this.aclUsers(), session.username, args)
      case "config":
        return this.cmdConfig(args, apply)
      case "dbsize":
        return int(this.database(session.db).keys().length)
      case "flushdb":
        if (!apply) return queued()
        this.database(session.db).clear()
        return ok()
      case "flushall":
        if (!apply) return queued()
        for (const database of this.dbs) database.clear()
        return ok()
      case "randomkey":
        return this.cmdRandomKey(session)
      case "scan":
        return this.cmdScan(session, args)
      case "keys":
        return this.cmdKeys(session, args)
      case "type":
        return this.cmdType(session, args)
      case "exists":
        return this.cmdExists(session, args)
      case "del":
      case "unlink":
        return this.cmdDel(session, args, apply)
      case "rename":
        return this.cmdRename(session, args, apply, false)
      case "renamenx":
        return this.cmdRename(session, args, apply, true)
      case "expire":
      case "pexpire":
      case "expireat":
      case "pexpireat":
        return this.cmdExpire(session, command, args, apply)
      case "ttl":
      case "pttl":
        return this.cmdTtl(session, command, args)
      case "persist":
        return this.cmdPersist(session, args, apply)
      case "get":
        return this.cmdGet(session, args)
      case "set":
        return this.cmdSet(session, args, apply)
      case "setnx":
        return this.cmdSetnx(session, args, apply)
      case "setex":
        return args.length === 3
          ? this.cmdSet(
              session,
              [args[0] ?? utf8(""), args[2] ?? utf8(""), utf8("EX"), args[1] ?? utf8("")],
              apply,
              "setex",
            )
          : arityError("setex")
      case "psetex":
        return args.length === 3
          ? this.cmdSet(
              session,
              [args[0] ?? utf8(""), args[2] ?? utf8(""), utf8("PX"), args[1] ?? utf8("")],
              apply,
              "psetex",
            )
          : arityError("psetex")
      case "mget":
        return this.cmdMget(session, args)
      case "mset":
        return this.cmdMset(session, args, apply)
      case "append":
        return this.cmdAppend(session, args, apply)
      case "strlen":
        return this.cmdStrlen(session, args)
      case "getrange":
        return this.cmdGetRange(session, args)
      case "setrange":
        return this.cmdSetRange(session, args, apply)
      case "incr":
        return this.cmdIncr(session, args, 1n, apply)
      case "decr":
        return this.cmdIncr(session, args, -1n, apply)
      case "incrby":
      case "decrby":
        return this.cmdIncrBy(session, command, args, apply)
      case "incrbyfloat":
        return this.cmdIncrByFloat(session, args, apply, false)
      case "getset":
        return args.length === 2
          ? this.cmdSet(session, [args[0] ?? utf8(""), args[1] ?? utf8(""), utf8("GET")], apply)
          : arityError("getset")
      case "getdel":
        return this.cmdGetDel(session, args, apply)
      case "getex":
        return this.cmdGetEx(session, args, apply)
      case "hset":
      case "hmset":
      case "hsetnx":
      case "hget":
      case "hdel":
      case "hexists":
      case "hgetall":
      case "hkeys":
      case "hvals":
      case "hlen":
      case "hmget":
      case "hincrby":
      case "hincrbyfloat":
      case "hstrlen":
        return this.cmdHash(session, command, args, apply)
      case "lpush":
      case "rpush":
      case "lpop":
      case "rpop":
      case "llen":
      case "lpos":
      case "lrange":
      case "lindex":
      case "lset":
      case "lrem":
      case "ltrim":
      case "linsert":
      case "lmove":
      case "rpoplpush":
        return this.cmdList(session, command, args, apply)
      case "blpop":
        return this.cmdBlockingList(session, args, apply, "left")
      case "brpop":
        return this.cmdBlockingList(session, args, apply, "right")
      case "sadd":
      case "srem":
      case "sismember":
      case "smismember":
      case "smembers":
      case "scard":
      case "spop":
      case "srandmember":
      case "sinter":
      case "sunion":
      case "sdiff":
      case "smove":
        return this.cmdSetFamily(session, command, args, apply)
      case "zadd":
      case "zrem":
      case "zcard":
      case "zscore":
      case "zmscore":
      case "zrank":
      case "zrevrank":
      case "zrange":
      case "zrevrange":
      case "zrangebyscore":
      case "zrevrangebyscore":
      case "zcount":
      case "zpopmin":
      case "zpopmax":
      case "zincrby":
      case "zremrangebyscore":
      case "zremrangebyrank":
        return this.cmdZset(session, command, args, apply)
      case "bzpopmin":
        return this.cmdBlockingZset(session, args, apply, false)
      case "bzpopmax":
        return this.cmdBlockingZset(session, args, apply, true)
      case "xadd":
      case "xlen":
      case "xrange":
      case "xrevrange":
      case "xdel":
      case "xtrim":
      case "xgroup":
      case "xread":
      case "xreadgroup":
      case "xack":
      case "xpending":
      case "xclaim":
      case "xautoclaim":
      case "xinfo":
        return this.cmdStream(session, command, args, apply)
      case "subscribe":
      case "unsubscribe":
      case "psubscribe":
      case "punsubscribe":
        return this.cmdSub(session, command, args)
      case "publish":
        return this.cmdPublish(args)
      case "pubsub":
        return this.cmdPubsub(args)
      case "multi":
        if (session.multi) return nestedMulti()
        session.multi = []
        session.multiFailed = false
        return ok()
      case "exec":
        return this.cmdExec(session)
      case "discard":
        return this.cmdDiscard(session)
      case "watch":
        return this.cmdWatch(session, args)
      case "unwatch":
        session.watching = []
        return ok()
      case "eval":
      case "evalsha":
        return this.cmdEval(session, command, args, apply)
      case "script":
        return this.cmdScript(args, apply)
      case "shutdown":
        return ok()
      default:
        return (
          extraCommand(this.extraHost, session, command, args, apply) ??
          unknownCommand(this.invoked, args)
        )
    }
  }

  private readonly extraHost: ExtraHost<Session> = {
    now: () => this.clock.now(),
    databaseCount: () => this.dbs.length,
    scriptDepth: () => this.scriptDepth,
    consumersPaused: () => this.consumersPaused,
    database: (index) => this.database(index),
    wake: (db, key) => this.wake(db, key),
    block: (spec) =>
      this.block({
        kind: "list",
        keys: [spec.key],
        db: spec.db,
        side: spec.side,
        destKey: spec.destKey,
        destSide: spec.destSide,
        count: 1,
        ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
        session: spec.session,
      }),
  }

  private aclUsers(): AclUser[] {
    const fallback = this.users.find((user) => user.name === "default")
    const users: AclUser[] = [
      {
        name: "default",
        password: this.authRequired ? (fallback?.password ?? this.password) : undefined,
        readOnly: fallback?.readOnly === true,
      },
    ]
    for (const user of this.users)
      if (user.name !== "default")
        users.push({ name: user.name, password: user.password, readOnly: user.readOnly === true })
    return users
  }

  private guardWrite(session: Session, command: string, apply: boolean): Reply | null {
    if (!apply || !WRITES.has(command)) return null
    if (session.readOnly) return noPerm(command)
    if (this.faultValue === "readonly") return readonlyError()
    if (this.faultValue === "oom") return oomError()
    if (this.maxmemory > 0 && this.memory() > this.maxmemory && this.policy === "noeviction") {
      return oomError()
    }
    if (this.maxmemory > 0 && this.policy === "allkeys-lru") {
      while (this.memory() > this.maxmemory) {
        let evicted = false
        for (const database of this.dbs) {
          if (database.evictLru()) {
            evicted = true
            break
          }
        }
        if (!evicted) break
      }
    }
    return null
  }

  private cmdPing(session: Session, args: Uint8Array[]): Reply {
    if (args.length > 1) return arityError("ping")
    if (session.channels.size + session.patterns.size > 0) {
      return push([bulk("pong"), args[0] ? { t: "bulk", v: args[0] } : bulk("")])
    }
    if (args.length === 1) return { t: "bulk", v: args[0] ?? null }
    return simple("PONG")
  }

  private cmdAuth(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1 && args.length !== 2) return arityError("auth")
    const user = args.length === 2 ? text(args[0]) : "default"
    const password = text(args.length === 2 ? args[1] : args[0])
    if (!this.authRequired) return authWithoutPassword(password)
    const account =
      user === "default"
        ? {
            password: this.users.find((item) => item.name === "default")?.password ?? this.password,
            readOnly: this.users.find((item) => item.name === "default")?.readOnly === true,
          }
        : this.users.find((item) => item.name === user)
    if (!account || account.password === undefined || account.password !== password)
      return wrongPass()
    session.authenticated = true
    session.username = user
    session.readOnly = account.readOnly === true
    return ok()
  }

  private cmdHello(session: Session, args: Uint8Array[]): Reply {
    let protocol = session.protocol
    let index = 0
    if (args.length > 0) {
      const requested = Number(text(args[0]))
      if (requested !== 2 && requested !== 3) return err("NOPROTO unsupported protocol version")
      protocol = requested
      index = 1
    }
    while (index < args.length) {
      const option = upper(args[index])
      if (option === "AUTH") {
        const user = args[index + 1]
        const pass = args[index + 2]
        if (!user || !pass) return syntaxError()
        const result = this.cmdAuth(session, [user, pass])
        if (result.t === "error") return result
        index += 3
        continue
      }
      if (option === "SETNAME") {
        const name = args[index + 1]
        if (!name) return syntaxError()
        session.name = text(name)
        index += 2
        continue
      }
      return syntaxError()
    }
    session.protocol = protocol
    return map([
      [bulk("server"), bulk("redis")],
      [bulk("version"), bulk(VERSION)],
      [bulk("proto"), int(protocol)],
      [bulk("id"), int(session.id)],
      [bulk("mode"), bulk("standalone")],
      [bulk("role"), bulk("master")],
      [bulk("modules"), arr([])],
    ])
  }

  private cmdSelect(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError("select")
    const index = parseI64(args[0] ?? utf8(""))
    if (index === null) return notInteger()
    if (index < 0n || index >= BigInt(this.dbs.length)) return err("ERR DB index is out of range")
    session.db = Number(index)
    return ok()
  }

  private cmdReset(session: Session): Reply {
    session.multi = null
    session.multiFailed = false
    session.watching = []
    this.leavePubsub(session)
    session.name = ""
    session.db = 0
    session.protocol = 2
    session.authenticated = !this.authRequired
    session.readOnly = false
    session.monitor = false
    return simple("RESET")
  }

  private cmdClient(session: Session, args: Uint8Array[], apply: boolean): Reply {
    const sub = upper(args[0])
    if (sub === "SETNAME") {
      if (args.length !== 2) return arityError("client|setname")
      if (!apply) return queued()
      session.name = text(args[1])
      return ok()
    }
    if (sub === "GETNAME") return session.name ? bulk(session.name) : nil()
    if (sub === "SETINFO") {
      if (args.length !== 3) return arityError("client|setinfo")
      const kind = upper(args[1])
      if (kind !== "LIB-NAME" && kind !== "LIB-VER") return syntaxError()
      if (!apply) return queued()
      if (kind === "LIB-NAME") session.libName = text(args[2])
      else session.libVer = text(args[2])
      return ok()
    }
    if (sub === "ID") return int(session.id)
    if (sub === "INFO") return bulk(this.clientInfo(session))
    if (sub === "LIST") {
      return bulk([...this.sessions].map((item) => this.clientInfo(item)).join("\n"))
    }
    if (sub === "PAUSE" || sub === "UNPAUSE") return ok()
    if (!sub) return arityError("client")
    return err(`ERR unknown subcommand '${text(args[0]).toLowerCase()}'. Try CLIENT HELP.`)
  }

  private clientInfo(session: Session): string {
    return `id=${session.id} addr=127.0.0.1:${session.id} laddr=127.0.0.1:${session.localPort ?? 6379} name=${session.name} db=${session.db} sub=${session.channels.size} psub=${session.patterns.size} multi=${session.multi ? session.multi.length : -1} lib-name=${session.libName} lib-ver=${session.libVer}`
  }

  /**
   * INFO. Sections and field names follow Redis 7.2; values the emulator has no process behind
   * (CPU time, RSS, system memory) are fixed nominal numbers so parsers get well-formed fields.
   */
  private info(session: Session, sections: string[]): string {
    if (session.id < 0) return ""
    const used = this.memory() + BASE_MEMORY
    this.peakMemory = Math.max(this.peakMemory, used)
    const ratio = (value: number) => value.toFixed(2)
    const uptime = Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 1000))
    const blocks = new Map<string, string[]>([
      [
        "server",
        [
          "# Server",
          `redis_version:${VERSION}`,
          "redis_mode:standalone",
          "os:mockingbird",
          "arch_bits:64",
          `tcp_port:${session.localPort ?? 6379}`,
          `uptime_in_seconds:${uptime}`,
          `uptime_in_days:${Math.floor(uptime / 86400)}`,
        ],
      ],
      [
        "clients",
        [
          "# Clients",
          `connected_clients:${this.sessions.size}`,
          "maxclients:10000",
          `blocked_clients:${this.waiters.length}`,
          "tracking_clients:0",
        ],
      ],
      [
        "memory",
        [
          "# Memory",
          `used_memory:${used}`,
          `used_memory_human:${humanBytes(used)}`,
          `used_memory_rss:${used}`,
          `used_memory_rss_human:${humanBytes(used)}`,
          `used_memory_peak:${this.peakMemory}`,
          `used_memory_peak_human:${humanBytes(this.peakMemory)}`,
          `total_system_memory:${SYSTEM_MEMORY}`,
          `total_system_memory_human:${humanBytes(SYSTEM_MEMORY)}`,
          `maxmemory:${this.maxmemory}`,
          `maxmemory_human:${humanBytes(this.maxmemory)}`,
          `maxmemory_policy:${this.policy}`,
          `mem_fragmentation_ratio:${ratio(1)}`,
          "mem_allocator:mockingbird",
        ],
      ],
      [
        "persistence",
        ["# Persistence", "loading:0", "rdb_changes_since_last_save:0", "aof_enabled:0"],
      ],
      ["stats", ["# Stats", `total_commands_processed:${this.commandCount}`]],
      ["replication", ["# Replication", "role:master", "connected_slaves:0"]],
      [
        "cpu",
        [
          "# CPU",
          "used_cpu_sys:0.000000",
          "used_cpu_user:0.000000",
          "used_cpu_sys_children:0.000000",
          "used_cpu_user_children:0.000000",
        ],
      ],
      ["modules", ["# Modules"]],
      [
        "commandstats",
        [
          "# Commandstats",
          ...[...this.commandStats].map(
            ([name, calls]) =>
              `cmdstat_${name}:calls=${calls},usec=0,usec_per_call=0.00,rejected_calls=0,failed_calls=0`,
          ),
        ],
      ],
      ["errorstats", ["# Errorstats"]],
      ["cluster", ["# Cluster", "cluster_enabled:0"]],
      ["keyspace", ["# Keyspace", ...this.keyspaceLines()]],
    ])
    // `default` is every section except commandstats; `all` and `everything` add it.
    const group = (name: string): string[] | null => {
      if (name === "everything" || name === "all") return [...blocks.keys()]
      if (name === "default") return [...blocks.keys()].filter((key) => key !== "commandstats")
      return blocks.has(name) ? [name] : null
    }
    const chosen: string[] = []
    for (const name of sections.length > 0 ? sections : ["default"]) {
      for (const key of group(name.toLowerCase()) ?? []) if (!chosen.includes(key)) chosen.push(key)
    }
    return chosen.map((key) => `${(blocks.get(key) ?? []).join("\r\n")}\r\n`).join("\r\n")
  }

  private keyspaceLines(): string[] {
    const lines: string[] = []
    this.dbs.forEach((database, index) => {
      const keys = database.keys()
      if (keys.length === 0) return
      let expires = 0
      for (const key of keys) if (database.pttl(key) >= 0) expires++
      lines.push(`db${index}:keys=${keys.length},expires=${expires},avg_ttl=0`)
    })
    return lines
  }

  private cmdTime(): Reply {
    const now = Math.trunc(this.clock.now())
    const seconds = Math.trunc(now / 1000)
    const micros = (now % 1000) * 1000
    return arr([bulk(String(seconds)), bulk(String(micros))])
  }

  private cmdConfig(args: Uint8Array[], apply: boolean): Reply {
    const sub = upper(args[0])
    if (sub === "GET") {
      if (args.length !== 2) return arityError("config|get")
      const key = text(args[1]).toLowerCase()
      const value =
        key === "maxmemory"
          ? String(this.maxmemory)
          : key === "maxmemory-policy"
            ? this.policy
            : key === "timeout"
              ? "0"
              : key === "databases"
                ? String(this.dbs.length)
                : null
      if (value === null) return arr([])
      return arr([bulk(key), bulk(value)])
    }
    if (sub === "SET") {
      if (args.length !== 3) return arityError("config|set")
      if (!apply) return queued()
      const key = text(args[1]).toLowerCase()
      const value = text(args[2])
      if (key === "maxmemory") {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed < 0) return err("ERR Invalid argument")
        return ok()
      }
      if (key === "maxmemory-policy") {
        if (value !== "noeviction" && value !== "allkeys-lru") return err("ERR Invalid argument")
        this.policy = value
        return ok()
      }
      return err("ERR Unsupported CONFIG parameter")
    }
    return arityError("config")
  }

  private cmdRandomKey(session: Session): Reply {
    const keys = this.database(session.db).keys()
    if (keys.length === 0) return nil()
    const key = keys[Math.floor(this.random() * keys.length)] ?? keys[0]
    return key === undefined ? nil() : { t: "bulk", v: fromLatin1(key) }
  }

  private cmdScan(session: Session, args: Uint8Array[]): Reply {
    if (args.length < 1) return arityError("scan")
    const cursor = Number(text(args[0]))
    if (!Number.isInteger(cursor) || cursor < 0) return err("ERR invalid cursor")
    let pattern = "*"
    let count = 10
    let type: string | null = null
    for (let i = 1; i < args.length; i++) {
      const option = upper(args[i])
      if (option === "TYPE") {
        const value = args[++i]
        if (!value) return syntaxError()
        type = text(value).toLowerCase()
      } else if (option === "MATCH") {
        const value = args[++i]
        if (!value) return syntaxError()
        pattern = text(value)
      } else if (option === "COUNT") {
        const value = args[++i]
        const parsed = value ? parseI64(value) : null
        if (parsed === null || parsed <= 0n) return syntaxError()
        count = Number(parsed)
      } else return syntaxError()
    }
    const database = this.database(session.db)
    // An unknown type name matches nothing, as in Redis.
    const keys = database
      .matching(pattern)
      .filter((key) => type === null || database.get(key)?.kind === type)
    const slice = keys.slice(cursor, cursor + count)
    const next = cursor + count >= keys.length ? 0 : cursor + count
    return arr([
      bulk(String(next)),
      arr(slice.map((key) => ({ t: "bulk" as const, v: fromLatin1(key) }))),
    ])
  }

  private cmdKeys(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError("keys")
    const keys = this.database(session.db).matching(text(args[0]))
    return arr(keys.map((key) => ({ t: "bulk" as const, v: fromLatin1(key) })))
  }

  private cmdType(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError("type")
    const value = this.database(session.db).get(text(args[0]))
    return simple(value?.kind ?? "none")
  }

  private cmdExists(session: Session, args: Uint8Array[]): Reply {
    if (args.length < 1) return arityError("exists")
    const database = this.database(session.db)
    return int(args.filter((arg) => database.has(text(arg))).length)
  }

  private cmdDel(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 1) return arityError("del")
    if (!apply) return queued()
    const database = this.database(session.db)
    let removed = 0
    for (const arg of args) if (database.delete(text(arg))) removed++
    return int(removed)
  }

  private cmdRename(session: Session, args: Uint8Array[], apply: boolean, nx: boolean): Reply {
    if (args.length !== 2) return arityError(nx ? "renamenx" : "rename")
    const source = text(args[0])
    const dest = text(args[1])
    if (source === dest) return err("ERR source and destination objects are the same")
    const database = this.database(session.db)
    if (!database.has(source)) return noSuchKey()
    if (nx && database.has(dest)) return int(0)
    if (!apply) return queued()
    database.rename(source, dest)
    return nx ? int(1) : ok()
  }

  private cmdExpire(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 2) return arityError(command)
    const key = text(args[0])
    const amount = parseI64(args[1] ?? utf8(""))
    if (amount === null) return notInteger()
    let flag = ""
    if (args.length === 3) flag = upper(args[2])
    else if (args.length > 3) return syntaxError()
    if (flag && !["NX", "XX", "GT", "LT"].includes(flag)) return syntaxError()
    const database = this.database(session.db)
    if (!database.has(key)) return int(0)
    if (!apply) return queued()
    if (amount < 0n && (command === "expire" || command === "pexpire")) {
      database.delete(key)
      return int(1)
    }
    const now = database.now()
    const absolute =
      command === "expire"
        ? now + Number(amount) * 1000
        : command === "pexpire"
          ? now + Number(amount)
          : command === "expireat"
            ? Number(amount) * 1000
            : Number(amount)
    const current = database.expiry(key)
    if (flag === "NX" && current !== null) return int(0)
    if (flag === "XX" && current === null) return int(0)
    if ((flag === "GT" || flag === "LT") && current === null) return int(0)
    if (flag === "GT" && current !== null && absolute <= current) return int(0)
    if (flag === "LT" && current !== null && absolute >= current) return int(0)
    database.setExpiry(key, absolute)
    return int(1)
  }

  private cmdTtl(session: Session, command: string, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError(command)
    const pttl = this.database(session.db).pttl(text(args[0]))
    if (pttl < 0) return int(pttl)
    // Redis rounds TTL to the nearest second (half up) rather than truncating.
    return int(command === "pttl" ? pttl : Math.floor((pttl + 500) / 1000))
  }

  private cmdPersist(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 1) return arityError("persist")
    const database = this.database(session.db)
    const key = text(args[0])
    if (database.pttl(key) < 0) return int(0)
    if (!apply) return queued()
    database.setExpiry(key, null)
    return int(1)
  }

  private stringAt(database: Database, key: string): Uint8Array | Reply | null {
    const value = database.get(key)
    if (!value) return null
    if (value.kind !== "string") return wrongType()
    return value.bytes
  }

  private cmdGet(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError("get")
    const value = this.stringAt(this.database(session.db), text(args[0]))
    if (value instanceof Uint8Array) return { t: "bulk", v: value }
    if (value === null) return nil()
    return value
  }

  /**
   * SET and its aliases. `command` names the caller in the expire-time error, as Redis does.
   * Options are parsed first and the expiry is validated after, like Redis, so a bad
   * expiry is rejected before NX/XX are considered and leaves any existing value alone.
   */
  private cmdSet(session: Session, args: Uint8Array[], apply: boolean, command = "set"): Reply {
    if (args.length < 2) return arityError(command)
    const key = text(args[0])
    const value = args[1]
    if (!value) return arityError(command)
    let nx = false
    let xx = false
    let get = false
    let mode: "ex" | "px" | "exat" | "pxat" | "keep" | null = null
    let rawAmount: Uint8Array | undefined
    for (let i = 2; i < args.length; i++) {
      const option = upper(args[i])
      if (option === "NX") {
        if (xx) return syntaxError()
        nx = true
      } else if (option === "XX") {
        if (nx) return syntaxError()
        xx = true
      } else if (option === "GET") get = true
      else if (option === "KEEPTTL") {
        if (mode !== null && mode !== "keep") return syntaxError()
        mode = "keep"
      } else if (option === "EX" || option === "PX" || option === "EXAT" || option === "PXAT") {
        const next = option.toLowerCase() as "ex" | "px" | "exat" | "pxat"
        // Redis lets the same expiry option repeat (the last value wins) but not mix.
        if ((mode !== null && mode !== next) || i + 1 >= args.length) return syntaxError()
        mode = next
        rawAmount = args[++i]
      } else return syntaxError()
    }
    const database = this.database(session.db)
    let expireAt: bigint | null = null
    // Like Redis, a bad expiry is a runtime error: inside MULTI it surfaces from EXEC.
    if (apply && mode !== null && mode !== "keep") {
      const amount = rawAmount ? parseI64(rawAmount) : null
      if (amount === null) return notInteger()
      const seconds = mode === "ex" || mode === "exat"
      // Redis rejects zero, negative and seconds values whose millisecond form overflows.
      if (amount <= 0n || (seconds && amount > I64_MAX / 1000n)) return invalidExpire(command)
      const millis = seconds ? amount * 1000n : amount
      expireAt = mode === "ex" || mode === "px" ? BigInt(database.now()) + millis : millis
      // now + millis wraps past the 64-bit range in Redis and lands in the past: the key is gone.
      if (expireAt > I64_MAX) expireAt = 0n
    }
    const existing = database.get(key)
    if (get && existing && existing.kind !== "string") return wrongType()
    const previous =
      existing?.kind === "string" ? ({ t: "bulk", v: existing.bytes } as Reply) : nil()
    if ((nx && existing) || (xx && !existing)) return get ? previous : nil()
    if (!apply) return queued()
    const kept = mode === "keep" ? database.expiry(key) : null
    database.put(key, { kind: "string", bytes: value })
    if (expireAt !== null) database.setExpiry(key, Number(expireAt))
    else database.setExpiry(key, kept)
    return get ? previous : ok()
  }

  private cmdSetnx(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 2) return arityError("setnx")
    if (!apply) return queued()
    const database = this.database(session.db)
    const key = text(args[0])
    if (database.has(key)) return int(0)
    database.put(key, { kind: "string", bytes: args[1] ?? utf8("") })
    database.setExpiry(key, null)
    return int(1)
  }

  private cmdMget(session: Session, args: Uint8Array[]): Reply {
    if (args.length < 1) return arityError("mget")
    return arr(args.map((arg) => this.cmdGet(session, [arg])))
  }

  private cmdMset(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 2 || args.length % 2 !== 0) return arityError("mset")
    if (!apply) return queued()
    for (let i = 0; i < args.length; i += 2) {
      const result = this.cmdSet(session, [args[i] ?? utf8(""), args[i + 1] ?? utf8("")], true)
      if (result.t === "error") return result
    }
    return ok()
  }

  private cmdAppend(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 2) return arityError("append")
    const database = this.database(session.db)
    const key = text(args[0])
    const extra = args[1] ?? utf8("")
    const current = this.stringAt(database, key)
    if (current && !(current instanceof Uint8Array)) return current
    if (!apply) return queued()
    const bytes = current instanceof Uint8Array ? concatBytes(current, extra) : extra
    database.put(key, { kind: "string", bytes })
    return int(bytes.length)
  }

  private cmdStrlen(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 1) return arityError("strlen")
    const value = this.stringAt(this.database(session.db), text(args[0]))
    if (value instanceof Uint8Array) return int(value.length)
    if (value === null) return int(0)
    return value
  }

  private cmdGetRange(session: Session, args: Uint8Array[]): Reply {
    if (args.length !== 3) return arityError("getrange")
    const value = this.stringAt(this.database(session.db), text(args[0]))
    if (value && !(value instanceof Uint8Array)) return value
    const bytes = value instanceof Uint8Array ? value : utf8("")
    const [start, end] = indexes(bytes.length, args[1], args[2])
    if (start > end) return bulk("")
    return { t: "bulk", v: bytes.slice(start, end + 1) }
  }

  private cmdSetRange(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 3) return arityError("setrange")
    const offset = parseI64(args[1] ?? utf8(""))
    if (offset === null || offset < 0n) return err("ERR offset is out of range")
    const database = this.database(session.db)
    const key = text(args[0])
    const current = this.stringAt(database, key)
    if (current && !(current instanceof Uint8Array)) return current
    if (!apply) return queued()
    const patch = args[2] ?? utf8("")
    const base = current instanceof Uint8Array ? current : new Uint8Array()
    const next = new Uint8Array(Math.max(base.length, Number(offset) + patch.length))
    next.set(base)
    next.set(patch, Number(offset))
    database.put(key, { kind: "string", bytes: next })
    return int(next.length)
  }

  private cmdIncr(session: Session, args: Uint8Array[], delta: bigint, apply: boolean): Reply {
    if (args.length !== 1) return arityError(delta < 0n ? "decr" : "incr")
    return this.addInteger(session, text(args[0]), delta, apply)
  }

  private cmdIncrBy(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 2) return arityError(command)
    const delta = parseI64(args[1] ?? utf8(""))
    if (delta === null) return notInteger()
    return this.addInteger(session, text(args[0]), command === "decrby" ? -delta : delta, apply)
  }

  private addInteger(session: Session, key: string, delta: bigint, apply: boolean): Reply {
    const database = this.database(session.db)
    const current = this.stringAt(database, key)
    if (current && !(current instanceof Uint8Array)) return current
    let value = 0n
    if (current instanceof Uint8Array) {
      const parsed = parseI64(current)
      if (parsed === null) return notInteger()
      value = parsed
    }
    const next = value + delta
    if (next > 9223372036854775807n || next < -9223372036854775808n) return notInteger()
    if (!apply) return queued()
    database.put(key, { kind: "string", bytes: utf8(next.toString()) })
    return int(intReply(next))
  }

  private cmdIncrByFloat(
    session: Session,
    args: Uint8Array[],
    apply: boolean,
    hash: boolean,
  ): Reply {
    if (hash) return syntaxError()
    if (args.length !== 2) return arityError("incrbyfloat")
    const delta = parseScore(args[1])
    if (delta === null) return notFloat()
    const database = this.database(session.db)
    const key = text(args[0])
    const current = this.stringAt(database, key)
    if (current && !(current instanceof Uint8Array)) return current
    const base = current instanceof Uint8Array ? parseScore(current) : 0
    if (base === null) return notFloat()
    if (!apply) return queued()
    const next = scoreText(base + delta)
    database.put(key, { kind: "string", bytes: utf8(next) })
    return bulk(next)
  }

  private cmdGetDel(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length !== 1) return arityError("getdel")
    const got = this.cmdGet(session, args)
    if (got.t === "error" || got.t !== "bulk" || got.v === null) return got
    if (!apply) return queued()
    this.database(session.db).delete(text(args[0]))
    return got
  }

  private cmdGetEx(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 1) return arityError("getex")
    const got = this.cmdGet(session, [args[0] ?? utf8("")])
    if (got.t === "error") return got
    if (args.length === 1) return got
    if (!apply) return queued()
    const option = upper(args[1])
    if (option === "PERSIST") {
      this.database(session.db).setExpiry(text(args[0]), null)
      return got
    }
    const result = this.cmdExpire(
      session,
      option === "EX"
        ? "expire"
        : option === "PX"
          ? "pexpire"
          : option === "EXAT"
            ? "expireat"
            : "pexpireat",
      [args[0] ?? utf8(""), args[2] ?? utf8("")],
      true,
    )
    if (result.t === "error") return result
    return got
  }

  private requireHash(
    database: Database,
    key: string,
    create: boolean,
  ): Extract<Value, { kind: "hash" }> | Reply | null {
    const value = database.get(key)
    if (!value) {
      if (!create) return null
      const created: Extract<Value, { kind: "hash" }> = { kind: "hash", fields: new Map() }
      database.put(key, created)
      return created
    }
    if (value.kind !== "hash") return wrongType()
    return value
  }

  private cmdHash(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    const database = this.database(session.db)
    const key = text(args[0])
    if (command === "hset" || command === "hmset" || command === "hsetnx") {
      if (args.length < 3 || (args.length - 1) % 2 !== 0) return arityError(command)
      const hash = this.requireHash(database, key, false)
      if (hash && !(hash instanceof Object && "fields" in hash) && hash !== null)
        return hash as Reply
      if (!apply) return queued()
      const target = this.requireHash(database, key, true)
      if (!target || !("fields" in target)) return target ?? wrongType()
      let added = 0
      for (let i = 1; i < args.length; i += 2) {
        const field = memberKey(args[i] ?? utf8(""))
        const value = args[i + 1] ?? utf8("")
        if (command === "hsetnx" && target.fields.has(field)) continue
        if (!target.fields.has(field)) added++
        target.fields.set(field, value)
        target.fieldExpires?.delete(field)
      }
      database.put(key, target)
      return command === "hmset" ? ok() : int(command === "hsetnx" ? (added > 0 ? 1 : 0) : added)
    }
    if (command === "hget") {
      if (args.length !== 2) return arityError("hget")
      const hash = this.requireHash(database, key, false)
      if (hash === null) return nil()
      if (!("fields" in hash)) return hash
      const value = hash.fields.get(memberKey(args[1] ?? utf8("")))
      return value ? { t: "bulk", v: value } : nil()
    }
    if (command === "hdel") {
      if (args.length < 2) return arityError("hdel")
      const hash = this.requireHash(database, key, false)
      if (hash === null) return int(0)
      if (!("fields" in hash)) return hash
      if (!apply) return queued()
      let removed = 0
      for (let i = 1; i < args.length; i++) {
        const field = memberKey(args[i] ?? utf8(""))
        hash.fieldExpires?.delete(field)
        if (hash.fields.delete(field)) removed++
      }
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, hash)
      return int(removed)
    }
    if (command === "hexists") {
      if (args.length !== 2) return arityError("hexists")
      const hash = this.requireHash(database, key, false)
      if (hash === null) return int(0)
      if (!("fields" in hash)) return hash
      return int(hash.fields.has(memberKey(args[1] ?? utf8(""))) ? 1 : 0)
    }
    if (command === "hlen") {
      if (args.length !== 1) return arityError("hlen")
      const hash = this.requireHash(database, key, false)
      if (hash === null) return int(0)
      if (!("fields" in hash)) return hash
      return int(hash.fields.size)
    }
    if (command === "hstrlen") {
      if (args.length !== 2) return arityError("hstrlen")
      const hash = this.requireHash(database, key, false)
      if (hash === null) return int(0)
      if (!("fields" in hash)) return hash
      return int(hash.fields.get(memberKey(args[1] ?? utf8("")))?.length ?? 0)
    }
    if (command === "hkeys" || command === "hvals" || command === "hgetall") {
      if (args.length !== 1) return arityError(command)
      const hash = this.requireHash(database, key, false)
      if (hash === null) return arr([])
      if (!("fields" in hash)) return hash
      const items: Reply[] = []
      for (const [field, value] of hash.fields) {
        if (command !== "hvals") items.push({ t: "bulk", v: fromLatin1(field) })
        if (command !== "hkeys") items.push({ t: "bulk", v: value })
      }
      return arr(items)
    }
    if (command === "hmget") {
      if (args.length < 2) return arityError("hmget")
      const hash = this.requireHash(database, key, false)
      if (hash && !("fields" in hash)) return hash
      return arr(
        args.slice(1).map((field) => {
          const value = hash && "fields" in hash ? hash.fields.get(memberKey(field)) : undefined
          return value ? { t: "bulk" as const, v: value } : nil()
        }),
      )
    }
    if (command === "hincrby" || command === "hincrbyfloat") {
      if (args.length !== 3) return arityError(command)
      const hash = this.requireHash(database, key, false)
      if (hash && !("fields" in hash)) return hash
      const field = memberKey(args[1] ?? utf8(""))
      const current = hash && "fields" in hash ? hash.fields.get(field) : undefined
      if (command === "hincrby") {
        const delta = parseI64(args[2] ?? utf8(""))
        if (delta === null) return notInteger()
        const base = current ? parseI64(current) : 0n
        if (base === null) return notInteger()
        if (!apply) return queued()
        const target = this.requireHash(database, key, true)
        if (!target || !("fields" in target)) return target ?? wrongType()
        const next = base + delta
        target.fields.set(field, utf8(next.toString()))
        database.put(key, target)
        return int(intReply(next))
      }
      const delta = parseScore(args[2])
      if (delta === null) return notFloat()
      const base = current ? parseScore(current) : 0
      if (base === null) return notFloat()
      if (!apply) return queued()
      const target = this.requireHash(database, key, true)
      if (!target || !("fields" in target)) return target ?? wrongType()
      const next = scoreText(base + delta)
      target.fields.set(field, utf8(next))
      database.put(key, target)
      return bulk(next)
    }
    return unknownCommand(command, args)
  }

  private requireList(
    database: Database,
    key: string,
    create: boolean,
  ): Extract<Value, { kind: "list" }> | Reply | null {
    const value = database.get(key)
    if (!value) {
      if (!create) return null
      const created: Extract<Value, { kind: "list" }> = { kind: "list", items: [] }
      database.put(key, created)
      return created
    }
    if (value.kind !== "list") return wrongType()
    return value
  }

  private cmdList(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    const database = this.database(session.db)
    const key = text(args[0])
    if (command === "lpos") {
      if (args.length < 2) return arityError(command)
      let rank = 1
      let count: number | undefined
      let maxlen = 0
      for (let i = 2; i < args.length; i += 2) {
        const option = upper(args[i])
        const value = parseI64(args[i + 1] ?? utf8(""))
        if (value === null) return notInteger()
        if (option === "RANK") {
          rank = Number(value)
          if (rank === 0)
            return err(
              "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ...",
            )
        } else if (option === "COUNT") {
          count = Number(value)
          if (count < 0) return err("ERR COUNT can't be negative")
        } else if (option === "MAXLEN") {
          maxlen = Number(value)
          if (maxlen < 0) return err("ERR MAXLEN can't be negative")
        } else return syntaxError()
      }
      const list = this.requireList(database, key, false)
      if (list === null) return count === undefined ? nil() : arr([])
      if (!("items" in list)) return list
      const target = args[1] ?? utf8("")
      const positions: number[] = []
      let matches = 0
      const length = maxlen === 0 ? list.items.length : Math.min(maxlen, list.items.length)
      for (let i = 0; i < length; i++) {
        const index = rank < 0 ? list.items.length - i - 1 : i
        const item = list.items[index]
        if (!item || compareBytes(item, target) !== 0) continue
        if (++matches < Math.abs(rank)) continue
        positions.push(index)
        if (count === undefined || (count > 0 && positions.length >= count)) break
      }
      return count === undefined
        ? positions[0] === undefined
          ? nil()
          : int(positions[0])
        : arr(positions.map(int))
    }
    if (command === "lpush" || command === "rpush") {
      if (args.length < 2) return arityError(command)
      const existing = this.requireList(database, key, false)
      if (existing && !("items" in existing)) return existing
      if (!apply) return queued()
      const list = this.requireList(database, key, true)
      if (!list || !("items" in list)) return list ?? wrongType()
      const items = args.slice(1)
      if (command === "lpush") for (const item of items) list.items.unshift(item)
      else for (const item of items) list.items.push(item)
      database.put(key, list)
      const length = list.items.length
      this.wake(session.db, key)
      return int(length)
    }
    if (command === "lpop" || command === "rpop") {
      if (args.length < 1 || args.length > 2) return arityError(command)
      const list = this.requireList(database, key, false)
      if (list === null) return args.length === 2 ? nilArray() : nil()
      if (!("items" in list)) return list
      const count = args.length === 2 ? parseI64(args[1] ?? utf8("")) : null
      if (args.length === 2 && (count === null || count < 0n)) return notInteger()
      if (!apply) return queued()
      const take = count === null ? 1 : Number(count)
      const popped: Uint8Array[] = []
      for (let i = 0; i < take && list.items.length > 0; i++) {
        const item = command === "lpop" ? list.items.shift() : list.items.pop()
        if (item) popped.push(item)
      }
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, list)
      if (count === null) return popped[0] ? { t: "bulk", v: popped[0] } : nil()
      return arr(popped.map((item) => ({ t: "bulk" as const, v: item })))
    }
    if (command === "llen") {
      if (args.length !== 1) return arityError("llen")
      const list = this.requireList(database, key, false)
      if (list === null) return int(0)
      if (!("items" in list)) return list
      return int(list.items.length)
    }
    if (command === "lrange") {
      if (args.length !== 3) return arityError("lrange")
      const list = this.requireList(database, key, false)
      if (list === null) return arr([])
      if (!("items" in list)) return list
      const [start, end] = indexes(list.items.length, args[1], args[2])
      if (start > end) return arr([])
      return arr(list.items.slice(start, end + 1).map((item) => ({ t: "bulk" as const, v: item })))
    }
    if (command === "lindex") {
      if (args.length !== 2) return arityError("lindex")
      const list = this.requireList(database, key, false)
      if (list === null) return nil()
      if (!("items" in list)) return list
      const at = listIndex(list.items.length, args[1])
      const item = at === null ? undefined : list.items[at]
      return item ? { t: "bulk", v: item } : nil()
    }
    if (command === "lset") {
      if (args.length !== 3) return arityError("lset")
      const list = this.requireList(database, key, false)
      if (list === null) return err("ERR no such key")
      if (!("items" in list)) return list
      const at = listIndex(list.items.length, args[1])
      if (at === null || list.items[at] === undefined) return err("ERR index out of range")
      if (!apply) return queued()
      list.items[at] = args[2] ?? utf8("")
      database.put(key, list)
      return ok()
    }
    if (command === "lrem") {
      if (args.length !== 3) return arityError("lrem")
      const list = this.requireList(database, key, false)
      if (list === null) return int(0)
      if (!("items" in list)) return list
      const count = parseI64(args[1] ?? utf8(""))
      if (count === null) return notInteger()
      if (!apply) return queued()
      const target = args[2] ?? utf8("")
      const matches = list.items
        .map((item, index) => ({ item, index }))
        .filter(
          (item) =>
            item.item.length === target.length &&
            item.item.every((byte, index) => byte === target[index]),
        )
      const chosen =
        count === 0n
          ? matches
          : count > 0n
            ? matches.slice(0, Number(count))
            : matches.slice(matches.length + Number(count))
      const remove = new Set(chosen.map((item) => item.index))
      list.items = list.items.filter((_, index) => !remove.has(index))
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, list)
      return int(chosen.length)
    }
    if (command === "ltrim") {
      if (args.length !== 3) return arityError("ltrim")
      const list = this.requireList(database, key, false)
      if (list === null) return ok()
      if (!("items" in list)) return list
      if (!apply) return queued()
      const [start, end] = indexes(list.items.length, args[1], args[2])
      list.items = start > end ? [] : list.items.slice(start, end + 1)
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, list)
      return ok()
    }
    if (command === "linsert") {
      if (args.length !== 4) return arityError("linsert")
      const list = this.requireList(database, key, false)
      if (list === null) return int(0)
      if (!("items" in list)) return list
      const where = upper(args[1])
      if (where !== "BEFORE" && where !== "AFTER") return syntaxError()
      const pivot = args[2] ?? utf8("")
      const at = list.items.findIndex(
        (item) =>
          item.length === pivot.length && item.every((byte, index) => byte === pivot[index]),
      )
      if (at < 0) return int(-1)
      if (!apply) return queued()
      list.items.splice(where === "BEFORE" ? at : at + 1, 0, args[3] ?? utf8(""))
      database.put(key, list)
      this.wake(session.db, key)
      return int(list.items.length)
    }
    if (command === "lmove" || command === "rpoplpush") {
      const source = key
      const dest = command === "rpoplpush" ? text(args[1]) : text(args[1])
      const from = command === "rpoplpush" ? "right" : upper(args[2])
      const to = command === "rpoplpush" ? "left" : upper(args[3])
      if (command === "lmove" && args.length !== 4) return arityError("lmove")
      if (command === "rpoplpush" && args.length !== 2) return arityError("rpoplpush")
      if (from !== "LEFT" && from !== "RIGHT" && command === "lmove") return syntaxError()
      if (to !== "LEFT" && to !== "RIGHT" && command === "lmove") return syntaxError()
      const list = this.requireList(database, source, false)
      if (list === null) return nil()
      if (!("items" in list)) return list
      const destList = this.requireList(database, dest, false)
      if (destList && !("items" in destList)) return destList
      if (!apply) return queued()
      const item =
        (command === "rpoplpush" || from === "RIGHT" ? list.items.pop() : list.items.shift()) ??
        null
      if (!item) return nil()
      database.dropIfEmpty(source)
      if (database.has(source)) database.put(source, list)
      const target = this.requireList(database, dest, true)
      if (!target || !("items" in target)) return target ?? wrongType()
      if (command === "rpoplpush" || to === "LEFT") target.items.unshift(item)
      else target.items.push(item)
      database.put(dest, target)
      this.wake(session.db, dest)
      return { t: "bulk", v: item }
    }
    return unknownCommand(command, args)
  }

  private cmdBlockingList(
    session: Session,
    args: Uint8Array[],
    apply: boolean,
    side: "left" | "right",
  ): Reply | Promise<Reply> {
    const name = side === "left" ? "blpop" : "brpop"
    if (args.length < 2) return arityError(name)
    const timeout = parseTimeout(args[args.length - 1])
    if (timeout === null) return err("ERR timeout is not a float or out of range")
    const keys = args.slice(0, -1).map((arg) => text(arg))
    for (const key of keys) {
      const value = this.database(session.db).get(key)
      if (value && value.kind !== "list") return wrongType()
    }
    if (!apply) return queued()
    const immediate = this.takeList(session.db, keys, side)
    if (immediate) return immediate
    if (session.inExec || this.scriptDepth > 0) return nilArray()
    return this.block({
      kind: "list",
      keys,
      db: session.db,
      side,
      count: 1,
      ...(timeout > 0 ? { deadline: this.clock.now() + timeout * 1000 } : {}),
      session,
    })
  }

  private takeList(dbIndex: number, keys: string[], side: "left" | "right"): Reply | null {
    if (this.consumersPaused) return null
    const database = this.database(dbIndex)
    for (const key of keys) {
      const value = database.get(key)
      if (!value) continue
      if (value.kind !== "list") return wrongType()
      const item = side === "left" ? value.items.shift() : value.items.pop()
      if (!item) continue
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, value)
      return arr([bulk(key), { t: "bulk", v: item }])
    }
    return null
  }

  private requireSet(database: Database, key: string, create: boolean) {
    const value = database.get(key)
    if (!value) {
      if (!create) return null
      const created: Extract<Value, { kind: "set" }> = { kind: "set", members: new Map() }
      database.put(key, created)
      return created
    }
    if (value.kind !== "set") return wrongType()
    return value
  }

  private cmdSetFamily(
    session: Session,
    command: string,
    args: Uint8Array[],
    apply: boolean,
  ): Reply {
    const database = this.database(session.db)
    const key = text(args[0])
    if (command === "sadd" || command === "srem") {
      if (args.length < 2) return arityError(command)
      const existing = this.requireSet(database, key, false)
      if (existing && !("members" in existing)) return existing
      if (!apply) return queued()
      if (command === "srem" && existing === null) return int(0)
      const set = this.requireSet(database, key, command === "sadd")
      if (!set || !("members" in set)) return set ?? int(0)
      let changed = 0
      for (const arg of args.slice(1)) {
        const member = memberKey(arg)
        if (command === "sadd" && !set.members.has(member)) {
          set.members.set(member, arg)
          changed++
        }
        if (command === "srem" && set.members.delete(member)) changed++
      }
      if (command === "sadd") database.put(key, set)
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, set)
      return int(changed)
    }
    if (command === "sismember") {
      if (args.length !== 2) return arityError("sismember")
      const set = this.requireSet(database, key, false)
      if (set === null) return int(0)
      if (!("members" in set)) return set
      return int(set.members.has(memberKey(args[1] ?? utf8(""))) ? 1 : 0)
    }
    if (command === "smismember") {
      if (args.length < 2) return arityError("smismember")
      const set = this.requireSet(database, key, false)
      if (set && !("members" in set)) return set
      return arr(
        args
          .slice(1)
          .map((arg) => int(set && "members" in set && set.members.has(memberKey(arg)) ? 1 : 0)),
      )
    }
    if (command === "smembers" || command === "scard") {
      if (args.length !== 1) return arityError(command)
      const set = this.requireSet(database, key, false)
      if (set === null) return command === "scard" ? int(0) : arr([])
      if (!("members" in set)) return set
      if (command === "scard") return int(set.members.size)
      const members = [...set.members.values()].sort((a, b) => compareBytes(a, b))
      return arr(members.map((member) => ({ t: "bulk" as const, v: member })))
    }
    if (command === "spop" || command === "srandmember") {
      if (args.length < 1 || args.length > 2) return arityError(command)
      const set = this.requireSet(database, key, false)
      if (set === null) return args.length === 2 ? arr([]) : nil()
      if (!("members" in set)) return set
      const count = args.length === 2 ? parseI64(args[1] ?? utf8("")) : null
      if (args.length === 2 && count === null) return notInteger()
      if (!apply && command === "spop") return queued()
      const members = [...set.members.values()]
      if (members.length === 0) return count === null ? nil() : arr([])
      const picked: Uint8Array[] = []
      const pool = members.slice()
      const times =
        count === null
          ? 1
          : Math.min(
              Math.abs(Number(count)),
              command === "srandmember" && count < 0n ? Number(-count) : pool.length,
            )
      for (
        let i = 0;
        i < (count !== null && count < 0n && command === "srandmember" ? Number(-count) : times);
        i++
      ) {
        const index = Math.floor(
          this.random() *
            (command === "srandmember" && count !== null && count < 0n
              ? members.length
              : pool.length),
        )
        const member =
          command === "srandmember" && count !== null && count < 0n
            ? members[index]
            : pool.splice(index, 1)[0]
        if (member) picked.push(member)
      }
      if (command === "spop") {
        for (const member of picked) set.members.delete(memberKey(member))
        database.dropIfEmpty(key)
        if (database.has(key)) database.put(key, set)
      }
      if (count === null) return picked[0] ? { t: "bulk", v: picked[0] } : nil()
      return arr(picked.map((member) => ({ t: "bulk" as const, v: member })))
    }
    if (command === "sinter" || command === "sunion" || command === "sdiff") {
      if (args.length < 1) return arityError(command)
      const sets = []
      for (const arg of args) {
        const set = this.requireSet(database, text(arg), false)
        if (set && !("members" in set)) return set
        sets.push(set && "members" in set ? set : null)
      }
      const [first, ...rest] = sets
      let members = new Map(first?.members ?? [])
      if (command === "sinter") {
        for (const set of rest) {
          members = new Map([...members].filter(([member]) => set?.members.has(member)))
        }
      } else if (command === "sunion") {
        for (const set of rest)
          for (const [member, bytes] of set?.members ?? []) members.set(member, bytes)
      } else {
        for (const set of rest)
          for (const member of set?.members.keys() ?? []) members.delete(member)
      }
      const ordered = [...members.values()].sort((a, b) => compareBytes(a, b))
      return arr(ordered.map((member) => ({ t: "bulk" as const, v: member })))
    }
    if (command === "smove") {
      if (args.length !== 3) return arityError("smove")
      const source = this.requireSet(database, key, false)
      if (source && !("members" in source)) return source
      const destKey = text(args[1])
      const dest = this.requireSet(database, destKey, false)
      if (dest && !("members" in dest)) return dest
      const member = memberKey(args[2] ?? utf8(""))
      if (!source || !("members" in source) || !source.members.has(member)) return int(0)
      if (!apply) return queued()
      const bytes = source.members.get(member) ?? utf8("")
      source.members.delete(member)
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, source)
      const target = this.requireSet(database, destKey, true)
      if (!target || !("members" in target)) return target ?? wrongType()
      target.members.set(member, bytes)
      database.put(destKey, target)
      return int(1)
    }
    return unknownCommand(command, args)
  }

  private requireZset(database: Database, key: string, create: boolean) {
    const value = database.get(key)
    if (!value) {
      if (!create) return null
      const created: Extract<Value, { kind: "zset" }> = { kind: "zset", members: new Map() }
      database.put(key, created)
      return created
    }
    if (value.kind !== "zset") return wrongType()
    return value
  }

  private cmdZset(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    const database = this.database(session.db)
    const key = text(args[0])
    if (command === "zadd") return this.cmdZadd(session, args, apply)
    if (command === "zrem") {
      if (args.length < 2) return arityError("zrem")
      const zset = this.requireZset(database, key, false)
      if (zset === null) return int(0)
      if (!("members" in zset)) return zset
      if (!apply) return queued()
      let removed = 0
      for (const arg of args.slice(1)) if (zset.members.delete(memberKey(arg))) removed++
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, zset)
      return int(removed)
    }
    if (command === "zcard") {
      if (args.length !== 1) return arityError("zcard")
      const zset = this.requireZset(database, key, false)
      if (zset === null) return int(0)
      if (!("members" in zset)) return zset
      return int(zset.members.size)
    }
    if (command === "zscore" || command === "zmscore") {
      if (command === "zscore" && args.length !== 2) return arityError("zscore")
      if (command === "zmscore" && args.length < 2) return arityError("zmscore")
      const zset = this.requireZset(database, key, false)
      if (zset && !("members" in zset)) return zset
      const scores = args.slice(1).map((arg) => {
        const member = zset && "members" in zset ? zset.members.get(memberKey(arg)) : undefined
        return member ? bulk(scoreText(member.score)) : nil()
      })
      return command === "zscore" ? (scores[0] ?? nil()) : arr(scores)
    }
    if (command === "zincrby") {
      if (args.length !== 3) return arityError("zincrby")
      const delta = parseScore(args[1])
      if (delta === null) return notFloat()
      if (!apply) return queued()
      const zset = this.requireZset(database, key, true)
      if (!zset || !("members" in zset)) return zset ?? wrongType()
      const member = args[2] ?? utf8("")
      const current = zset.members.get(memberKey(member))
      const score = (current?.score ?? 0) + delta
      zset.members.set(memberKey(member), { member, score })
      database.put(key, zset)
      this.wake(session.db, key)
      return bulk(scoreText(score))
    }
    if (command === "zrank" || command === "zrevrank") {
      if (args.length !== 2) return arityError(command)
      const zset = this.requireZset(database, key, false)
      if (zset === null) return nil()
      if (!("members" in zset)) return zset
      const ordered = database.zsetOrdered(zset)
      const at = ordered.findIndex(
        (item) => memberKey(item.member) === memberKey(args[1] ?? utf8("")),
      )
      if (at < 0) return nil()
      return int(command === "zrevrank" ? ordered.length - 1 - at : at)
    }
    if (
      command === "zrange" ||
      command === "zrevrange" ||
      command === "zrangebyscore" ||
      command === "zrevrangebyscore"
    ) {
      return this.cmdZrange(database, command, args)
    }
    if (command === "zcount") {
      if (args.length !== 3) return arityError("zcount")
      const zset = this.requireZset(database, key, false)
      if (zset === null) return int(0)
      if (!("members" in zset)) return zset
      const min = parseBound(text(args[1]))
      const max = parseBound(text(args[2]))
      if (!min || !max) return notFloat()
      return int(database.zsetOrdered(zset).filter((item) => inBound(item.score, min, max)).length)
    }
    if (command === "zpopmin" || command === "zpopmax") {
      if (args.length < 1 || args.length > 2) return arityError(command)
      const zset = this.requireZset(database, key, false)
      if (zset === null) return arr([])
      if (!("members" in zset)) return zset
      const count = args.length === 2 ? parseI64(args[1] ?? utf8("")) : 1n
      if (count === null || count < 0n) return notInteger()
      if (!apply) return queued()
      const ordered = database.zsetOrdered(zset)
      const picked =
        command === "zpopmax"
          ? ordered.slice(-Number(count)).reverse()
          : ordered.slice(0, Number(count))
      for (const item of picked) zset.members.delete(memberKey(item.member))
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, zset)
      return arr(
        picked.flatMap((item) => [
          { t: "bulk" as const, v: item.member },
          bulk(scoreText(item.score)),
        ]),
      )
    }
    if (command === "zremrangebyscore" || command === "zremrangebyrank") {
      if (args.length !== 3) return arityError(command)
      const zset = this.requireZset(database, key, false)
      if (zset === null) return int(0)
      if (!("members" in zset)) return zset
      if (!apply) return queued()
      const ordered = database.zsetOrdered(zset)
      let removed = 0
      if (command === "zremrangebyrank") {
        const [start, end] = indexes(ordered.length, args[1], args[2])
        ordered.forEach((item, index) => {
          if (index >= start && index <= end) {
            zset.members.delete(memberKey(item.member))
            removed++
          }
        })
      } else {
        const min = parseBound(text(args[1]))
        const max = parseBound(text(args[2]))
        if (!min || !max) return notFloat()
        for (const item of ordered) {
          if (!inBound(item.score, min, max)) continue
          zset.members.delete(memberKey(item.member))
          removed++
        }
      }
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, zset)
      return int(removed)
    }
    return unknownCommand(command, args)
  }

  private cmdZadd(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 3) return arityError("zadd")
    let index = 1
    let nx = false
    let xx = false
    let gt = false
    let lt = false
    let ch = false
    let incr = false
    while (index < args.length) {
      const option = upper(args[index])
      if (!["NX", "XX", "GT", "LT", "CH", "INCR"].includes(option)) break
      if (option === "NX") nx = true
      if (option === "XX") xx = true
      if (option === "GT") gt = true
      if (option === "LT") lt = true
      if (option === "CH") ch = true
      if (option === "INCR") incr = true
      index++
    }
    if ((gt || lt) && nx)
      return err("ERR GT, LT, and/or NX options at the same time are not compatible")
    if ((args.length - index) % 2 !== 0 || index >= args.length) return syntaxError()
    if (incr && args.length - index !== 2)
      return err("ERR INCR option supports a single increment-element pair")
    const database = this.database(session.db)
    const key = text(args[0])
    const existing = this.requireZset(database, key, false)
    if (existing && !("members" in existing)) return existing
    if (!apply) return queued()
    const zset = this.requireZset(database, key, true)
    if (!zset || !("members" in zset)) return zset ?? wrongType()
    let changed = 0
    let added = 0
    let updatedScore = 0
    for (let i = index; i < args.length; i += 2) {
      const score = parseScore(args[i])
      if (score === null) return notFloat()
      const member = args[i + 1] ?? utf8("")
      const current = zset.members.get(memberKey(member))
      if (nx && current) continue
      if ((xx || gt || lt) && !current) continue
      if (gt && current && score <= current.score) continue
      if (lt && current && score >= current.score) continue
      const next = incr ? (current?.score ?? 0) + score : score
      if (!current) added++
      else if (current.score !== next) updatedScore++
      zset.members.set(memberKey(member), { member, score: next })
      if (incr) {
        database.put(key, zset)
        this.wake(session.db, key)
        return bulk(scoreText(next))
      }
    }
    changed = ch ? added + updatedScore : added
    database.put(key, zset)
    this.wake(session.db, key)
    return int(changed)
  }

  private cmdZrange(database: Database, command: string, args: Uint8Array[]): Reply {
    if (args.length < 3) return arityError(command)
    const zset = this.requireZset(database, text(args[0]), false)
    if (zset === null) return arr([])
    if (!("members" in zset)) return zset
    let byScore = command === "zrangebyscore" || command === "zrevrangebyscore"
    let rev = command === "zrevrange" || command === "zrevrangebyscore"
    let withScores = false
    let limit: { offset: number; count: number } | null = null
    const rest = args.slice(3)
    for (let i = 0; i < rest.length; i++) {
      const option = upper(rest[i])
      if (option === "BYSCORE") byScore = true
      else if (option === "REV") rev = true
      else if (option === "WITHSCORES") withScores = true
      else if (option === "LIMIT") {
        const offset = parseI64(rest[++i] ?? utf8(""))
        const count = parseI64(rest[++i] ?? utf8(""))
        if (offset === null || count === null) return notInteger()
        limit = { offset: Number(offset), count: Number(count) }
      } else return syntaxError()
    }
    let ordered = database.zsetOrdered(zset)
    if (byScore) {
      const left = parseBound(text(args[1]))
      const right = parseBound(text(args[2]))
      if (!left || !right) return notFloat()
      const min = rev ? right : left
      const max = rev ? left : right
      ordered = ordered.filter((item) => inBound(item.score, min, max))
    } else {
      const [start, end] = indexes(ordered.length, args[1], args[2])
      ordered = start > end ? [] : ordered.slice(start, end + 1)
    }
    if (rev) ordered.reverse()
    if (limit) ordered = ordered.slice(limit.offset, limit.offset + limit.count)
    return arr(
      ordered.flatMap((item) => {
        const member = { t: "bulk" as const, v: item.member }
        return withScores ? [member, bulk(scoreText(item.score))] : [member]
      }),
    )
  }

  private cmdBlockingZset(
    session: Session,
    args: Uint8Array[],
    apply: boolean,
    max: boolean,
  ): Reply | Promise<Reply> {
    const name = max ? "bzpopmax" : "bzpopmin"
    if (args.length < 2) return arityError(name)
    const timeout = parseTimeout(args[args.length - 1])
    if (timeout === null) return err("ERR timeout is not a float or out of range")
    const keys = args.slice(0, -1).map((arg) => text(arg))
    for (const key of keys) {
      const value = this.database(session.db).get(key)
      if (value && value.kind !== "zset") return wrongType()
    }
    if (!apply) return queued()
    const immediate = this.takeZset(session.db, keys, max)
    if (immediate) return immediate
    if (session.inExec || this.scriptDepth > 0) return nilArray()
    return this.block({
      kind: "zset",
      keys,
      db: session.db,
      side: "left",
      max,
      count: 1,
      ...(timeout > 0 ? { deadline: this.clock.now() + timeout * 1000 } : {}),
      session,
    })
  }

  private takeZset(dbIndex: number, keys: string[], max: boolean): Reply | null {
    if (this.consumersPaused) return null
    const database = this.database(dbIndex)
    for (const key of keys) {
      const value = database.get(key)
      if (!value) continue
      if (value.kind !== "zset") return wrongType()
      const ordered = database.zsetOrdered(value)
      const member = max ? ordered[ordered.length - 1] : ordered[0]
      if (!member) continue
      value.members.delete(memberKey(member.member))
      database.dropIfEmpty(key)
      if (database.has(key)) database.put(key, value)
      return arr([bulk(key), { t: "bulk", v: member.member }, bulk(scoreText(member.score))])
    }
    return null
  }

  private cmdStream(
    session: Session,
    command: string,
    args: Uint8Array[],
    apply: boolean,
  ): Reply | Promise<Reply> {
    if (command === "xadd") return this.cmdXadd(session, args, apply)
    if (command === "xlen") {
      if (args.length !== 1) return arityError("xlen")
      const stream = this.stream(session, text(args[0]), false)
      if (stream === null) return int(0)
      if (!(stream instanceof Object) || !("entries" in stream)) return stream
      return int(stream.entries.length)
    }
    if (command === "xrange" || command === "xrevrange")
      return this.cmdXrange(session, command, args)
    if (command === "xdel") return this.cmdXdel(session, args, apply)
    if (command === "xtrim") return this.cmdXtrim(session, args, apply)
    if (command === "xgroup") return this.cmdXgroup(session, args, apply)
    if (command === "xread") return this.cmdXread(session, args, apply, false)
    if (command === "xreadgroup") return this.cmdXread(session, args, apply, true)
    if (command === "xack") return this.cmdXack(session, args, apply)
    if (command === "xpending") return this.cmdXpending(session, args)
    if (command === "xclaim") return this.cmdXclaim(session, args, apply, false)
    if (command === "xautoclaim") return this.cmdXclaim(session, args, apply, true)
    if (command === "xinfo") return this.cmdXinfo(session, args)
    return unknownCommand(command, args)
  }

  private stream(session: Session, key: string, create: boolean) {
    const database = this.database(session.db)
    const value = database.get(key)
    if (!value) {
      if (!create) return null
      const created: Extract<Value, { kind: "stream" }> = { kind: "stream", stream: emptyStream() }
      database.put(key, created)
      return created.stream
    }
    if (value.kind !== "stream") return wrongType()
    return value.stream
  }

  private cmdXadd(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 4) return arityError("xadd")
    let index = 1
    let nomk = false
    let maxlen: number | null = null
    const key = text(args[0])
    while (index < args.length) {
      const option = upper(args[index])
      if (option === "NOMKSTREAM") {
        nomk = true
        index++
        continue
      }
      if (option === "MAXLEN" || option === "MINID") {
        index++
        if (upper(args[index]) === "~" || upper(args[index]) === "=") index++
        const parsed = parseI64(args[index] ?? utf8(""))
        if (parsed === null || parsed < 0n) return syntaxError()
        if (option === "MAXLEN") maxlen = Number(parsed)
        index++
        continue
      }
      break
    }
    const idArg = text(args[index])
    const fields = args.slice(index + 1)
    if (fields.length < 2 || fields.length % 2 !== 0) return syntaxError()
    const database = this.database(session.db)
    if (!database.has(key) && nomk) return nil()
    const stream = this.stream(session, key, true)
    if (!stream || !("entries" in stream)) return stream ?? wrongType()
    if (!apply) return queued()
    const id = this.nextId(stream, idArg)
    if (typeof id !== "string") return id
    stream.entries.push({ id, ...(parseStreamId(id) ?? { ms: 0n, seq: 0n }), fields })
    if (maxlen !== null && stream.entries.length > maxlen) {
      stream.entries.splice(0, stream.entries.length - maxlen)
    }
    const value = database.get(key)
    if (value && value.kind === "stream") database.put(key, value)
    this.wake(session.db, key)
    return bulk(id)
  }

  private nextId(
    stream: Extract<ReturnType<Redis["stream"]>, { entries: StreamEntry[] }>,
    requested: string,
  ): string | Reply {
    if (requested === "*") {
      let ms = BigInt(Math.max(0, Math.trunc(this.clock.now())))
      if (ms > stream.lastMs) {
        stream.lastMs = ms
        stream.lastSeq = 0n
      } else {
        ms = stream.lastMs
        stream.lastSeq += 1n
      }
      if (stream.lastMs === 0n && stream.lastSeq === 0n) stream.lastSeq = 1n
      return `${stream.lastMs}-${stream.lastSeq}`
    }
    const parsed = parseStreamId(requested)
    if (!parsed) return err("ERR Invalid stream ID specified as stream command argument")
    if (parsed.ms === 0n && parsed.seq === 0n) {
      return err("ERR The ID specified in XADD must be greater than 0-0")
    }
    const top = stream.entries[stream.entries.length - 1]
    if (top && cmpId(requested, top.id) <= 0) {
      return err("ERR The ID specified in XADD is equal or smaller than the target stream top item")
    }
    if (parsed.ms > stream.lastMs || (parsed.ms === stream.lastMs && parsed.seq > stream.lastSeq)) {
      stream.lastMs = parsed.ms
      stream.lastSeq = parsed.seq
    }
    return `${parsed.ms}-${parsed.seq}`
  }

  private cmdXrange(session: Session, command: string, args: Uint8Array[]): Reply {
    if (args.length < 3) return arityError(command)
    const stream = this.stream(session, text(args[0]), false)
    if (stream === null) return arr([])
    if (!("entries" in stream)) return stream
    const start = text(args[1])
    const end = text(args[2])
    let count = Infinity
    if (upper(args[3]) === "COUNT") {
      const parsed = parseI64(args[4] ?? utf8(""))
      if (parsed === null) return syntaxError()
      count = Number(parsed)
    }
    let entries = stream.entries.filter((entry) => {
      const afterStart = start === "-" || cmpId(entry.id, start) >= 0
      const beforeEnd = end === "+" || cmpId(entry.id, end) <= 0
      return afterStart && beforeEnd
    })
    if (command === "xrevrange") entries = entries.slice().reverse()
    return arr(entries.slice(0, count).map((entry) => entryFields(entry)))
  }

  private cmdXdel(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 2) return arityError("xdel")
    const stream = this.stream(session, text(args[0]), false)
    if (stream === null) return int(0)
    if (!("entries" in stream)) return stream
    if (!apply) return queued()
    const ids = new Set(args.slice(1).map((arg) => text(arg)))
    const before = stream.entries.length
    stream.entries = stream.entries.filter((entry) => !ids.has(entry.id))
    return int(before - stream.entries.length)
  }

  private cmdXtrim(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 3) return arityError("xtrim")
    const stream = this.stream(session, text(args[0]), false)
    if (stream === null) return int(0)
    if (!("entries" in stream)) return stream
    let index = 1
    const strategy = upper(args[index])
    if (strategy !== "MAXLEN" && strategy !== "MINID") return syntaxError()
    index++
    if (upper(args[index]) === "~" || upper(args[index]) === "=") index++
    if (!apply) return queued()
    const before = stream.entries.length
    if (strategy === "MAXLEN") {
      const length = parseI64(args[index] ?? utf8(""))
      if (length === null) return syntaxError()
      if (stream.entries.length > Number(length)) {
        stream.entries.splice(0, stream.entries.length - Number(length))
      }
    }
    return int(before - stream.entries.length)
  }

  private cmdXgroup(session: Session, args: Uint8Array[], apply: boolean): Reply {
    const sub = upper(args[0])
    if (sub === "CREATE") {
      if (args.length < 4) return arityError("xgroup")
      const key = text(args[1])
      const group = text(args[2])
      const id = text(args[3])
      const mk = args.some((arg) => upper(arg) === "MKSTREAM")
      let stream = this.stream(session, key, false)
      if (stream === null) {
        if (!mk) {
          return err(
            "ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.",
          )
        }
        if (!apply) return queued()
        stream = this.stream(session, key, true)
      }
      if (!stream || !("groups" in stream)) return stream ?? wrongType()
      if (stream.groups.has(group)) return err("BUSYGROUP Consumer Group name already exists")
      if (!apply) return queued()
      const last = stream.entries[stream.entries.length - 1]
      const lastId = id === "$" ? (last?.id ?? "0-0") : id === "0" ? "0-0" : id
      if (lastId !== "0-0" && !parseStreamId(lastId)) {
        return err("ERR Invalid stream ID specified as stream command argument")
      }
      stream.groups.set(group, { name: group, lastId, consumers: new Map(), pel: new Map() })
      return ok()
    }
    if (sub === "DESTROY") {
      if (args.length !== 3) return arityError("xgroup")
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream)) return int(0)
      if (!apply) return queued()
      return int(stream.groups.delete(text(args[2])) ? 1 : 0)
    }
    if (sub === "CREATECONSUMER") {
      if (args.length !== 4) return arityError("xgroup")
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream))
        return err("ERR The XGROUP subcommand requires the key to exist")
      const group = stream.groups.get(text(args[2]))
      if (!group) return err("NOGROUP No such consumer group")
      if (!apply) return queued()
      const name = text(args[3])
      const created = !group.consumers.has(name)
      group.consumers.set(name, { seenAt: this.clock.now() })
      return int(created ? 1 : 0)
    }
    if (sub === "DELCONSUMER") {
      if (args.length !== 4) return arityError("xgroup")
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream)) return int(0)
      const group = stream.groups.get(text(args[2]))
      if (!group) return int(0)
      if (!apply) return queued()
      const name = text(args[3])
      let pending = 0
      for (const [id, item] of group.pel) {
        if (item.consumer !== name) continue
        group.pel.delete(id)
        pending++
      }
      group.consumers.delete(name)
      return int(pending)
    }
    if (sub === "SETID") {
      if (args.length < 4) return arityError("xgroup")
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream))
        return err("ERR The XGROUP subcommand requires the key to exist")
      const group = stream.groups.get(text(args[2]))
      if (!group) return err("NOGROUP No such consumer group")
      if (!apply) return queued()
      const id = text(args[3])
      group.lastId = id === "$" ? (stream.entries[stream.entries.length - 1]?.id ?? "0-0") : id
      return ok()
    }
    return err(`ERR unknown subcommand '${text(args[0]).toLowerCase()}'. Try XGROUP HELP.`)
  }

  private cmdXread(
    session: Session,
    args: Uint8Array[],
    apply: boolean,
    group: boolean,
  ): Reply | Promise<Reply> {
    let index = 0
    let groupName = ""
    let consumer = ""
    let count = Infinity
    let block: number | null = null
    let noack = false
    if (group) {
      if (upper(args[0]) !== "GROUP") return syntaxError()
      groupName = text(args[1])
      consumer = text(args[2])
      index = 3
    }
    while (index < args.length && upper(args[index]) !== "STREAMS") {
      const option = upper(args[index])
      if (option === "COUNT") {
        const parsed = parseI64(args[++index] ?? utf8(""))
        if (parsed === null || parsed < 0n) return syntaxError()
        count = Number(parsed)
      } else if (option === "BLOCK") {
        const parsed = parseI64(args[++index] ?? utf8(""))
        if (parsed === null || parsed < 0n) return syntaxError()
        block = Number(parsed)
      } else if (option === "NOACK") noack = true
      else return syntaxError()
      index++
    }
    if (upper(args[index]) !== "STREAMS") return syntaxError()
    const rest = args.slice(index + 1)
    if (rest.length < 2 || rest.length % 2 !== 0) return syntaxError()
    const half = rest.length / 2
    const keys = rest.slice(0, half).map((arg) => text(arg))
    const ids = rest.slice(half).map((arg) => text(arg))
    if (!apply) return queued()
    for (const key of keys) {
      const value = this.database(session.db).get(key)
      if (value && value.kind !== "stream") return wrongType()
    }
    const read = this.readStreams(session, keys, ids, count, group, groupName, consumer, noack)
    if (read.t === "error") return read
    if (
      !(this.consumersPaused && block !== null) &&
      read.t === "array" &&
      read.v &&
      read.v.length > 0
    ) {
      return read
    }
    if (block === null || session.inExec) return nilArray()
    if (this.scriptDepth > 0) return scriptDenied()
    const streamIds = ids.map((id, idIndex) => {
      if (id !== "$") return id
      const existing = this.stream(session, keys[idIndex] ?? "", false)
      if (existing && "entries" in existing) return existing.entries.at(-1)?.id ?? "0-0"
      return "0-0"
    })
    return this.block({
      kind: "stream",
      keys,
      db: session.db,
      side: "left",
      count,
      streamIds,
      ...(group ? { group: groupName, consumer, ...(noack ? { noack: true } : {}) } : {}),
      ...(block > 0 ? { deadline: this.clock.now() + block } : {}),
      session,
    })
  }

  private readStreams(
    session: Session,
    keys: string[],
    ids: string[],
    count: number,
    grouped: boolean,
    groupName: string,
    consumer: string,
    noack: boolean,
  ): Reply {
    const rows: Reply[] = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] ?? ""
      const id = ids[i] ?? "0-0"
      const stream = this.stream(session, key, false)
      if (stream === null) continue
      if (!("entries" in stream)) return stream
      let chosen: StreamEntry[] = []
      if (!grouped) {
        chosen = stream.entries
          .filter((entry) => (id === "$" ? false : cmpId(entry.id, id) > 0))
          .slice(0, count)
      } else {
        const group = stream.groups.get(groupName)
        if (!group) return err("NOGROUP No such key or consumer group")
        if (id === ">") {
          chosen = stream.entries
            .filter((entry) => cmpId(entry.id, group.lastId) > 0)
            .slice(0, count)
          for (const entry of chosen) {
            group.lastId = entry.id
            if (!noack) {
              const pending = group.pel.get(entry.id)
              group.pel.set(entry.id, {
                id: entry.id,
                consumer,
                deliveries: (pending?.deliveries ?? 0) + 1,
                deliveredAt: this.clock.now(),
              })
            }
            group.consumers.set(consumer, { seenAt: this.clock.now() })
          }
        } else {
          chosen = [...group.pel.values()]
            .filter((item) => item.consumer === consumer && cmpId(item.id, id) > 0)
            .map((item) => stream.entries.find((entry) => entry.id === item.id))
            .filter((entry): entry is StreamEntry => entry !== undefined)
            .slice(0, count)
        }
      }
      if (chosen.length > 0)
        rows.push(arr([bulk(key), arr(chosen.map((entry) => entryFields(entry)))]))
    }
    return rows.length > 0 ? arr(rows) : nilArray()
  }

  private cmdXack(session: Session, args: Uint8Array[], apply: boolean): Reply {
    if (args.length < 3) return arityError("xack")
    const stream = this.stream(session, text(args[0]), false)
    if (stream === null) return int(0)
    if (!("groups" in stream)) return stream
    const group = stream.groups.get(text(args[1]))
    if (!group) return int(0)
    if (!apply) return queued()
    let acked = 0
    for (const id of args.slice(2).map((arg) => text(arg))) {
      if (group.pel.delete(id)) acked++
    }
    return int(acked)
  }

  private cmdXpending(session: Session, args: Uint8Array[]): Reply {
    if (args.length < 2) return arityError("xpending")
    const stream = this.stream(session, text(args[0]), false)
    if (stream === null) return err("ERR no such key")
    if (!("groups" in stream)) return stream
    const group = stream.groups.get(text(args[1]))
    if (!group) return err("NOGROUP No such consumer group")
    if (args.length === 2) {
      if (group.pel.size === 0) return arr([int(0), nil(), nil(), arr([])])
      const ids = [...group.pel.keys()].sort(cmpId)
      const counts = new Map<string, number>()
      for (const item of group.pel.values())
        counts.set(item.consumer, (counts.get(item.consumer) ?? 0) + 1)
      return arr([
        int(group.pel.size),
        bulk(ids[0] ?? ""),
        bulk(ids[ids.length - 1] ?? ""),
        arr([...counts].map(([name, count]) => arr([bulk(name), bulk(String(count))]))),
      ])
    }
    const start = text(args[2])
    const end = text(args[3])
    const count = parseI64(args[4] ?? utf8(""))
    if (count === null) return syntaxError()
    const consumer = args[5] ? text(args[5]) : null
    const rows = [...group.pel.values()]
      .filter(
        (item) =>
          (start === "-" || cmpId(item.id, start) >= 0) &&
          (end === "+" || cmpId(item.id, end) <= 0),
      )
      .filter((item) => consumer === null || item.consumer === consumer)
      .sort((a, b) => cmpId(a.id, b.id))
      .slice(0, Number(count))
    return arr(
      rows.map((item) =>
        arr([
          bulk(item.id),
          bulk(item.consumer),
          int(Math.max(0, this.clock.now() - item.deliveredAt)),
          int(item.deliveries),
        ]),
      ),
    )
  }

  private cmdXclaim(session: Session, args: Uint8Array[], apply: boolean, auto: boolean): Reply {
    const minIdleIndex = auto ? 3 : 3
    if (args.length < (auto ? 5 : 5)) return arityError(auto ? "xautoclaim" : "xclaim")
    const stream = this.stream(session, text(args[0]), false)
    if (!stream || !("groups" in stream)) return auto ? nilArray() : arr([])
    const group = stream.groups.get(text(args[1]))
    if (!group) return err("NOGROUP No such consumer group")
    const consumer = text(args[2])
    const minIdle = Number(text(args[minIdleIndex]))
    if (!Number.isFinite(minIdle) || minIdle < 0) return syntaxError()
    if (!apply) return queued()
    let count = auto ? 100 : Infinity
    let justId = false
    const ids: string[] = []
    if (auto) {
      const start = text(args[4])
      for (let i = 5; i < args.length; i++) {
        if (upper(args[i]) === "COUNT") {
          const parsed = parseI64(args[++i] ?? utf8(""))
          if (parsed === null) return syntaxError()
          count = Number(parsed)
        } else if (upper(args[i]) === "JUSTID") justId = true
      }
      const claimed: StreamEntry[] = []
      const deleted: string[] = []
      let finished = true
      for (const id of [...group.pel.keys()].sort(cmpId)) {
        if (cmpId(id, start) <= 0) continue
        if (claimed.length >= count) {
          finished = false
          break
        }
        const item = group.pel.get(id)
        if (!item) continue
        const entry = stream.entries.find((candidate) => candidate.id === id)
        if (!entry) {
          group.pel.delete(id)
          deleted.push(id)
          continue
        }
        if (this.clock.now() - item.deliveredAt < minIdle) continue
        item.consumer = consumer
        item.deliveries++
        item.deliveredAt = this.clock.now()
        group.consumers.set(consumer, { seenAt: this.clock.now() })
        claimed.push(entry)
      }
      return arr([
        bulk(finished ? "0-0" : (claimed[claimed.length - 1]?.id ?? "0-0")),
        arr(claimed.map((entry) => (justId ? bulk(entry.id) : entryFields(entry)))),
        arr(deleted.map((id) => bulk(id))),
      ])
    }
    for (let i = 4; i < args.length; i++) {
      const option = upper(args[i])
      if (option === "IDLE" || option === "TIME" || option === "RETRYCOUNT") i++
      else if (option === "FORCE" || option === "JUSTID") {
        if (option === "JUSTID") justId = true
      } else ids.push(text(args[i]))
    }
    const claimed: StreamEntry[] = []
    for (const id of ids) {
      const item = group.pel.get(id)
      const entry = stream.entries.find((candidate) => candidate.id === id)
      if (!item || !entry) continue
      if (this.clock.now() - item.deliveredAt < minIdle) continue
      item.consumer = consumer
      item.deliveries++
      item.deliveredAt = this.clock.now()
      claimed.push(entry)
    }
    group.consumers.set(consumer, { seenAt: this.clock.now() })
    return arr(claimed.map((entry) => (justId ? bulk(entry.id) : entryFields(entry))))
  }

  private cmdXinfo(session: Session, args: Uint8Array[]): Reply {
    const sub = upper(args[0])
    if (sub === "STREAM") {
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("entries" in stream)) return err("ERR no such key")
      const first = stream.entries[0]
      const last = stream.entries[stream.entries.length - 1]
      return arr([
        bulk("length"),
        int(stream.entries.length),
        bulk("radix-tree-keys"),
        int(0),
        bulk("radix-tree-nodes"),
        int(0),
        bulk("last-generated-id"),
        bulk(last?.id ?? "0-0"),
        bulk("groups"),
        int(stream.groups.size),
        bulk("first-entry"),
        first ? entryFields(first) : nil(),
        bulk("last-entry"),
        last ? entryFields(last) : nil(),
      ])
    }
    if (sub === "GROUPS") {
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream)) return err("ERR no such key")
      return arr(
        [...stream.groups.values()].map((group) =>
          arr([
            bulk("name"),
            bulk(group.name),
            bulk("consumers"),
            int(group.consumers.size),
            bulk("pending"),
            int(group.pel.size),
            bulk("last-delivered-id"),
            bulk(group.lastId),
          ]),
        ),
      )
    }
    if (sub === "CONSUMERS") {
      const stream = this.stream(session, text(args[1]), false)
      if (!stream || !("groups" in stream)) return err("ERR no such key")
      const group = stream.groups.get(text(args[2]))
      if (!group) return err("NOGROUP No such consumer group")
      return arr(
        [...group.consumers].map(([name, info]) => {
          let pending = 0
          for (const item of group.pel.values()) if (item.consumer === name) pending++
          return arr([
            bulk("name"),
            bulk(name),
            bulk("pending"),
            int(pending),
            bulk("idle"),
            int(Math.max(0, this.clock.now() - info.seenAt)),
          ])
        }),
      )
    }
    return syntaxError()
  }

  private cmdSub(session: Session, command: string, args: Uint8Array[]): Reply {
    const pattern = command.startsWith("p")
    const leaving = command.includes("unsubscribe")
    const names = args.map((arg) => text(arg))
    if (!leaving && names.length === 0) return arityError(command)
    const targets = names.length > 0 ? names : [...(pattern ? session.patterns : session.channels)]
    if (targets.length === 0) {
      return push([bulk(command), nil(), int(session.channels.size + session.patterns.size)])
    }
    let last: Reply = ok()
    targets.forEach((name, index) => {
      if (leaving) {
        if (pattern) {
          session.patterns.delete(name)
          this.patternSubs.get(name)?.delete(session)
        } else {
          session.channels.delete(name)
          this.channelSubs.get(name)?.delete(session)
        }
      } else if (pattern) {
        session.patterns.add(name)
        const set = this.patternSubs.get(name) ?? new Set()
        set.add(session)
        this.patternSubs.set(name, set)
      } else {
        session.channels.add(name)
        const set = this.channelSubs.get(name) ?? new Set()
        set.add(session)
        this.channelSubs.set(name, set)
      }
      const reply = push([
        bulk(command),
        bulk(name),
        int(session.channels.size + session.patterns.size),
      ])
      if (index < targets.length - 1) session.onPush(reply)
      else last = reply
    })
    return last
  }

  private cmdPublish(args: Uint8Array[]): Reply {
    if (args.length !== 2) return arityError("publish")
    const channel = text(args[0])
    const message = args[1] ?? utf8("")
    let delivered = 0
    for (const session of this.channelSubs.get(channel) ?? []) {
      session.onPush(push([bulk("message"), bulk(channel), { t: "bulk", v: message }]))
      delivered++
    }
    for (const [pattern, sessions] of this.patternSubs) {
      if (!globMatch(pattern, channel)) continue
      for (const session of sessions) {
        session.onPush(
          push([bulk("pmessage"), bulk(pattern), bulk(channel), { t: "bulk", v: message }]),
        )
        delivered++
      }
    }
    return int(delivered)
  }

  private cmdPubsub(args: Uint8Array[]): Reply {
    const sub = upper(args[0])
    if (sub === "NUMSUB") {
      const rows: Reply[] = []
      for (const arg of args.slice(1)) {
        rows.push(bulk(text(arg)), int(this.channelSubs.get(text(arg))?.size ?? 0))
      }
      return arr(rows)
    }
    if (sub === "CHANNELS") {
      const pattern = args[1] ? text(args[1]) : "*"
      return arr(
        [...this.channelSubs.keys()]
          .filter((channel) => globMatch(pattern, channel))
          .map((channel) => bulk(channel)),
      )
    }
    if (sub === "NUMPAT") return int(this.patternSubs.size)
    return arityError("pubsub")
  }

  private cmdExec(session: Session): Reply {
    if (!session.multi) return execWithoutMulti()
    const queuedCommands = session.multi
    const failed = session.multiFailed
    const watching = session.watching
    session.multi = null
    session.multiFailed = false
    session.watching = []
    if (failed) return execAbort()
    for (const watch of watching) {
      if (this.database(watch.db).generation(watch.key) !== watch.gen) return nilArray()
    }
    const replies: Reply[] = []
    session.inExec = true
    try {
      for (const command of queuedCommands) {
        const reply = this.execCmd(session, command.name, command.args, true, command.raw)
        replies.push(reply instanceof Promise ? nilArray() : reply)
      }
    } finally {
      session.inExec = false
    }
    return arr(replies)
  }

  private cmdDiscard(session: Session): Reply {
    if (!session.multi) return discardWithoutMulti()
    session.multi = null
    session.multiFailed = false
    session.watching = []
    return ok()
  }

  private cmdWatch(session: Session, args: Uint8Array[]): Reply {
    if (args.length < 1) return arityError("watch")
    if (session.multi) return err("ERR WATCH inside MULTI is not allowed")
    for (const arg of args) {
      const key = text(arg)
      session.watching.push({ db: session.db, key, gen: this.database(session.db).generation(key) })
    }
    return ok()
  }

  private cmdEval(session: Session, command: string, args: Uint8Array[], apply: boolean): Reply {
    if (command === "evalsha" && this.faultValue === "noscript") {
      this.faultValue = null
      return err("NOSCRIPT No matching script. Please use EVAL.")
    }
    if (args.length < 2) return arityError(command)
    const source =
      command === "eval" ? text(args[0]) : this.scripts.get(text(args[0]).toLowerCase())
    if (command === "evalsha" && source === undefined) return noScript()
    const numkeys = parseI64(args[1] ?? utf8(""))
    if (numkeys === null) return notInteger()
    if (numkeys < 0n) return err("ERR Number of keys can't be negative")
    if (args.length < 2 + Number(numkeys)) {
      return err("ERR Number of keys can't be greater than number of args")
    }
    if (!apply || source === undefined) return queued()
    const keys = args.slice(2, 2 + Number(numkeys))
    const argv = args.slice(2 + Number(numkeys))
    const result = this.runScript(session, source, keys, argv)
    if (!(result.t === "error" && result.v.includes("Error compiling script:")))
      this.scripts.set(sha1Hex(utf8(source)), source)
    return result
  }

  private cmdScript(args: Uint8Array[], apply: boolean): Reply {
    const sub = upper(args[0])
    if (sub === "LOAD") {
      if (args.length !== 2) return arityError("script|load")
      if (!apply) return queued()
      const source = text(args[1])
      const digest = sha1Hex(utf8(source))
      this.scripts.set(digest, source)
      return bulk(digest)
    }
    if (sub === "EXISTS") {
      return arr(args.slice(1).map((arg) => int(this.scripts.has(text(arg).toLowerCase()) ? 1 : 0)))
    }
    if (sub === "FLUSH") {
      if (!apply) return queued()
      this.scripts.clear()
      return ok()
    }
    if (sub === "KILL") {
      if (this.faultValue !== "busy" && this.scriptDepth === 0) return notBusy()
      if (this.faultValue === "busy") this.faultValue = null
      return ok()
    }
    return arityError("script")
  }

  private runScript(
    session: Session,
    source: string,
    keys: Uint8Array[],
    argv: Uint8Array[],
  ): Reply {
    const host = {
      call: (callArgs: LuaValue[]) => this.luaDispatch(session, callArgs, false),
      pcall: (callArgs: LuaValue[]) => this.luaDispatch(session, callArgs, true),
    }
    const env = luaGlobals(host)
    const keyTable = env.get("redis")
    const keysTable = new LuaTable()
    const argvTable = new LuaTable()
    keys.forEach((key, index) => {
      keysTable.set(index + 1, latin1(key))
    })
    argv.forEach((arg, index) => {
      argvTable.set(index + 1, latin1(arg))
    })
    env.define("KEYS", keysTable)
    env.define("ARGV", argvTable)
    if (keyTable instanceof LuaTable) keyTable.set("pcall", host.pcall)
    this.scriptDepth++
    try {
      const values = runLua(source, env)
      return luaToReply(values[0] ?? null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return err(`ERR Error running script: ${message}`)
    } finally {
      this.scriptDepth--
    }
  }

  private luaDispatch(session: Session, args: LuaValue[], trap: boolean): LuaValue[] {
    const name = typeof args[0] === "string" ? args[0].toLowerCase() : ""
    const bytes = args.slice(1).map((arg) => luaToBytes(arg))
    try {
      const reply = this.execCmd(
        session,
        name,
        bytes,
        true,
        typeof args[0] === "string" ? args[0] : name,
      )
      if (reply instanceof Promise)
        throw new Error("This Redis command is not allowed from scripts")
      if (reply.t === "error") {
        if (!trap) throw new Error(reply.v)
        const table = new LuaTable()
        table.set("err", reply.v)
        return [table]
      }
      return [replyToLua(reply)]
    } catch (error) {
      if (!trap) throw error
      const table = new LuaTable()
      table.set("err", error instanceof Error ? error.message : String(error))
      return [table]
    }
  }

  private block(spec: {
    kind: Waiter["kind"]
    keys: string[]
    db: number
    side: "left" | "right"
    count: number
    deadline?: number
    group?: string
    consumer?: string
    streamIds?: string[]
    noack?: boolean
    max?: boolean
    destKey?: string
    destSide?: "left" | "right"
    session: Session
  }): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind: spec.kind,
        keys: spec.keys,
        db: spec.db,
        side: spec.side,
        count: spec.count,
        settled: false,
        resolve,
        reject,
        ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
        ...(spec.group !== undefined ? { group: spec.group } : {}),
        ...(spec.consumer !== undefined ? { consumer: spec.consumer } : {}),
        ...(spec.streamIds !== undefined ? { streamIds: spec.streamIds } : {}),
        ...(spec.noack ? { noack: true } : {}),
        ...(spec.max ? { max: true } : {}),
        ...(spec.destKey !== undefined ? { destKey: spec.destKey } : {}),
        ...(spec.destSide !== undefined ? { destSide: spec.destSide } : {}),
      }
      waiterSession.set(waiter, spec.session)
      this.waiters.push(waiter)
      if (spec.deadline !== undefined) {
        const deadline = spec.deadline
        const fire = () => {
          if (this.clock.now() < deadline) return
          this.enqueue(() => this.finishWaiter(waiter, waiter.destKey !== undefined ? nil() : nilArray()))
        }
        waiter.unsub = this.clock.subscribe(fire)
        if (!this.clock.manual) {
          waiter.timer = setTimeout(fire, Math.max(0, deadline - this.clock.now()))
        }
      }
    })
  }

  private wake(dbIndex: number, key: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.settled || waiter.db !== dbIndex || !waiter.keys.includes(key)) continue
      const reply = this.satisfy(waiter)
      if (reply) this.finishWaiter(waiter, reply)
    }
  }

  private wakeAll(): void {
    for (const waiter of [...this.waiters]) {
      const reply = this.satisfy(waiter)
      if (reply) this.finishWaiter(waiter, reply)
    }
  }

  private satisfy(waiter: Waiter): Reply | null {
    const session = waiterSession.get(waiter)
    if (!session || session.dead) return nilArray()
    if (this.consumersPaused) return null
    if (waiter.kind === "list" && waiter.destKey !== undefined)
      return moveList(
        this.extraHost,
        waiter.db,
        waiter.keys[0] ?? "",
        waiter.destKey,
        waiter.side,
        waiter.destSide ?? "left",
      )
    if (waiter.kind === "list") return this.takeList(waiter.db, waiter.keys, waiter.side)
    if (waiter.kind === "zset") return this.takeZset(waiter.db, waiter.keys, waiter.max === true)
    const reply = this.readStreams(
      session,
      waiter.keys,
      waiter.streamIds ?? waiter.keys.map(() => ">"),
      waiter.count,
      waiter.group !== undefined,
      waiter.group ?? "",
      waiter.consumer ?? "",
      waiter.noack === true,
    )
    if (reply.t === "array" && reply.v && reply.v.length > 0) return reply
    if (reply.t === "error") return reply
    return null
  }

  private finishWaiter(waiter: Waiter, reply: Reply): void {
    if (waiter.settled) return
    waiter.settled = true
    waiter.unsub?.()
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.waiters = this.waiters.filter((item) => item !== waiter)
    waiterSession.delete(waiter)
    waiter.resolve(reply)
  }

  private failWaiter(waiter: Waiter, error: Error): void {
    if (waiter.settled) return
    waiter.settled = true
    waiter.unsub?.()
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.waiters = this.waiters.filter((item) => item !== waiter)
    waiterSession.delete(waiter)
    waiter.reject(error)
  }

  private leavePubsub(session: Session): void {
    for (const channel of session.channels) this.channelSubs.get(channel)?.delete(session)
    for (const pattern of session.patterns) this.patternSubs.get(pattern)?.delete(session)
    session.channels.clear()
    session.patterns.clear()
  }
}

const waiterSession = new WeakMap<Waiter, Session>()

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left)
  out.set(right, left.length)
  return out
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

function indexes(
  length: number,
  startRaw: Uint8Array | undefined,
  endRaw: Uint8Array | undefined,
): [number, number] {
  let start = Number(text(startRaw))
  let end = Number(text(endRaw))
  if (!Number.isInteger(start)) start = 0
  if (!Number.isInteger(end)) end = -1
  if (start < 0) start = length + start
  if (end < 0) end = length + end
  if (start < 0) start = 0
  if (end >= length) end = length - 1
  return [start, end]
}

function listIndex(length: number, raw: Uint8Array | undefined): number | null {
  const parsed = parseI64(raw ?? utf8(""))
  if (parsed === null) return null
  let index = Number(parsed)
  if (index < 0) index = length + index
  if (index < 0 || index >= length) return null
  return index
}

interface Bound {
  value: number
  exclusive: boolean
}

function parseBound(value: string): Bound | null {
  if (value === "+inf" || value === "inf") return { value: Infinity, exclusive: false }
  if (value === "-inf") return { value: -Infinity, exclusive: false }
  let exclusive = false
  let textValue = value
  if (textValue.startsWith("(")) {
    exclusive = true
    textValue = textValue.slice(1)
  }
  const score = parseScore(utf8(textValue))
  if (score === null) return null
  return { value: score, exclusive }
}

function inBound(score: number, min: Bound, max: Bound): boolean {
  if (min.exclusive ? score <= min.value : score < min.value) return false
  if (max.exclusive ? score >= max.value : score > max.value) return false
  return true
}

function toArg(value: string | number | Uint8Array): Uint8Array {
  if (typeof value === "number") return utf8(String(value))
  if (typeof value === "string") return utf8(value)
  return value
}

export class RedisClient {
  constructor(
    private readonly redis: Redis,
    private readonly session: Session,
  ) {}

  get protocol(): 2 | 3 {
    return this.session.protocol
  }

  onPush(listener: (reply: Reply) => void): void {
    const previous = this.session.onPush
    this.session.onPush = (reply) => {
      previous(reply)
      listener(reply)
    }
  }

  call(command: string, ...args: Array<string | number | Uint8Array>): Promise<unknown> {
    return this.raw(command, ...args).then((reply) => decodeReply(reply))
  }

  raw(command: string, ...args: Array<string | number | Uint8Array>): Promise<Reply> {
    return this.redis.perform(
      this.session,
      command,
      args.map((arg) => toArg(arg)),
    )
  }

  pipeline(): RedisPipeline {
    return new RedisPipeline(this)
  }

  async quit(): Promise<string> {
    const reply = await this.call("QUIT")
    this.session.dead = true
    return String(reply)
  }
}

export class RedisPipeline {
  private readonly commands: Array<{ name: string; args: Array<string | number | Uint8Array> }> = []

  constructor(private readonly client: RedisClient) {}

  call(name: string, ...args: Array<string | number | Uint8Array>): this {
    this.commands.push({ name, args })
    return this
  }

  async exec(): Promise<unknown[]> {
    const out: unknown[] = []
    for (const command of this.commands) {
      try {
        out.push(await this.client.call(command.name, ...command.args))
      } catch (error) {
        out.push(error)
      }
    }
    return out
  }
}

export function createRedis(options?: RedisOptions): Redis {
  return new Redis(options ?? {})
}

export { manualClock, wallClock } from "./clock.ts"
export { encodeReply } from "./protocol.ts"
