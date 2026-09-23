import { isSqlJsonText, isSqlReal, type QueryRow, type QueryValue, type SqlValue } from "../types/value.ts";

/** Query result returned by {@link Statement.result}. */
export interface ResultSet {
  /** Result-column names, in SELECT order. Present even when `rows` is empty. */
  columns: string[];
  /** Named rows. Duplicate column names keep the last value. */
  rows: QueryRow[];
  /** Positional rows; always present (empty array when there are zero rows). */
  values: QueryValue[][];
  /** Rows changed by the most recent mutating statement in this execution. */
  changes: number;
  /** Rowid of the most recent INSERT in this execution. */
  lastInsertRowid: number | bigint;
}

export function emptyResult(changes = 0, lastInsertRowid: number | bigint = 0): ResultSet {
  return { columns: [], rows: [], values: [], changes, lastInsertRowid };
}

/** Export engine values to the public JS surface (SqlReal → number, SqlJsonText → string). */
export function exportSqlValue(value: SqlValue): QueryValue {
  if (isSqlReal(value)) return value.value;
  if (isSqlJsonText(value)) return value.value;
  return value;
}

export function valuesToResult(
  columns: string[],
  values: SqlValue[][],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
  options?: { named?: boolean; keepValues?: boolean },
): ResultSet {
  const named = options?.named !== false;
  const keepValues = options?.keepValues !== false;
  return {
    columns,
    values: keepValues ? values.map((row) => row.map(exportSqlValue)) : [],
    rows: named
      ? values.map((row) => {
          const object: QueryRow = {};
          for (let index = 0; index < columns.length; index++) {
            object[columns[index]!] = exportSqlValue(row[index] ?? null);
          }
          return object;
        })
      : [],
    changes,
    lastInsertRowid,
  };
}

export function resultValues(result: ResultSet): SqlValue[][] {
  if (result.values.length > 0 || result.rows.length === 0) {
    return result.values.map((row) => [...row]);
  }
  return result.rows.map((row) => result.columns.map((column) => row[column] ?? null));
}
