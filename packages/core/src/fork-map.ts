type Key = string | number | bigint
type Entry<K, V> = { key: K; value: V; position: number; sequence: number }
type Bucket<K, V> = { owner: object; data: Map<K, Entry<K, V>> }
type Group<K, V> = { owner: object; buckets: (Bucket<K, V> | undefined)[] }
type Index<K, V> = { owner: object; groups: (Group<K, V> | undefined)[] }
type Order<K, V> = {
  owner: object
  cells: (Order<K, V> | Entry<K, V> | undefined)[]
}

/**
 * An insertion-ordered map for primitive storage keys with O(1) forks. Writes detach
 * two small hash directories, one native hash bucket, and a path of 32-cell order pages.
 * Values retain ordinary Map reference semantics: callers own value-level copy-on-write.
 */
export class ForkMap<K extends Key, V> implements Map<K, V> {
  private owner: object = {}
  private index: Index<K, V> = { owner: this.owner, groups: [] }
  private order: Order<K, V> = { owner: this.owner, cells: [] }
  private shift = 0
  private length = 0
  private count = 0
  private nextSequence = 0
  private layout = 0
  private cleared = 0
  private version = 0

  constructor(entries?: Iterable<readonly [K, V]>) {
    if (entries) for (const [key, value] of entries) this.set(key, value)
  }

  get size(): number {
    return this.count
  }

  get [Symbol.toStringTag](): string {
    return "Map"
  }

  fork(): ForkMap<K, V> {
    const copy = new ForkMap<K, V>()
    copy.index = this.index
    copy.order = this.order
    copy.shift = this.shift
    copy.length = this.length
    copy.count = this.count
    copy.nextSequence = this.nextSequence
    // Neither side may mutate directories/buckets created before this fork.
    this.owner = {}
    return copy
  }

  /** Visit changed hash buckets only. Values must be replaced, rather than mutated in place. */
  *changes(
    previous?: ForkMap<K, V>,
  ): Iterable<{ key: K; value: V; deleted: false } | { key: K; deleted: true }> {
    if (previous?.index === this.index) return
    for (let group = 0; group < 32; group++) {
      const currentGroup = this.index.groups[group]
      const oldGroup = previous?.index.groups[group]
      if (currentGroup === oldGroup) continue
      for (let bucket = 0; bucket < 32; bucket++) {
        const current = currentGroup?.buckets[bucket]?.data
        const old = oldGroup?.buckets[bucket]?.data
        if (current === old) continue
        if (current)
          for (const [key, entry] of current) {
            const before = old?.get(key)
            if (
              !before ||
              !Object.is(before.value, entry.value) ||
              before.sequence !== entry.sequence
            )
              yield { key, value: entry.value, deleted: false }
          }
        if (old) for (const key of old.keys()) if (!current?.has(key)) yield { key, deleted: true }
      }
    }
  }

  get(key: K): V | undefined {
    return this.find(key)?.value
  }

  has(key: K): boolean {
    return this.find(key) !== undefined
  }

  set(key: K, value: V): this {
    // Native Map canonicalizes -0 in keys/iteration.
    if (typeof key === "number" && key === 0) key = 0 as K
    const hash = hashKey(key)
    const existing = this.bucket(hash)?.get(key)
    if (existing && Object.is(existing.value, value)) return this
    const entry = existing
      ? { ...existing, value }
      : { key, value, position: this.length++, sequence: this.nextSequence++ }
    this.writableBucket(hash).set(key, entry)
    this.writeOrder(entry.position, entry)
    if (!existing) this.count++
    this.version++
    return this
  }

  delete(key: K): boolean {
    const hash = hashKey(key)
    const entry = this.bucket(hash)?.get(key)
    if (!entry) return false
    this.writableBucket(hash).delete(key)
    this.writeOrder(entry.position, undefined)
    this.count--
    this.version++
    if (this.length > 1024 && this.length > this.count * 2) this.compact()
    return true
  }

  clear(): void {
    this.index = { owner: this.owner, groups: [] }
    this.order = { owner: this.owner, cells: [] }
    this.shift = this.length = this.count = this.nextSequence = 0
    this.layout++
    this.cleared++
    this.version++
  }

  entries(): MapIterator<[K, V]> {
    return this.iterate(0) as MapIterator<[K, V]>
  }

  keys(): MapIterator<K> {
    return this.iterate(1) as MapIterator<K>
  }

  values(): MapIterator<V> {
    return this.iterate(2) as MapIterator<V>
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this)
  }

  private find(key: K): Entry<K, V> | undefined {
    return this.bucket(hashKey(key))?.get(key)
  }

  private bucket(hash: number): Map<K, Entry<K, V>> | undefined {
    return this.index.groups[(hash >>> 5) & 31]?.buckets[hash & 31]?.data
  }

  private writableBucket(hash: number): Map<K, Entry<K, V>> {
    if (this.index.owner !== this.owner)
      this.index = { owner: this.owner, groups: this.index.groups.slice() }
    const groupIndex = (hash >>> 5) & 31
    let group = this.index.groups[groupIndex]
    if (!group || group.owner !== this.owner) {
      group = { owner: this.owner, buckets: group?.buckets.slice() ?? [] }
      this.index.groups[groupIndex] = group
    }
    const at = hash & 31
    let bucket = group.buckets[at]
    if (!bucket || bucket.owner !== this.owner) {
      bucket = { owner: this.owner, data: bucket ? this.copyBucket(bucket.data) : new Map() }
      group.buckets[at] = bucket
    }
    return bucket.data
  }

  private copyBucket(bucket: Map<K, Entry<K, V>>): Map<K, Entry<K, V>> {
    return new Map(bucket)
  }

  private leaf(position: number): Order<K, V> {
    let node = this.order
    for (let shift = this.shift; shift > 0; shift -= 5)
      node = node.cells[Math.floor(position / 2 ** shift) & 31] as Order<K, V>
    return node
  }

  private writeOrder(position: number, entry: Entry<K, V> | undefined): void {
    while (position >= 2 ** (this.shift + 5)) {
      this.order = { owner: this.owner, cells: [this.order] }
      this.shift += 5
    }
    if (this.order.owner !== this.owner)
      this.order = { owner: this.owner, cells: this.order.cells.slice() }
    let node = this.order
    for (let shift = this.shift; shift > 0; shift -= 5) {
      const at = Math.floor(position / 2 ** shift) & 31
      let child = node.cells[at] as Order<K, V> | undefined
      if (!child || child.owner !== this.owner) {
        child = { owner: this.owner, cells: child?.cells.slice() ?? [] }
        node.cells[at] = child
      }
      node = child
    }
    node.cells[position & 31] = entry
  }

  private compact(): void {
    const entries: Entry<K, V>[] = []
    for (let position = 0; position < this.length; position++) {
      const entry = this.leaf(position).cells[position & 31] as Entry<K, V> | undefined
      if (entry) entries.push(entry)
    }
    this.index = { owner: this.owner, groups: [] }
    this.order = { owner: this.owner, cells: [] }
    this.shift = this.length = this.count = 0
    // Preserve monotonic sequence markers so live iterators can resume after compaction.
    for (const original of entries) {
      const entry = { ...original, position: this.length++ }
      this.writableBucket(hashKey(entry.key)).set(entry.key, entry)
      this.writeOrder(entry.position, entry)
      this.count++
    }
    this.layout++
  }

  private *iterate(kind: 0 | 1 | 2): MapIterator<K | V | [K, V]> {
    let position = 0
    let layout = this.layout
    let cleared = this.cleared
    let lastSequence = -1
    let version = -1
    let leaf: Order<K, V> | undefined
    let page = -1
    for (;;) {
      if (cleared !== this.cleared) {
        position = 0
        lastSequence = -1
        cleared = this.cleared
      }
      if (layout !== this.layout) {
        position = 0
        while (position < this.length) {
          const entry = this.leaf(position).cells[position & 31] as Entry<K, V> | undefined
          if (entry && entry.sequence > lastSequence) break
          position++
        }
        layout = this.layout
      }
      if (position >= this.length) return
      const nextPage = Math.floor(position / 32)
      if (page !== nextPage || version !== this.version) {
        leaf = this.leaf(position)
        page = nextPage
        version = this.version
      }
      const entry = leaf?.cells[position++ & 31] as Entry<K, V> | undefined
      if (!entry) continue
      lastSequence = entry.sequence
      yield kind === 0 ? [entry.key, entry.value] : kind === 1 ? entry.key : entry.value
    }
  }
}

function hashKey(key: Key): number {
  if (typeof key === "number" && Number.isInteger(key))
    return mix((key | 0) ^ ((key / 0x1_0000_0000) | 0))
  if (typeof key === "bigint") return mix(Number(BigInt.asIntN(32, key ^ (key >> 32n))))
  const text = String(key)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return hash
}

function mix(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return value ^ (value >>> 16)
}
