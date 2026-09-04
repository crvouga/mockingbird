import type { KeyValueStore, ListOptions } from "./key-value-store.js"

/** A bidirectional mapping between a typed value and the bytes adapters understand. */
export type Codec<T> = {
  encode(value: T): Uint8Array
  decode(bytes: Uint8Array): T
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** UTF-8 text codec. */
export const utf8: Codec<string> = {
  encode: (value) => encoder.encode(value),
  decode: (bytes) => decoder.decode(bytes),
}

/** JSON codec layered on UTF-8. Values must be JSON-serialisable. */
export const jsonCodec = <T>(): Codec<T> => ({
  encode: (value) => utf8.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(utf8.decode(bytes)) as T,
})

/** A store whose values are typed instead of raw bytes. */
export interface TypedKV<T> {
  get(key: string): Promise<T | undefined>
  set(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(options?: ListOptions): AsyncIterable<{ key: string; value: T }>
}

/** Wrap a byte store with a codec. */
export const typed = <T>(kv: KeyValueStore, codec: Codec<T>): TypedKV<T> => ({
  async get(key) {
    const bytes = await kv.get(key)
    return bytes === undefined ? undefined : codec.decode(bytes)
  },
  set(key, value) {
    return kv.set(key, codec.encode(value))
  },
  delete(key) {
    return kv.delete(key)
  },
  async *list(options) {
    for await (const entry of kv.list(options)) {
      yield { key: entry.key, value: codec.decode(entry.value) }
    }
  },
})

/** Convenience: a JSON-typed view of `kv`. */
export const json = <T>(kv: KeyValueStore): TypedKV<T> => typed(kv, jsonCodec<T>())

/** Convenience: a UTF-8 string view of `kv`. */
export const text = (kv: KeyValueStore): TypedKV<string> => typed(kv, utf8)
