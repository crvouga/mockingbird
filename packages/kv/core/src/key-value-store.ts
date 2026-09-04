/** Options accepted by {@link KeyValueStore.list}. */
export type ListOptions = {
  /** Only yield keys starting with this prefix. Defaults to every key. */
  prefix?: string
}

/** One enumerated entry. */
export type KeyValueEntry = {
  key: string
  value: Uint8Array
}

/**
 * The persistence contract every Mockingbird service depends on.
 *
 * - async, binary-safe, string keys
 * - `list()` MUST yield keys in ascending lexicographic (code unit) order
 * - no transactions, no filesystem/SQL/runtime concepts
 *
 * Implement it in a few dozen lines on top of anything: Durable Objects, Redis, IndexedDB,
 * Deno KV, Cloudflare KV, an object store, or your own database.
 */
export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | undefined>
  set(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(options?: ListOptions): AsyncIterable<KeyValueEntry>
}

/**
 * The ordering every first-party adapter (and the conformance suite) uses for `list()`.
 * Compares by UTF-16 code units, which is what JavaScript's default `<` does for strings.
 */
export const compareKeys = (a: string, b: string): number => {
  if (a === b) return 0
  return a < b ? -1 : 1
}
