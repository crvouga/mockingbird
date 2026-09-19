import type { SqlValue } from "../types/value.ts";
import { cloneSqlValue } from "../types/value.ts";

export type Rowid = number | bigint;

/** Heap row: `values[i]` is `table.columns[i]`. */
export interface Row {
  rowid: Rowid;
  values: SqlValue[];
}

export type NamedRowValues = Map<string, SqlValue> | ReadonlyMap<string, SqlValue> | Record<string, SqlValue>;
export type RowValues = NamedRowValues | readonly SqlValue[];

export function normalizeColumnName(name: string): string {
  return name.toLowerCase();
}

export function rowValues(values: NamedRowValues): Map<string, SqlValue> {
  const result = new Map<string, SqlValue>();
  const entries = values instanceof Map ? values.entries() : Object.entries(values);
  for (const [name, value] of entries) {
    result.set(normalizeColumnName(name), value);
  }
  return result;
}

export function cloneRow(row: Row): Row {
  const values = new Array<SqlValue>(row.values.length);
  for (let i = 0; i < row.values.length; i++) values[i] = cloneSqlValue(row.values[i]!);
  return { rowid: row.rowid, values };
}

export function isValueArray(values: RowValues): values is readonly SqlValue[] {
  return Array.isArray(values);
}
