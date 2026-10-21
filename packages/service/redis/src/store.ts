import { cmpBytes, globMatch, latin1 } from "./bytes.ts"
import type { RedisClock } from "./clock.ts"

export type { RedisClock }
export { globMatch }

export interface StreamEntry {
  id: string
  ms: bigint
  seq: bigint
  fields: Uint8Array[]
}

export interface PelItem {
  id: string
  consumer: string
  deliveries: number
  deliveredAt: number
}

export interface StreamConsumer {
  seenAt: number
}

export interface ConsumerGroup {
  name: string
  lastId: string
  consumers: Map<string, StreamConsumer>
  pel: Map<string, PelItem>
}

export interface StreamState {
  entries: StreamEntry[]
  groups: Map<string, ConsumerGroup>
  lastMs: bigint
  lastSeq: bigint
}

export interface ZMember {
  member: Uint8Array
  score: number
}

export type Value =
  | { kind: "string"; bytes: Uint8Array }
  | { kind: "list"; items: Uint8Array[] }
  | { kind: "set"; members: Map<string, Uint8Array> }
  | { kind: "zset"; members: Map<string, ZMember> }
  | { kind: "hash"; fields: Map<string, Uint8Array>; fieldExpires?: Map<string, number> }
  | { kind: "stream"; stream: StreamState }

export function emptyStream(): StreamState {
  return { entries: [], groups: new Map(), lastMs: -1n, lastSeq: 0n }
}

export function typeName(value: Value | undefined): string {
  return value ? value.kind : "none"
}

export function parseStreamId(id: string): { ms: bigint; seq: bigint } | null {
  const dash = id.indexOf("-")
  if (dash <= 0 || dash === id.length - 1) return null
  const msText = id.slice(0, dash)
  const seqText = id.slice(dash + 1)
  if (!/^\d+$/.test(msText) || !/^\d+$/.test(seqText)) return null
  return { ms: BigInt(msText), seq: BigInt(seqText) }
}

export function cmpId(a: string, b: string): number {
  const left = parseStreamId(a)
  const right = parseStreamId(b)
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0
  if (left.ms !== right.ms) return left.ms < right.ms ? -1 : 1
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1
  return 0
}

export class Database {
  private values = new Map<string, Value>()
  private expires = new Map<string, number>()
  private gens = new Map<string, number>()
  private lru = new Map<string, number>()
  private touched = new Map<string, number>()
  private order: string[] = []
  private tick = 0

  constructor(private readonly clock: RedisClock) {}

  now(): number {
    return this.clock.now()
  }
  snapshot(): object {
    return structuredClone({
      values: this.values,
      expires: this.expires,
      gens: this.gens,
      lru: this.lru,
      touched: this.touched,
      order: this.order,
      tick: this.tick,
    })
  }
  restore(snapshot: object): void {
    const point = structuredClone(snapshot) as {
      values: Map<string, Value>
      expires: Map<string, number>
      gens: Map<string, number>
      lru: Map<string, number>
      touched?: Map<string, number>
      order: string[]
      tick: number
    }
    this.values = point.values
    this.expires = point.expires
    this.gens = point.gens
    this.lru = point.lru
    this.touched = point.touched ?? new Map()
    this.order = point.order
    this.tick = point.tick
  }

  private bump(key: string): void {
    this.gens.set(key, (this.gens.get(key) ?? 0) + 1)
  }

  sweep(key: string): void {
    this.sweepFields(key)
    const expiry = this.expires.get(key)
    if (expiry === undefined || expiry > this.clock.now()) return
    this.expires.delete(key)
    if (this.values.delete(key)) {
      this.bump(key)
      this.order = this.order.filter((item) => item !== key)
      this.lru.delete(key)
      this.touched.delete(key)
    }
  }

  /** Drop hash fields whose own TTL (`HEXPIRE`) has passed; a hash left empty goes away. */
  private sweepFields(key: string): void {
    const value = this.values.get(key)
    if (value?.kind !== "hash" || !value.fieldExpires?.size) return
    const now = this.clock.now()
    let changed = false
    for (const [field, at] of value.fieldExpires) {
      if (value.fields.has(field) && at > now) continue
      value.fieldExpires.delete(field)
      if (value.fields.delete(field)) changed = true
    }
    if (!changed) return
    this.bump(key)
    if (value.fields.size === 0) this.delete(key)
  }

  generation(key: string): number {
    this.sweep(key)
    return this.gens.get(key) ?? 0
  }

  get(key: string): Value | undefined {
    this.sweep(key)
    const value = this.values.get(key)
    if (value) this.touch(key)
    return value
  }

  /** Read a value without counting as an access (`OBJECT`, `MEMORY USAGE`). */
  peek(key: string): Value | undefined {
    this.sweep(key)
    return this.values.get(key)
  }

  /** Milliseconds since the key was last read or written, or null when it does not exist. */
  idleMs(key: string): number | null {
    this.sweep(key)
    if (!this.values.has(key)) return null
    return Math.max(0, this.clock.now() - (this.touched.get(key) ?? this.clock.now()))
  }

  private touch(key: string): void {
    this.lru.set(key, ++this.tick)
    this.touched.set(key, this.clock.now())
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  put(key: string, value: Value): void {
    this.sweep(key)
    if (!this.values.has(key)) this.order.push(key)
    this.values.set(key, value)
    this.bump(key)
    this.touch(key)
  }

  /** Remove the key when a collection has no elements left. Streams are kept. */
  dropIfEmpty(key: string): void {
    const value = this.values.get(key)
    if (!value) return
    const empty =
      (value.kind === "list" && value.items.length === 0) ||
      (value.kind === "set" && value.members.size === 0) ||
      (value.kind === "zset" && value.members.size === 0) ||
      (value.kind === "hash" && value.fields.size === 0)
    if (empty) this.delete(key)
  }

  setExpiry(key: string, at: number | null): void {
    if (!this.values.has(key)) return
    if (at === null) this.expires.delete(key)
    else this.expires.set(key, at)
    this.bump(key)
  }

  expiry(key: string): number | null {
    this.sweep(key)
    return this.expires.get(key) ?? null
  }

  pttl(key: string): number {
    this.sweep(key)
    if (!this.values.has(key)) return -2
    const expiry = this.expires.get(key)
    if (expiry === undefined) return -1
    return Math.max(0, expiry - this.clock.now())
  }

  delete(key: string): boolean {
    this.sweep(key)
    this.expires.delete(key)
    const had = this.values.delete(key)
    if (had) {
      this.bump(key)
      this.order = this.order.filter((item) => item !== key)
      this.lru.delete(key)
      this.touched.delete(key)
    }
    return had
  }

  rename(source: string, dest: string): boolean {
    const value = this.get(source)
    if (!value) return false
    const expiry = this.expires.get(source) ?? null
    this.delete(source)
    this.put(dest, value)
    if (expiry !== null) this.expires.set(dest, expiry)
    return true
  }

  keys(): string[] {
    const live: string[] = []
    for (const key of this.order) {
      this.sweep(key)
      if (this.values.has(key)) live.push(key)
    }
    this.order = live
    return live
  }

  matching(pattern: string): string[] {
    return this.keys().filter((key) => globMatch(pattern, key))
  }

  clear(): void {
    for (const key of [...this.values.keys()]) this.delete(key)
    this.values.clear()
    this.expires.clear()
    this.order = []
    this.lru.clear()
    this.touched.clear()
  }

  memory(): number {
    let total = 0
    for (const [key, value] of this.values) total += key.length + valueBytes(value)
    return total
  }

  evictLru(): string | null {
    let best: string | null = null
    let bestTick = Number.POSITIVE_INFINITY
    for (const [key, tick] of this.lru) {
      if (!this.values.has(key)) continue
      if (tick < bestTick) {
        best = key
        bestTick = tick
      }
    }
    if (best === null) return null
    this.delete(best)
    return best
  }

  zsetOrdered(value: Extract<Value, { kind: "zset" }>): ZMember[] {
    return [...value.members.values()].sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return cmpBytes(a.member, b.member)
    })
  }
}

function valueBytes(value: Value): number {
  switch (value.kind) {
    case "string":
      return value.bytes.length
    case "list":
      return value.items.reduce((sum, item) => sum + item.length, 0)
    case "set":
      return [...value.members.values()].reduce((sum, item) => sum + item.length, 0)
    case "zset":
      return [...value.members.values()].reduce((sum, item) => sum + item.member.length + 8, 0)
    case "hash":
      return [...value.fields.entries()].reduce(
        (sum, [field, item]) => sum + field.length + item.length,
        0,
      )
    case "stream":
      return value.stream.entries.reduce(
        (sum, entry) =>
          sum + entry.id.length + entry.fields.reduce((inner, field) => inner + field.length, 0),
        0,
      )
    default: {
      const never: never = value
      return never
    }
  }
}

export function memberKey(bytes: Uint8Array): string {
  return latin1(bytes)
}
