import { json, type KeyValueStore, namespace } from "@crvouga/mockingbird-kv"

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** FNV-1a over a string, mixed once more so consecutive counters look unrelated. */
const mix = (input: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  return hash >>> 0
}

/** Deterministic, opaque-looking alphanumeric token of `length` characters derived from `input`. */
export const opaqueToken = (input: string, length: number): string => {
  let out = ""
  let round = 0
  while (out.length < length) {
    let hash = mix(`${input}:${round++}`)
    for (let i = 0; i < 5 && out.length < length; i++) {
      out += ALPHABET.charAt(hash % ALPHABET.length)
      hash = Math.floor(hash / ALPHABET.length)
    }
  }
  return out
}

/**
 * Sequential id source persisted in kv. Ids are deterministic for a given kv history
 * (`cus_` + 14 opaque chars, like `cus_Qh3kLm9zXcVbN2`), so reproductions stay stable.
 */
export class IdSequence {
  private readonly counters

  constructor(
    kv: KeyValueStore,
    private readonly salt = "mockingbird",
  ) {
    this.counters = json<number>(namespace(kv, "ids"))
  }

  async next(prefix: string, length = 14): Promise<string> {
    const current = (await this.counters.get(prefix)) ?? 0
    const value = current + 1
    await this.counters.set(prefix, value)
    return `${prefix}${opaqueToken(`${this.salt}:${prefix}:${value}`, length)}`
  }
}
