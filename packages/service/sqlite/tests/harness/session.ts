import { okResult, rowidKind } from "./assert.ts";
import type { ErrorPhase, QueryResult, SqlValue } from "./types.ts";

export function sessionFields(
  lastInsertRowid: number | bigint,
  totalChanges: number,
  inTransaction: boolean,
): Pick<QueryResult, "totalChanges" | "inTransaction" | "lastInsertRowidKind"> {
  return {
    lastInsertRowidKind: rowidKind(lastInsertRowid),
    totalChanges,
    inTransaction,
  };
}

export function okWithSession(
  columns: string[],
  rows: Record<string, SqlValue>[],
  changes: number,
  lastInsertRowid: number | bigint,
  totalChanges: number,
  inTransaction: boolean,
  values?: SqlValue[][],
): QueryResult {
  return okResult(columns, rows, changes, lastInsertRowid, values, { totalChanges, inTransaction });
}

export function failResult(
  error: QueryResult["error"],
  totalChanges = 0,
  inTransaction = false,
  phase?: ErrorPhase,
): QueryResult {
  return {
    ok: false,
    columns: [],
    rows: [],
    changes: 0,
    lastInsertRowid: 0,
    lastInsertRowidKind: "number",
    totalChanges,
    inTransaction,
    error: error
      ? {
          ...error,
          phase: error.phase ?? phase,
        }
      : error,
  };
}

/** Track autocommit from statement text when the driver has no get_autocommit. */
export function applyTxnSql(sql: string, inTxn: boolean): boolean {
  const text = sql.replace(/^\s+/u, "");
  if (/^BEGIN\b/i.test(text)) return true;
  if (/^(COMMIT|END)\b/i.test(text)) return false;
  if (/^ROLLBACK\b/i.test(text) && !/^ROLLBACK\s+TO\b/i.test(text)) return false;
  if (/^SAVEPOINT\b/i.test(text)) return inTxn;
  return inTxn;
}
