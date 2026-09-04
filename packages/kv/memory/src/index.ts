import {
  compareKeys,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
} from "@crvouga/mockingbird-kv"

/** An immutable copy of a {@link MemoryKV}'s contents. */
export type MemoryKVSnapshot = ReadonlyArray<readonly [key: string, value: Uint8Array]>

/**
 * `Map`-backed {@link KeyValueStore}.
 *
 * - portable: no runtime APIs beyond `Map` and `Uint8Array`
 * - `list()` sorts keys, so enumeration never depends on insertion order
 * - values are copied on the way in and out, so callers can't alias internal buffers
 */
export class MemoryKV implements KeyValueStore {
  private readonly entries = new Map<string, Uint8Array>()

  static fromSnapshot(snapshot: MemoryKVSnapshot): MemoryKV {
    const kv = new MemoryKV()
    kv.restore(snapshot)
    return kv
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.entries.get(key)
    return value === undefined ? undefined : value.slice()
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, value.slice())
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const prefix = options.prefix ?? ""
    const keys: string[] = []
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) keys.push(key)
    }
    keys.sort(compareKeys)
    for (const key of keys) {
      const value = this.entries.get(key)
      if (value !== undefined) yield { key, value: value.slice() }
    }
  }

  /** Number of keys currently stored. */
  get size(): number {
    return this.entries.size
  }

  /** Drop every key. */
  clear(): void {
    this.entries.clear()
  }

  /** Copy the current contents (sorted by key). */
  snapshot(): MemoryKVSnapshot {
    return [...this.entries.entries()]
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, value]) => [key, value.slice()] as const)
  }

  /** Replace the current contents with `snapshot`. */
  restore(snapshot: MemoryKVSnapshot): void {
    this.entries.clear()
    for (const [key, value] of snapshot) this.entries.set(key, value.slice())
  }
}
