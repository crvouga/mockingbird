import { pgError } from "../errors/error.ts";
import { indexStoreFor } from "../indexes/maintain.ts";
import type { ExecEnv } from "../executor/relation.ts";
import { RowScope } from "../executor/relation.ts";
import { makeEvalScope } from "../executor/select.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { IndexMeta, TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumKey } from "../types/compare.ts";
import { type Datum, datumText, tv } from "../types/value.ts";

function tableScope(table: TableData, row: Datum[]): RowScope {
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: table.name }));
  return new RowScope(cols, row, null, new Set([table.name]));
}

/** NOT NULL column constraints (23502). */
export function checkNotNull(env: ExecEnv, table: TableData, row: Datum[]): void {
  void env;
  for (let i = 0; i < table.columns.length; i++) {
    const c = table.columns[i]!;
    if (c.notNull && (row[i] ?? null) === null) {
      throw pgError(
        "not_null_violation",
        `null value in column "${c.name}" of relation "${table.name}" violates not-null constraint`,
        "23502",
      );
    }
  }
}

/** CHECK constraints (23514); NULL results pass. */
export function checkChecks(env: ExecEnv, table: TableData, row: Datum[]): void {
  for (const con of table.constraints) {
    if (con.kind !== "check") continue;
    const scope = makeEvalScope(env, tableScope(table, row));
    const v = evalExpr(env.ctx, scope, con.expr);
    if (v.v === null) continue;
    const b = castTo(env.ctx, v, "bool", {});
    if (b.v !== true) {
      throw pgError(
        "check_violation",
        `new row for relation "${table.name}" violates check constraint "${con.name}"`,
        "23514",
      );
    }
  }
}

interface UniqueSpec {
  name: string;
  /** column indexes for plain column keys; -1 with expr set for expression keys */
  keys: Array<{ colIdx: number; expr: import("../ast/nodes.ts").Expr | null }>;
  columnNames: string[];
  nullsNotDistinct: boolean;
  where: import("../ast/nodes.ts").Expr | null;
  isPrimary: boolean;
}

export function uniqueSpecsFor(env: ExecEnv, table: TableData): UniqueSpec[] {
  const specs: UniqueSpec[] = [];
  for (const con of table.constraints) {
    if (con.kind !== "primary_key" && con.kind !== "unique") continue;
    specs.push({
      name: con.name,
      keys: con.columns.map((c) => ({ colIdx: table.columnIndex(c), expr: null })),
      columnNames: con.columns,
      nullsNotDistinct: con.kind === "unique" ? con.nullsNotDistinct : false,
      where: null,
      isPrimary: con.kind === "primary_key",
    });
  }
  const schema = env.ctx.state.schemas.get(table.schema);
  if (schema) {
    for (const idx of schema.indexes.values()) {
      if (idx.table !== table.name || !idx.unique || idx.isConstraint) continue;
      specs.push({
        name: idx.name,
        keys: idx.columns.map((c) => ({
          colIdx: c.column !== null ? table.columnIndex(c.column) : -1,
          expr: c.expr,
        })),
        columnNames: idx.columns.map((c) => c.column ?? "expr"),
        nullsNotDistinct: idx.nullsNotDistinct,
        where: idx.where,
        isPrimary: false,
      });
    }
  }
  return specs;
}

export function uniqueKeyOf(env: ExecEnv, table: TableData, spec: UniqueSpec, row: Datum[]): string | null {
  if (spec.where) {
    const scope = makeEvalScope(env, tableScope(table, row));
    const v = evalExpr(env.ctx, scope, spec.where);
    if (v.v !== true) return null; // partial index: row not covered
  }
  const parts: string[] = [];
  let hasNull = false;
  for (const k of spec.keys) {
    let value: Datum;
    let type: import("../types/value.ts").TypeId;
    if (k.expr) {
      const scope = makeEvalScope(env, tableScope(table, row));
      const v = evalExpr(env.ctx, scope, k.expr);
      value = v.v;
      type = v.t === "unknown" ? "text" : v.t;
    } else {
      value = row[k.colIdx] ?? null;
      type = table.columns[k.colIdx]!.type.id;
    }
    if (value === null) {
      hasNull = true;
      parts.push("\u0000N");
    } else {
      parts.push(datumKey(type, value));
    }
  }
  if (hasNull && !spec.nullsNotDistinct) return null; // NULLs are distinct
  return parts.join("\u0001");
}

function _describeKey(env: ExecEnv, table: TableData, spec: UniqueSpec, row: Datum[]): string {
  const names = spec.columnNames.join(", ");
  const values = spec.keys
    .map((k, _i) => {
      if (k.expr) return "…";
      const v = row[k.colIdx] ?? null;
      if (v === null) return "null";
      return datumText(table.columns[k.colIdx]!.type.id, v, env.ctx);
    })
    .join(", ");
  return `Key (${names})=(${values})`;
}

/**
 * Unique / primary key enforcement (23505). `selfIdx` is the row's own index
 * in table.rows (already inserted / updated in place).
 */
export function checkUnique(env: ExecEnv, table: TableData, row: Datum[], selfIdx: number): void {
  for (const spec of uniqueSpecsFor(env, table)) {
    const key = uniqueKeyOf(env, table, spec, row);
    if (key === null) continue;
    indexStoreFor(env, table, spec).checkUnique(key, selfIdx);
  }
}

/** does `row` conflict with an existing row under `spec`? returns the row index */
export function findConflict(env: ExecEnv, table: TableData, spec: UniqueSpec, row: Datum[]): number | null {
  const key = uniqueKeyOf(env, table, spec, row);
  if (key === null) return null;
  const hits = indexStoreFor(env, table, spec).lookup(key);
  return hits.length > 0 ? hits[0]! : null;
}

export type { IndexMeta, UniqueSpec };

// ---------------------------------------------------------------------------
// foreign keys
// ---------------------------------------------------------------------------

/** referencing-side FK enforcement: every non-null key must exist in the referenced table (23503) */
export function checkForeignKeys(env: ExecEnv, table: TableData, row: Datum[]): void {
  const state = env.ctx.state;
  for (const con of table.constraints) {
    if (con.kind !== "foreign_key") continue;
    const values = con.columns.map((c) => row[table.columnIndex(c)] ?? null);
    const nulls = values.filter((v) => v === null).length;
    if (con.match === "simple" && nulls > 0) continue;
    if (con.match === "full") {
      if (nulls === values.length) continue;
      if (nulls > 0) {
        throw pgError(
          "constraint_foreign_key",
          `insert or update on table "${table.name}" violates foreign key constraint "${con.name}"`,
          "23503",
        );
      }
    }
    const refTable = state.schemas.get(con.refSchema)?.tables.get(con.refTable);
    if (!refTable) {
      throw pgError("undefined_table", `relation "${con.refSchema}.${con.refTable}" does not exist`, "42P01");
    }
    const refIdxs = con.refColumns.map((c) => refTable.columnIndex(c));
    const keyTypes = con.refColumns.map((_c, i) => refTable.columns[refIdxs[i]!]!.type.id);
    const wanted = values
      .map((v, i) => {
        const localT = table.columns[table.columnIndex(con.columns[i]!)]!.type.id;
        const cast = castTo(env.ctx, tv(localT, v), keyTypes[i]!, {});
        return cast.v === null ? "\u0000N" : datumKey(keyTypes[i]!, cast.v);
      })
      .join("\u0001");
    let found = false;
    for (let i = 0; i < refTable.rowCount(); i++) {
      const r = refTable.rowAt(i);
      const key = refIdxs
        .map((ri, j) => {
          const v = r[ri] ?? null;
          return v === null ? "\u0000N" : datumKey(keyTypes[j]!, v);
        })
        .join("\u0001");
      if (key === wanted) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw pgError(
        "constraint_foreign_key",
        `insert or update on table "${table.name}" violates foreign key constraint "${con.name}"`,
        "23503",
      );
    }
  }
}

export interface ReferencingConstraint {
  table: TableData;
  constraint: Extract<import("../storage/database-state.ts").ConstraintMeta, { kind: "foreign_key" }>;
}

/** all FK constraints in the database that reference `table` */
export function referencingConstraints(env: ExecEnv, table: TableData): ReferencingConstraint[] {
  const out: ReferencingConstraint[] = [];
  for (const schema of env.ctx.state.schemas.values()) {
    for (const t of schema.tables.values()) {
      for (const con of t.constraints) {
        if (con.kind === "foreign_key" && con.refSchema === table.schema && con.refTable === table.name) {
          out.push({ table: t, constraint: con });
        }
      }
    }
  }
  return out;
}

export function fullRowCheck(env: ExecEnv, table: TableData, row: Datum[], selfIdx: number): void {
  checkNotNull(env, table, row);
  checkChecks(env, table, row);
  checkUnique(env, table, row, selfIdx);
  checkForeignKeys(env, table, row);
}
