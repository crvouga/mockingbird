import type { KeyValueEntry, KeyValueStore, ListOptions } from "./key-value-store.js"

/** Separator inserted between a namespace and the keys inside it. */
export const NAMESPACE_SEPARATOR = ":"

const prefixOf = (name: string) => `${name}${NAMESPACE_SEPARATOR}`

class NamespacedKV implements KeyValueStore {
  private readonly prefix: string

  constructor(
    private readonly kv: KeyValueStore,
    name: string,
  ) {
    if (name.length === 0) throw new RangeError("namespace name must not be empty")
    this.prefix = prefixOf(name)
  }

  get(key: string) {
    return this.kv.get(this.prefix + key)
  }

  set(key: string, value: Uint8Array) {
    return this.kv.set(this.prefix + key, value)
  }

  delete(key: string) {
    return this.kv.delete(this.prefix + key)
  }

  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const inner = this.prefix + (options.prefix ?? "")
    for await (const entry of this.kv.list({ prefix: inner })) {
      yield { key: entry.key.slice(this.prefix.length), value: entry.value }
    }
  }
}

/**
 * View a sub-tree of `kv` as its own store. Keys are transparently prefixed with `name:`.
 * Namespaces nest; ordering guarantees are preserved because the prefix is constant.
 */
export const namespace = (kv: KeyValueStore, name: string): KeyValueStore =>
  new NamespacedKV(kv, name)

/** Delete every key inside `name`. Returns how many keys were removed. */
export const clearNamespace = async (kv: KeyValueStore, name: string): Promise<number> => {
  const keys: string[] = []
  for await (const entry of kv.list({ prefix: prefixOf(name) })) keys.push(entry.key)
  for (const key of keys) await kv.delete(key)
  return keys.length
}

/** Delete every key in `kv`. Returns how many keys were removed. */
export const clearAll = async (kv: KeyValueStore): Promise<number> => {
  const keys: string[] = []
  for await (const entry of kv.list()) keys.push(entry.key)
  for (const key of keys) await kv.delete(key)
  return keys.length
}
