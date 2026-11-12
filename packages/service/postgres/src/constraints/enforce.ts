import type { Expr } from "../ast/nodes.ts";
import { replicaRole } from "../storage/guc.ts";
import { pgError } from "../errors/error.ts";
import type { ExecEnv } from "../executor/relation.ts";
import { RowScope } from "../executor/relation.ts";
import { makeEvalScope } from "../executor/select.ts";
import { evalExpr } from "../expressions/eval.ts";
import { indexStoreFor } from "../indexes/maintain.ts";
import { EngineCtx } from "../expressions/context.ts";
import type { ConstraintMeta, DatabaseState, IndexMeta, TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumKey } from "../types/compare.ts";
import { type Datum, datumText, type TypeId, tv } from "../types/value.ts";

function tableScope(table: TableData, row: Datum[]): RowScope {
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: table.name }));
  return new RowScope(cols, row, null, new Set([table.name]));
}

/**
 * The type an expression over `table` yields, found by evaluating it against an all-NULL row.
 * Binding errors (unknown column or function) surface as they would when PostgreSQL parses the expression.
 */
export function expressionTypeOf(env: ExecEnv, table: TableData, expr: Expr): TypeId {
  const scope = makeEvalScope(
    env,
    tableScope(
      table,
      table.columns.map(() => null),
    ),
  );
  const v = evalExpr(env.ctx, scope, expr);
  return v.t === "unknown" ? "text" : v.t;
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
    for (const idx of schema.indexesOn(table.name)) {
      if (!idx.unique || idx.isConstraint || idx.valid === false) continue;
      specs.push(uniqueSpecOfIndex(table, idx));
    }
  }
  return specs;
}

/** The uniqueness rule a unique index states, whether or not the index is currently valid. */
export function uniqueSpecOfIndex(table: TableData, idx: IndexMeta): UniqueSpec {
  return {
    name: idx.name,
    keys: idx.columns.map((c) => ({
      colIdx: c.column !== null ? table.columnIndex(c.column) : -1,
      expr: c.expr,
    })),
    columnNames: idx.columns.map((c) => c.column ?? "expr"),
    nullsNotDistinct: idx.nullsNotDistinct,
    where: idx.where,
    isPrimary: false,
  };
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

type ForeignKeyMeta = Extract<ConstraintMeta, { kind: "foreign_key" }>;

/** `SET CONSTRAINTS` modes are keyed by schema and constraint name (shared with constraint triggers). */
export const constraintModeKey = (schema: string, name: string): string => JSON.stringify([schema, name]);

/**
 * Is this foreign key's check deferred right now? Only a DEFERRABLE constraint inside a transaction
 * block is: `SET CONSTRAINTS` overrides the declared `INITIALLY DEFERRED | IMMEDIATE` until commit.
 */
export function foreignKeyDeferred(state: DatabaseState, schema: string, con: ForeignKeyMeta): boolean {
  if (!state.inTransaction || con.deferrable !== true) return false;
  return state.constraintModes.get(constraintModeKey(schema, con.name)) ?? con.initiallyDeferred === true;
}

/** Queue a deferred check of `con` (declared on `table`); one entry per constraint and side is enough. */
export function deferForeignKey(
  state: DatabaseState,
  table: TableData,
  con: ForeignKeyMeta,
  side: "referencing" | "referenced",
  referenced?: string,
): void {
  const pending = state.pendingForeignKeys;
  if (pending.some((p) => p.schema === table.schema && p.table === table.name && p.constraint === con.name)) return;
  pending.push({
    schema: table.schema,
    table: table.name,
    constraint: con.name,
    side,
    ...(referenced !== undefined ? { referenced } : {}),
  });
}

const NULL_KEY = "\u0000N";

function referencedTableOf(env: ExecEnv, con: ForeignKeyMeta): TableData {
  const refTable = env.ctx.state.schemas.get(con.refSchema)?.tables.get(con.refTable);
  if (!refTable) {
    throw pgError("undefined_table", `relation "${con.refSchema}.${con.refTable}" does not exist`, "42P01");
  }
  return refTable;
}

/**
 * The referenced key a referencing row asks for, in the referenced columns' types; `null` when the row
 * needs no referenced row (MATCH SIMPLE with a NULL, MATCH FULL all NULL) and `false` when MATCH FULL
 * is violated by a partly NULL key.
 */
function wantedKey(env: ExecEnv, table: TableData, con: ForeignKeyMeta, refTable: TableData, row: Datum[]) {
  const values = con.columns.map((c) => row[table.columnIndex(c)] ?? null);
  const nulls = values.filter((v) => v === null).length;
  if (con.match === "simple" && nulls > 0) return null;
  if (con.match === "full") {
    if (nulls === values.length) return null;
    if (nulls > 0) return false;
  }
  return values
    .map((v, i) => {
      const keyType = refTable.columns[refTable.columnIndex(con.refColumns[i]!)]!.type.id;
      const localT = table.columns[table.columnIndex(con.columns[i]!)]!.type.id;
      const cast = castTo(env.ctx, tv(localT, v), keyType, {});
      return cast.v === null ? NULL_KEY : datumKey(keyType, cast.v);
    })
    .join("\u0001");
}

function referencedKeyOf(con: ForeignKeyMeta, refTable: TableData, row: Datum[]): string {
  return con.refColumns
    .map((c) => {
      const i = refTable.columnIndex(c);
      const v = row[i] ?? null;
      return v === null ? NULL_KEY : datumKey(refTable.columns[i]!.type.id, v);
    })
    .join("\u0001");
}

const referencingViolation = (table: TableData, con: ForeignKeyMeta) =>
  pgError(
    "constraint_foreign_key",
    `insert or update on table "${table.name}" violates foreign key constraint "${con.name}"`,
    "23503",
  );

/**
 * Referencing-side FK enforcement: every non-null key must exist in the referenced table (23503).
 * With `defer`, a constraint that is deferred right now is queued for COMMIT instead (DML passes it;
 * DDL validation such as ADD CONSTRAINT never defers, as in PostgreSQL).
 */
export function checkForeignKeys(env: ExecEnv, table: TableData, row: Datum[], defer = false): void {
  // DML in session_replication_role = replica skips foreign keys (their triggers are origin triggers)
  if (defer && replicaRole(env.ctx.state)) return;
  for (const con of table.constraints) {
    if (con.kind !== "foreign_key") continue;
    if (defer && foreignKeyDeferred(env.ctx.state, table.schema, con)) {
      deferForeignKey(env.ctx.state, table, con, "referencing");
      continue;
    }
    const refTable = referencedTableOf(env, con);
    const wanted = wantedKey(env, table, con, refTable, row);
    if (wanted === null) continue;
    if (wanted === false) throw referencingViolation(table, con);
    let found = false;
    for (let i = 0; i < refTable.rowCount(); i++) {
      if (referencedKeyOf(con, refTable, refTable.rowAt(i)) === wanted) {
        found = true;
        break;
      }
    }
    if (!found) throw referencingViolation(table, con);
  }
}

/**
 * Run the queued foreign key checks whose constraint is no longer deferred (all of them with `all`,
 * at COMMIT). Each re-validates every row of the referencing table against one set of referenced keys,
 * which covers both sides: a child inserted before its parent and a parent deleted under its child.
 * A failed check stays queued; the caller rolls back.
 */
export function flushDeferredForeignKeys(state: DatabaseState, all = false): void {
  if (state.pendingForeignKeys.length === 0) return;
  const env: ExecEnv = { ctx: new EngineCtx(state), params: null, ctes: new Map(), outer: null };
  for (let i = 0; i < state.pendingForeignKeys.length; ) {
    const pending = state.pendingForeignKeys[i]!;
    const table = state.schemas.get(pending.schema)?.tables.get(pending.table);
    const con = table?.constraints.find(
      (c): c is ForeignKeyMeta => c.kind === "foreign_key" && c.name === pending.constraint,
    );
    if (!table || !con) {
      state.pendingForeignKeys.splice(i, 1);
      continue;
    }
    if (!all && foreignKeyDeferred(state, table.schema, con)) {
      i++;
      continue;
    }
    const refTable = referencedTableOf(env, con);
    const keys = new Set<string>();
    for (let r = 0; r < refTable.rowCount(); r++) keys.add(referencedKeyOf(con, refTable, refTable.rowAt(r)));
    for (let r = 0; r < table.rowCount(); r++) {
      const wanted = wantedKey(env, table, con, refTable, table.rowAt(r));
      if (wanted === null || (wanted !== false && keys.has(wanted))) continue;
      if (pending.side === "referenced" && wanted !== false) {
        throw pgError(
          "constraint_foreign_key",
          `update or delete on table "${pending.referenced ?? refTable.name}" violates foreign key constraint "${con.name}" on table "${table.name}"`,
          "23503",
        );
      }
      throw referencingViolation(table, con);
    }
    state.pendingForeignKeys.splice(i, 1);
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
  checkForeignKeys(env, table, row, true);
}
