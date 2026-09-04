/** Bind values accepted by Mockingbird's SQLite port (matches sqlite-mem / better-sqlite3). */
export type SqliteValue = null | number | bigint | string | Uint8Array | boolean

/** Mutation counters returned by {@link SqliteStatement.run}. */
export type SqliteRunResult = {
  changes: number
  lastInsertRowid: number | bigint
}

/**
 * Prepared statement bound to a {@link SqliteClient}.
 *
 * Pass bind values as rest arguments on each call (no sticky `bind()`).
 */
export interface SqliteStatement {
  run(...params: SqliteValue[]): SqliteRunResult
  all<T = Record<string, unknown>>(...params: SqliteValue[]): T[]
  get<T = Record<string, unknown>>(...params: SqliteValue[]): T | undefined
}

/**
 * Sync SQLite client port owned by Mockingbird.
 *
 * Duck-typed so `@crvouga/sqlite-mem` `Database`, better-sqlite3, and wrapped
 * `bun:sqlite` instances all work when they expose this surface.
 */
export interface SqliteClient {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  transaction<T>(fn: () => T): T
}
