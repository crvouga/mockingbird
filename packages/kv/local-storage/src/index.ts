import {
  compareKeys,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
} from "@crvouga/mockingbird-kv"

/**
 * The subset of the DOM `Storage` interface this adapter needs.
 * `globalThis.localStorage` and `sessionStorage` satisfy it; so does any in-memory stand-in.
 */
export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type LocalStorageKVOptions = {
  /** The DOM `Storage` instance to persist into. Injected so the module is SSR-safe. */
  storage: StorageLike
  /** Prefix separating Mockingbird's keys from anything else in the same `Storage`. Default `mockingbird:`. */
  prefix?: string
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

const lookup = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < BASE64_CHARS.length; i++) table[BASE64_CHARS.charCodeAt(i)] = i
  return table
})()

/** Standard base64 without relying on `btoa`/`Buffer` (both mangle arbitrary bytes or are non-portable). */
export const encodeBase64 = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out +=
      BASE64_CHARS.charAt((n >> 18) & 63) +
      BASE64_CHARS.charAt((n >> 12) & 63) +
      BASE64_CHARS.charAt((n >> 6) & 63) +
      BASE64_CHARS.charAt(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += `${BASE64_CHARS.charAt((n >> 18) & 63)}${BASE64_CHARS.charAt((n >> 12) & 63)}==`
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out += `${BASE64_CHARS.charAt((n >> 18) & 63)}${BASE64_CHARS.charAt((n >> 12) & 63)}${BASE64_CHARS.charAt((n >> 6) & 63)}=`
  }
  return out
}

export const decodeBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/=+$/, "")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let index = 0
  for (let i = 0; i < clean.length; i++) {
    const value = lookup[clean.charCodeAt(i)] as number
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, index)
}

/**
 * {@link KeyValueStore} on top of DOM `Storage` (localStorage / sessionStorage).
 *
 * - values are base64 encoded so arbitrary bytes survive the string-only API
 * - keys are prefixed so several stores (or unrelated app data) can share one `Storage`
 * - enumeration sorts keys; `Storage.key(i)` order is never relied upon
 * - never touches `window`, `localStorage`, or `document` at import time
 */
export class LocalStorageKV implements KeyValueStore {
  private readonly storage: StorageLike
  private readonly prefix: string

  constructor(options: LocalStorageKVOptions) {
    this.storage = options.storage
    this.prefix = options.prefix ?? "mockingbird:"
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const raw = this.storage.getItem(this.prefix + key)
    return raw === null ? undefined : decodeBase64(raw)
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.storage.setItem(this.prefix + key, encodeBase64(value))
  }

  async delete(key: string): Promise<void> {
    this.storage.removeItem(this.prefix + key)
  }

  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const fullPrefix = this.prefix + (options.prefix ?? "")
    const keys: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const stored = this.storage.key(i)
      if (stored?.startsWith(fullPrefix)) keys.push(stored.slice(this.prefix.length))
    }
    keys.sort(compareKeys)
    for (const key of keys) {
      const raw = this.storage.getItem(this.prefix + key)
      if (raw !== null) yield { key, value: decodeBase64(raw) }
    }
  }
}
