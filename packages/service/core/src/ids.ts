import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

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
 * Sequential id source persisted in SQLite. Ids are deterministic for a given
 * sequence history (`cus_` + 14 opaque chars), so reproductions stay stable.
 */
export class IdSequence {
  constructor(
    private readonly sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly salt = "mockingbird",
  ) {}

  next(prefix: string, length = 14): string {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          "SELECT value FROM mockingbird_sequences WHERE namespace = ? AND name = ? AND kind = 'id'",
        )
        .get<{ value: number }>(this.namespace, prefix)
      const value = (row?.value ?? 0) + 1
      this.sqlite
        .prepare(
          `INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, 'id', ?)
           ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
        )
        .run(this.namespace, prefix, value)
      return `${prefix}${opaqueToken(`${this.salt}:${prefix}:${value}`, length)}`
    })
  }
}
