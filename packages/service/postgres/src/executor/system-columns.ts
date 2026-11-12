import type { TableData } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import type { RelColumn } from "./relation.ts";

/**
 * The system columns a table scan exposes (https://www.postgresql.org/docs/18/ddl-system-columns.html):
 * `xmin`, `xmax`, `ctid` and `tableoid`. They are hidden from `*` but resolve by name.
 *
 * The engine has no heap, so two are modelled rather than read:
 * - `xmax` is 0 for every live row a scan sees. Only the RETURNING list of an `ON CONFLICT DO UPDATE`
 *   that took the update path (and of a DELETE) reports the writing transaction, which is what
 *   `RETURNING (xmax = 0) AS inserted` relies on. PostgreSQL also leaves a locker's xid behind
 *   after `FOR UPDATE` or an upsert; the engine does not.
 * - `ctid` is `(0,n)` with n the row's 1-based position in the table. It identifies a row within a
 *   statement (`DELETE ... WHERE ctid IN (...)`), but unlike PostgreSQL it does not move to a new
 *   slot on UPDATE, and positions shift after a DELETE.
 */
export const SYSTEM_COLUMN_NAMES = ["xmin", "xmax", "ctid", "tableoid"] as const;

export function systemColumns(label: string | null): RelColumn[] {
  return [
    { name: "xmin", type: "xid", table: label, hidden: true, system: true },
    { name: "xmax", type: "xid", table: label, hidden: true, system: true },
    { name: "ctid", type: "tid", table: label, hidden: true, system: true },
    { name: "tableoid", type: "oid", table: label, hidden: true, system: true },
  ];
}

/** `row` followed by its system column values, in `systemColumns` order. */
export function withSystemValues(table: TableData, row: Datum[], position: number, xmax = 0): Datum[] {
  return [...row, table.rowXmins.get(row) ?? 2, xmax, `(0,${position + 1})`, table.oid];
}

const NAMES: ReadonlySet<string> = new Set(SYSTEM_COLUMN_NAMES);

/** Whether an AST fragment references a system column, so a DML scan only pays for them when asked. */
export function mentionsSystemColumn(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(mentionsSystemColumn);
  const record = node as { type?: unknown; parts?: unknown };
  if (record.type === "colref" && Array.isArray(record.parts)) {
    const last = record.parts[record.parts.length - 1];
    if (typeof last === "string" && NAMES.has(last)) return true;
  }
  return Object.values(node).some(mentionsSystemColumn);
}
