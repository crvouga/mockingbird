import { Database } from "@crvouga/sqlite-mem"
import type { SqliteClient } from "./client.js"

/** Construct the default in-memory SQLite client (`@crvouga/sqlite-mem`). */
export const createDefaultSqlite = (): SqliteClient => new Database()

/** Use the injected client, or fall back to {@link createDefaultSqlite}. */
export const resolveSqlite = (sqlite?: SqliteClient): SqliteClient =>
  sqlite ?? createDefaultSqlite()
