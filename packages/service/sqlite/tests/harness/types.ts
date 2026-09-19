export type SqlValue = null | number | bigint | string | Uint8Array;

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
  | "other";

export type ErrorPhase = "prepare" | "step";
export type RowidJsKind = "number" | "bigint";

export interface QueryError {
  category: ErrorCategory;
  message: string;
  sqliteCode?: string;
  phase?: ErrorPhase;
}

export interface QueryResult {
  ok: boolean;
  columns: string[];
  rows: Record<string, SqlValue>[];
  /** Positional row values; preferred for comparison when duplicate column names exist. */
  values?: SqlValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
  lastInsertRowidKind?: RowidJsKind;
  totalChanges?: number;
  inTransaction?: boolean;
  error?: QueryError;
}

export interface ContractStatement {
  run(...params: SqlValue[]): QueryResult;
  all(...params: SqlValue[]): QueryResult;
  get(...params: SqlValue[]): QueryResult;
}

export interface ContractDb {
  exec(sql: string, params?: SqlValue[]): QueryResult;
  query(sql: string, params?: SqlValue[]): QueryResult;
  prepare(sql: string): ContractStatement;
  transaction<T>(fn: () => T): T;
  snapshot(): Uint8Array;
  restore(bytes: Uint8Array): void;
  close(): void;
  inTransaction(): boolean;
  totalChanges(): number;
}

export type NormalizedValue =
  | { kind: "null" }
  | { kind: "integer"; value: number | bigint }
  | { kind: "real"; value: number }
  | { kind: "text"; value: string }
  | { kind: "blob"; value: Uint8Array };

export interface NormalizedResult {
  ok: boolean;
  columns: string[];
  rows: NormalizedValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
  lastInsertRowidKind?: RowidJsKind;
  totalChanges?: number;
  inTransaction?: boolean;
  error?: QueryError;
}
