/** Coarse classification of {@link SqliteError} for catch-site branching.
 *
 * New categories may be added in minor releases. Consumers that switch on
 * `category` must include a default case.
 */
export type ErrorCategory =
  | "syntax"
  | "no_such_table"
  | "no_such_column"
  | "constraint_unique"
  | "constraint_primary"
  | "constraint_notnull"
  | "constraint_check"
  | "constraint_foreign"
  | "constraint"
  | "transaction"
  | "datatype_mismatch"
  | "unsupported"
  | "misuse"
  | "snapshot_version"
  | "other"
  | (string & {});

/**
 * Engine error. `name` is always `"SqliteError"`.
 *
 * `sqliteCode` and Node's conventional `code` property are always set (default
 * `"SQLITE_ERROR"` when no more specific code applies).
 *
 * @example
 * ```ts
 * import { Database, SqliteError } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * try {
 *   db.exec("SELECT * FROM missing");
 * } catch (err) {
 *   if (err instanceof SqliteError && err.category === "no_such_table") {
 *     // handle
 *   }
 * }
 * ```
 */
export class SqliteError extends Error {
  /** Coarse error class (constraint vs syntax vs missing object, …). */
  readonly category: ErrorCategory;
  /** SQLite result-code name such as `SQLITE_CONSTRAINT_UNIQUE`. */
  readonly sqliteCode: string;
  /** Same value as {@link sqliteCode} (Node `err.code` convention). */
  readonly code: string;

  /**
   * @param message - Human-readable error text.
   * @param category - Coarse class; defaults to `"other"`.
   * @param sqliteCode - SQLite result-code name; defaults to `"SQLITE_ERROR"`.
   */
  constructor(message: string, category: ErrorCategory = "other", sqliteCode = "SQLITE_ERROR") {
    super(message);
    this.name = "SqliteError";
    this.category = category;
    this.sqliteCode = sqliteCode;
    this.code = sqliteCode;
  }
}

export function unsupported(feature: string): never {
  throw new SqliteError(`Unsupported SQLite feature: ${feature}`, "unsupported");
}

export class TriggerRaiseError extends SqliteError {
  readonly action: "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK";

  constructor(action: "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK", message?: string) {
    super(
      message ?? action,
      action === "FAIL" ? "constraint" : "other",
      action === "FAIL" ? "SQLITE_CONSTRAINT" : undefined,
    );
    this.action = action;
  }
}
