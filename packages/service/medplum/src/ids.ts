import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** 32-bit FNV-1a with an avalanche finish. */
const mix = (input: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

const hexOf = (input: string, length: number): string => {
  let out = ""
  for (let round = 0; out.length < length; round++)
    out += mix(`${input}#${round}`).toString(16).padStart(8, "0")
  return out.slice(0, length)
}

/** A UUID v4-shaped id derived from `input` (version and variant bits set). */
export const uuidFrom = (input: string): string => {
  const hex = hexOf(input, 32)
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Deterministic id and secret source persisted in the namespace's SQLite sequences, so ids
 * replay exactly from a seed and survive snapshot/restore. Ids are UUIDs (as Medplum's are);
 * secrets are hex strings of `2 * bytes` characters (Medplum's `generateSecret`).
 */
export class IdSource {
  constructor(
    private readonly sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly salt: string,
  ) {}

  private next(name: string): number {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          "SELECT value FROM mockingbird_sequences WHERE namespace = ? AND name = ? AND kind = 'id'",
        )
        .get<{ value: number }>(this.namespace, name)
      const value = (row?.value ?? 0) + 1
      this.sqlite
        .prepare(
          `INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, 'id', ?)
           ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
        )
        .run(this.namespace, name, value)
      return value
    })
  }

  uuid(): string {
    return uuidFrom(`${this.salt}:uuid:${this.next("medplum-uuid")}`)
  }

  secret(bytes: number): string {
    return hexOf(`${this.salt}:secret:${this.next("medplum-secret")}`, bytes * 2)
  }
}
