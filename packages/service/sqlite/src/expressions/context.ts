import type { SelectStmt } from "../ast/nodes.ts";
import type { FunctionContext, FunctionRegistry } from "../functions/registry.ts";
import type { Affinity, SqlValue, StorageClass } from "../types/value.ts";
import type { FtsMatchCursor } from "../vtable/fts5.ts";

/** Column / parameter / function resolution used by {@link evalExpr}. */
export interface EvalContext {
  resolveColumn(table: string | null, name: string): SqlValue;
  resolveStorageClass?(table: string | null, name: string): StorageClass;
  /** Declared column affinity when available (for comparisons). */
  resolveAffinity?(table: string | null, name: string): Affinity | null;
  /** Declared column collation when available (for inheritance). */
  resolveCollation?(table: string | null, name: string): string | null;
  getParameter(name: string | number): SqlValue;
  /** Execute a scalar, IN, or EXISTS subquery. */
  executeSelect?(select: SelectStmt): { columns: string[]; rows: SqlValue[][] };
  /** Evaluate FTS MATCH against the current row when available. */
  matchFts?(table: string | null, column: string, query: string): boolean;
  /** Active FTS MATCH cursor for auxiliary functions (bm25/highlight/snippet). */
  ftsMatch?: FtsMatchCursor | null;
  /** Context used to resolve correlated column references. */
  /** When set, RAISE() is allowed in expression evaluation. */
  raise?: (action: "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK", message?: string) => never;
  parent?: EvalContext;
  /** Optional per-database function registry and database hooks. */
  functions?: FunctionRegistry;
  functionContext?: FunctionContext;
}
