/**
 * @packageDocumentation
 * Pure TypeScript in-memory SQLite. Import {@link Database} to get started.
 *
 * Deterministic by default (`random()` seed `1`, `'now'` = `2000-01-01T00:00:00.000Z`).
 * Pass `{ random: "os" }` / `{ now: "system" }` for SQLite-like entropy and wall clock.
 * Zero WASM, native bindings, or filesystem.
 *
 * Advanced / internal helpers live under `@crvouga/sqlite-mem/unstable` and are
 * exempt from semver.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
 * db.prepare("INSERT INTO t (name) VALUES (?)").run("Ada");
 * const rows = db.query<{ id: number; name: string }>("SELECT * FROM t");
 * ```
 *
 * @module
 */
export { Database, Snapshot, type DatabaseOptions } from "./api/database.ts";
export { type RunResult, Statement } from "./api/statement.ts";
export { type ErrorCategory, SqliteError } from "./errors/index.ts";
export type { ResultSet } from "./executor/result.ts";
export type { BindValue, QueryRow, QueryValue } from "./types/value.ts";
