import type { Expr } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { ColumnMeta, ConstraintMeta, DatabaseState } from "../storage/database-state.ts";

/**
 * PostgreSQL 18 `VIRTUAL` generated columns and `ON DELETE SET NULL / SET DEFAULT (cols)`.
 *
 * The engine keeps a virtual column's value in the row like a stored one (its expression is immutable
 * and reads only the row, so the value read back is the same); what differs is the catalog
 * (`attgenerated = 'v'`) and the definitions PostgreSQL refuses for virtual columns.
 */

function collectFunctionNames(node: unknown, out: string[][]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectFunctionNames(item, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o.type === "func" && Array.isArray(o.name)) out.push(o.name as string[]);
  for (const value of Object.values(o)) collectFunctionNames(value, out);
}

/** A virtual column's expression may not call a user-defined function (`0A000`). */
export function checkVirtualGenerationExpr(state: DatabaseState, expr: Expr): void {
  const names: string[][] = [];
  collectFunctionNames(expr, names);
  for (const name of names) {
    if (name.length === 2 && name[0] === "pg_catalog") continue;
    const userDefined = state.findFunctions(name).some((fn) => !state.systemFunctions.get(fn.name)?.includes(fn));
    if (userDefined) {
      throw pgError("feature_not_supported", "generation expression uses user-defined function", "0A000");
    }
  }
}

/** Indexes, primary keys and unique constraints on virtual columns are `0A000` in PostgreSQL 18. */
export function checkNoVirtualKey(
  columns: readonly ColumnMeta[],
  names: readonly (string | null)[],
  what: "index" | "primary_key" | "unique",
): void {
  for (const name of names) {
    if (name === null) continue;
    if (!columns.find((c) => c.name === name)?.virtual) continue;
    const label =
      what === "index"
        ? "indexes on virtual generated columns are not supported"
        : what === "primary_key"
          ? "primary keys on virtual generated columns are not supported"
          : "unique constraints on virtual generated columns are not supported";
    throw pgError("feature_not_supported", label, "0A000");
  }
}

/** Check every key constraint of a table being built against its virtual columns. */
export function checkVirtualKeyConstraints(
  columns: readonly ColumnMeta[],
  constraints: readonly ConstraintMeta[],
): void {
  for (const con of constraints) {
    if (con.kind === "primary_key") checkNoVirtualKey(columns, con.columns, "primary_key");
    else if (con.kind === "unique") checkNoVirtualKey(columns, con.columns, "unique");
  }
}

/** The `onDeleteColumns` of a foreign key, checked against its columns (`42P10`). */
export function foreignKeySetColumns(
  fkColumns: readonly string[],
  setColumns: readonly string[] | undefined,
): { onDeleteColumns?: string[] } {
  if (!setColumns) return {};
  for (const name of setColumns) {
    if (!fkColumns.includes(name)) {
      throw pgError(
        "invalid_column_reference",
        `column "${name}" referenced in ON DELETE SET action must be part of foreign key`,
        "42P10",
      );
    }
  }
  return { onDeleteColumns: [...setColumns] };
}
