/**
 * @packageDocumentation
 * Pure TypeScript in-memory PostgreSQL. Import {@link Database} to get started.
 *
 * Deterministic by default (`random()` seed `1`, `now()` = `2000-01-01T00:00:00.000Z`).
 * Pass `{ random: "os" }` / `{ now: "system" }` for PostgreSQL-like entropy and wall clock.
 * Zero WASM, native bindings, or filesystem.
 *
 * Advanced / internal helpers live under `@crvouga/mockingbird-service-postgres/unstable` and are
 * exempt from semver.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/mockingbird-service-postgres";
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

export {
  type BufferedDurabilityObserver,
  type BufferedDurabilityOptions,
  type BufferedDurable,
  browserDurabilityLifecycle,
  type DurabilityBackend,
  type DurabilityCodec,
  DurabilityConflictError,
  type DurabilityLifecycle,
  type DurabilityScheduler,
  type Durable,
  type DurableImage,
  type DurableOptions,
  type DurablePatch,
  encodeDurableCheckpoint,
  type IncrementalCapture,
  type IncrementalDurabilityCodec,
  IndexedDBDurabilityBackend,
  type IndexedDBDurabilityOptions,
  LocalStorageDurabilityBackend,
  type LocalStorageDurabilityOptions,
  MemoryDurabilityBackend,
  openBufferedDurable,
  openDurable,
  packDurableRecord,
  readDurableJournal,
  unpackDurableRecord,
  withDurability,
} from "@crvouga/mockingbird-core";
export type { BindValue, JsValue, QueryRow } from "./api/bind.ts";
export { type BufferedDurableDatabaseOptions, openBufferedDurableDatabase } from "./api/buffered.ts";
export {
  Database,
  type DatabaseFaults,
  type DatabaseHistory,
  type DatabaseOptions,
  type HistoryCheckpoint,
  type QueryOptions,
  type RegisterFunctionOptions,
  Snapshot,
} from "./api/database.ts";
export { type DurableDatabaseOptions, openDurableDatabase } from "./api/durable.ts";
export {
  analyzeSchema,
  type SchemaDiagnostic,
  type SchemaReport,
  type SchemaReportOptions,
} from "./api/schema-report.ts";
export { type ResultSet, type RunResult, Statement } from "./api/statement.ts";
export { type ErrorCategory, PostgresError } from "./errors/error.ts";
