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
 * What names an id base: a non-negative safe integer (or its decimal string) or `"boot"`,
 * which derives the base from the wall clock when the runtime is created.
 */
export type IdBase = number | string

const ID_BASES = new WeakMap<SqliteClient, number>()

/**
 * Resolve an id base. `"boot"` is the wall clock in epoch milliseconds, so every boot gets
 * a different base. Anything else must be a non-negative safe integer or a string of digits.
 */
export const normalizeIdBase = (
  value: unknown,
  label = "idBase",
  wallNow: () => number = Date.now,
): number => {
  if (value === "boot") return wallNow()
  const base =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : typeof value === "number"
        ? value
        : Number.NaN
  if (!Number.isSafeInteger(base) || base < 0)
    throw new RangeError(
      `${label} must be a non-negative integer or "boot" (got ${JSON.stringify(value)})`,
    )
  return base
}

/**
 * Give every {@link IdSequence} over `sqlite` this base. `0` is the default and changes
 * nothing; any other base yields a different, unrelated run of ids from the same counters.
 */
export const setIdBase = (sqlite: SqliteClient, base: number): void => {
  if (base === 0) ID_BASES.delete(sqlite)
  else ID_BASES.set(sqlite, base)
}

/** The id base in force over `sqlite` (`0` unless one was set). */
export const idBaseOf = (sqlite: SqliteClient): number => ID_BASES.get(sqlite) ?? 0

/**
 * Sequential id source persisted in SQLite. Ids are deterministic for a given
 * sequence history (`cus_` + 14 opaque chars), so reproductions stay stable.
 * A runtime's `idBase` is mixed in, so a different base reissues none of another's ids.
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
      const base = idBaseOf(this.sqlite)
      const seed = base === 0 ? this.salt : `${this.salt}#${base}`
      return `${prefix}${opaqueToken(`${seed}:${prefix}:${value}`, length)}`
    })
  }
}
