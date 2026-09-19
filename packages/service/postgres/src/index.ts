/**
 * @packageDocumentation
 * Pure TypeScript in-memory PostgreSQL. Import {@link Database} to get started.
 *
 * Deterministic by default (`random()` seed `1`, `now()` = `2000-01-01T00:00:00.000Z`).
 * Pass `{ random: "os" }` / `{ now: "system" }` for PostgreSQL-like entropy and wall clock.
 * Zero WASM, native bindings, or filesystem.
 *
 * Advanced / internal helpers live under `@crvouga/postgres-mem/unstable` and are
 * exempt from semver.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/postgres-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
 * db.prepare("INSERT INTO t (name) VALUES ($1)").run("Ada");
 * const rows = db.query<{ id: number; name: string }>("SELECT * FROM t");
 * ```
 *
 * @module
 */
import "./serialization/codec.ts";

export type { BindValue, JsValue, QueryRow } from "./api/bind.ts";
export { Database, type DatabaseOptions, type RegisterFunctionOptions, Snapshot } from "./api/database.ts";
export { type ResultSet, type RunResult, Statement } from "./api/statement.ts";
export { type ErrorCategory, PostgresError } from "./errors/error.ts";
