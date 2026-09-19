import type { CellValue, ErrorPhase, QueryResult } from "./types.ts";

export function okResult(
  columns: string[],
  values: CellValue[][],
  changes = 0,
  command?: string,
  inTransaction?: boolean,
): QueryResult {
  const rows = values.map((row) => {
    const obj: Record<string, CellValue> = {};
    columns.forEach((c, i) => {
      obj[c] = row[i] ?? null;
    });
    return obj;
  });
  return {
    ok: true,
    columns,
    rows,
    values,
    changes,
    ...(command !== undefined ? { command } : {}),
    ...(inTransaction !== undefined ? { inTransaction } : {}),
  };
}

export function failResult(error: QueryResult["error"], inTransaction = false, phase?: ErrorPhase): QueryResult {
  return {
    ok: false,
    columns: [],
    rows: [],
    values: [],
    changes: 0,
    inTransaction,
    error: error ? { ...error, phase: error.phase ?? phase } : error,
  };
}

/** Track autocommit from statement text when the driver has no get_autocommit. */
export function applyTxnSql(sql: string, inTxn: boolean): boolean {
  const text = sql.replace(/^\s+/u, "");
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(text)) return true;
  if (/^(COMMIT|END)\b/i.test(text)) return false;
  if (/^ROLLBACK\b/i.test(text) && !/^ROLLBACK\s+TO\b/i.test(text)) return false;
  return inTxn;
}
