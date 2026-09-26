/** JS values accepted as bind parameters by both backends. */
export type SqlValue = null | boolean | number | bigint | string | Uint8Array;

/** Result cells are canonical PostgreSQL text (psql-style); NULL stays null. */
export type CellValue = string | null;

/**
 * Coarse error classes derived from SQLSTATE. Both backends report SQLSTATE,
 * so classification is a pure code→class mapping (no message sniffing).
 */
export type ErrorCategory =
  | "syntax"
  | "undefined_table"
  | "undefined_column"
  | "undefined_function"
  | "undefined_object"
  | "duplicate_object"
  | "constraint_unique"
  | "constraint_notnull"
  | "constraint_check"
  | "constraint_foreign"
  | "constraint"
  | "division_by_zero"
  | "invalid_text_representation"
  | "numeric_out_of_range"
  | "datatype_mismatch"
  | "invalid_parameter"
  | "grouping"
  | "windowing"
  | "ambiguous"
  | "transaction"
  | "unsupported"
  | "data_exception"
  | "cardinality"
  | "misuse"
  | "other";

export type ErrorPhase = "prepare" | "step";

export interface QueryError {
  category: ErrorCategory;
  message: string;
  /** five-character SQLSTATE (e.g. 42P01) when the backend reports one */
  sqlstate?: string;
  phase?: ErrorPhase;
}

export interface QueryResult {
  ok: boolean;
  columns: string[];
  /** rows keyed by column name (last duplicate wins); prefer `values` for comparison */
  rows: Record<string, CellValue>[];
  /** positional text cells — authoritative for comparison */
  values: CellValue[][];
  /** rows affected by the statement (INSERT/UPDATE/DELETE row count) */
  changes: number;
  /** command tag, e.g. "SELECT", "INSERT" */
  command?: string;
  inTransaction?: boolean;
  error?: QueryError;
}

export interface ContractStatement {
  run(...params: SqlValue[]): Promise<QueryResult>;
  all(...params: SqlValue[]): Promise<QueryResult>;
  get(...params: SqlValue[]): Promise<QueryResult>;
}

/**
 * Differential-test database interface. Async because the PGlite oracle is
 * async; the postgres-mem public API itself stays synchronous.
 */
export interface ContractDb {
  exec(sql: string, params?: SqlValue[]): Promise<QueryResult>;
  query(sql: string, params?: SqlValue[]): Promise<QueryResult>;
  prepare(sql: string): ContractStatement;
  snapshot(): Uint8Array;
  restore(bytes: Uint8Array): void;
  close(): Promise<void>;
  inTransaction(): boolean;
}
