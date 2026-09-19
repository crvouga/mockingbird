import type {
  DeleteStmt,
  Expr,
  InsertStmt,
  OnConflictClause,
  SelectStmt,
  SelectTarget,
  UpdateSet,
  UpdateStmt,
} from "../ast/nodes.ts";
import {
  checkChecks,
  checkForeignKeys,
  checkNotNull,
  checkUnique,
  findConflict,
  referencingConstraints,
  uniqueSpecsFor,
} from "../constraints/enforce.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { indexInsertRow, indexUpdateRow, rebuildTableIndexes } from "../indexes/maintain.ts";
import { applyDomainChecks } from "../expressions/eval.ts";
import { sequenceNextval } from "../functions/misc-fns.ts";
import type { ColumnMeta, TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumKey } from "../types/compare.ts";
import { type Datum, type TypedValue, type TypeId, tv, UNKNOWN } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, inferColumnName, type Relation, RowScope } from "./relation.ts";
import { applyWith, buildFrom, evalPredicate, evalScalar, executeSelectStmt } from "./select.ts";
import { fireRowTriggers } from "./triggers.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Roll back trigger/constraint side effects when a DML statement fails under autocommit. */
function withStatementRollback<T>(env: ExecEnv, fn: () => T): T {
  if (env.ctx.state.inTransaction) return fn();
  const state = env.ctx.state;
  state.freezeShared();
  const snap = state.cloneShallow();
  const prngSnap = state.prng.getState();
  try {
    return fn();
  } catch (e) {
    state.restoreFrom(snap);
    state.prng.setState(prngSnap);
    throw e;
  } finally {
    state.thawShared();
  }
}

function requireTargetTable(env: ExecEnv, parts: string[], verb: string): TableData {
  const state = env.ctx.state;
  const table = state.findTable(parts);
  if (table) return state.ensureWritableTable(table);
  const view = state.findView(parts);
  if (view) {
    throw pgError("wrong_object_type", `cannot ${verb} view "${view.name}"`, "42809");
  }
  throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");
}

function tableRowScope(env: ExecEnv, table: TableData, label: string, row: Datum[]): RowScope {
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label }));
  return new RowScope(cols, row, env.outer, new Set([label]));
}

/** cast an expression result for assignment to a column */
function coerceToColumn(env: ExecEnv, v: TypedValue, col: ColumnMeta): Datum {
  const ctx = env.ctx;
  const out = castTo(ctx, v, col.type.id, { assignment: true, mod: col.type.mod });
  if (col.domain) {
    applyDomainChecks(ctx, col.domain, out);
  }
  return out.v;
}

function columnDefault(env: ExecEnv, _table: TableData, col: ColumnMeta): Datum {
  if (col.identity) {
    const seq = env.ctx.state.findSequence(col.identity.sequence.split("."));
    if (!seq) throw pgError("undefined_object", `sequence for identity column "${col.name}" not found`, "42704");
    const next = sequenceNextval(env.ctx, seq);
    return castTo(env.ctx, tv("int8", next), col.type.id, {}).v;
  }
  if (col.defaultExpr) {
    const v = evalScalar(env, null, col.defaultExpr);
    return coerceToColumn(env, v, col);
  }
  return null;
}

function computeGeneratedColumns(env: ExecEnv, table: TableData, row: Datum[]): void {
  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i]!;
    if (!col.generated) continue;
    const scope = tableRowScope(env, table, table.name, row);
    const v = evalScalar(env, scope, col.generated);
    row[i] = coerceToColumn(env, v, col);
  }
}

function evalReturning(
  env: ExecEnv,
  table: TableData,
  label: string,
  targets: SelectTarget[],
  rows: Datum[][],
  command: string,
): ExecResult {
  // expand stars against the table's columns
  interface Item {
    name: string;
    expr: Expr | null;
    colIdx: number;
  }
  const items: Item[] = [];
  for (const t of targets) {
    if (t.expr.type === "star") {
      for (let i = 0; i < table.columns.length; i++) {
        items.push({ name: table.columns[i]!.name, expr: null, colIdx: i });
      }
      continue;
    }
    items.push({ name: t.alias ?? inferColumnName(t.expr), expr: t.expr, colIdx: -1 });
  }
  const columns = items.map((it) => ({
    name: it.name,
    type: it.colIdx >= 0 ? table.columns[it.colIdx]!.type.id : (UNKNOWN as TypeId),
  }));
  const outRows: Datum[][] = [];
  for (const row of rows) {
    const scope = tableRowScope(env, table, label, row);
    const out: Datum[] = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k]!;
      if (it.colIdx >= 0) {
        out.push(row[it.colIdx] ?? null);
      } else {
        const v = evalScalar(env, scope, it.expr!);
        if (columns[k]!.type === UNKNOWN) columns[k]!.type = v.t;
        out.push(v.v);
      }
    }
    outRows.push(out);
  }
  for (const c of columns) {
    if (c.type === UNKNOWN) c.type = "text";
  }
  return { columns, rows: outRows, command, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

function insertTargetColumns(env: ExecEnv, table: TableData, stmt: InsertStmt): number[] {
  if (stmt.columns) {
    const seen = new Set<string>();
    return stmt.columns.map((name) => {
      const i = table.columnIndex(name);
      if (i === -1) {
        throw pgError("undefined_column", `column "${name}" of relation "${table.name}" does not exist`, "42703");
      }
      if (seen.has(name)) {
        throw pgError("duplicate_column", `column "${name}" specified more than once`, "42701");
      }
      seen.add(name);
      const col = table.columns[i]!;
      if (col.generated) {
        throw pgError("generated_always", `cannot insert a non-DEFAULT value into column "${name}"`, "428C9");
      }
      return i;
    });
  }
  void env;
  // all non-generated columns in table order
  const idxs: number[] = [];
  for (let i = 0; i < table.columns.length; i++) {
    if (!table.columns[i]!.generated) idxs.push(i);
  }
  return idxs;
}

/** DEFAULT keyword marker in a VALUES row */
const DEFAULT_MARKER = Symbol("default");
type SourceCell = TypedValue | typeof DEFAULT_MARKER;

/** source rows; handles bare VALUES lists so the DEFAULT keyword works */
function insertSourceRows(env: ExecEnv, stmt: InsertStmt, colIdxs: number[]): SourceCell[][] {
  if (stmt.source === "default_values") {
    return [[]];
  }
  const src = stmt.source;
  const isBareValues = src.body.type === "values" && !src.with && src.orderBy.length === 0 && !src.limit && !src.offset;
  if (isBareValues && src.body.type === "values") {
    const rows: SourceCell[][] = [];
    for (const exprRow of src.body.rows) {
      if (exprRow.length > colIdxs.length) {
        throw pgError("syntax", "INSERT has more expressions than target columns", "42601");
      }
      const vals: SourceCell[] = exprRow.map((e) => {
        if (e.type === "default_expr") return DEFAULT_MARKER;
        return evalScalar(env, env.outer, e);
      });
      rows.push(vals);
    }
    return rows;
  }
  const rel = executeSelectStmt(env, src);
  if (rel.columns.length > colIdxs.length) {
    throw pgError("syntax", "INSERT has more expressions than target columns", "42601");
  }
  return rel.rows.map((r) =>
    r.map((v, i) => {
      const t = rel.columns[i]!.type;
      return tv(t === UNKNOWN ? "text" : t, v);
    }),
  );
}

interface ArbiterMatch {
  spec: ReturnType<typeof uniqueSpecsFor>[number];
}

function resolveArbiters(env: ExecEnv, table: TableData, clause: OnConflictClause): ArbiterMatch[] {
  const specs = uniqueSpecsFor(env, table);
  if (!clause.target) {
    if (clause.action === "nothing") return specs.map((spec) => ({ spec }));
    throw pgError("syntax", "ON CONFLICT DO UPDATE requires inference specification or constraint name", "42601");
  }
  if ("constraint" in clause.target) {
    const name = clause.target.constraint;
    const spec = specs.find((s) => s.name === name);
    if (!spec) {
      throw pgError("undefined_object", `constraint "${name}" for table "${table.name}" does not exist`, "42704");
    }
    return [{ spec }];
  }
  const wanted = clause.target.columns.map((e) => {
    if (e.type === "colref" && e.parts.length === 1) return e.parts[0]!;
    throw unsupported("ON CONFLICT expression inference targets");
  });
  const sorted = [...wanted].sort();
  const matches = specs.filter((s) => {
    const names = [...s.columnNames].sort();
    return names.length === sorted.length && names.every((n, i) => n === sorted[i]);
  });
  if (matches.length === 0) {
    throw pgError(
      "invalid_column_reference",
      "there is no unique or exclusion constraint matching the ON CONFLICT specification",
      "42P10",
    );
  }
  return matches.map((spec) => ({ spec }));
}

function applyOnConflictUpdate(
  env: ExecEnv,
  table: TableData,
  label: string,
  existingIdx: number,
  newRow: Datum[],
  sets: UpdateSet[],
  where: Expr | null,
): boolean {
  const rows = table.mutableRows();
  const existing = rows[existingIdx]!;
  // scope: target table columns visible under its alias/name, plus excluded.*
  const cols = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label })),
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: "excluded" })),
  ];
  const scope = new RowScope(cols, [...existing, ...newRow], env.outer, new Set([label, "excluded"]));
  if (where && !evalPredicate(env, scope, where)) return false;

  const updated = existing.slice();
  applyUpdateSets(env, table, sets, scope, updated);
  computeGeneratedColumns(env, table, updated);
  rows[existingIdx] = updated;
  indexUpdateRow(env, table, existingIdx, existing, updated);
  checkNotNull(env, table, updated);
  checkChecks(env, table, updated);
  checkUnique(env, table, updated, existingIdx);
  checkForeignKeys(env, table, updated);
  handleReferencedUpdate(env, table, [existing], [updated]);
  return true;
}

export function executeInsert(env0: ExecEnv, stmt: InsertStmt): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "insert into");
  const rows = table.mutableRows();
  const label = stmt.alias ?? table.name;
  const colIdxs = insertTargetColumns(env, table, stmt);
  const sourceRows = insertSourceRows(env, stmt, colIdxs);

  const insertedRows: Datum[][] = [];
  let insertedCount = 0;

  return withStatementRollback(env, () => {
    for (const srcRow of sourceRows) {
      // assemble the full row
      const row: Datum[] = table.columns.map(() => null);
      const provided = new Set<number>();
      for (let k = 0; k < srcRow.length; k++) {
        const ci = colIdxs[k]!;
        const col = table.columns[ci]!;
        const cell = srcRow[k]!;
        if (cell === DEFAULT_MARKER) {
          row[ci] = columnDefault(env, table, col);
          provided.add(ci);
          continue;
        }
        if (col.identity?.always && stmt.overriding !== "system") {
          throw pgError("generated_always", `cannot insert a non-DEFAULT value into column "${col.name}"`, "428C9");
        }
        row[ci] = coerceToColumn(env, cell, col);
        provided.add(ci);
      }
      for (let i = 0; i < table.columns.length; i++) {
        if (provided.has(i)) continue;
        const col = table.columns[i]!;
        if (col.generated) continue; // computed below
        row[i] = columnDefault(env, table, col);
      }

      // BEFORE triggers
      const fired = fireRowTriggers(env, table, "before", "insert", null, row);
      if (fired.row === null) continue;
      const newRow = fired.row;

      computeGeneratedColumns(env, table, newRow);

      // ON CONFLICT arbiter check
      if (stmt.onConflict) {
        const arbiters = resolveArbiters(env, table, stmt.onConflict);
        let conflictIdx: number | null = null;
        let conflictWhereOk = true;
        for (const a of arbiters) {
          if (
            "columns" in (stmt.onConflict.target ?? {}) &&
            stmt.onConflict.target &&
            "columns" in stmt.onConflict.target &&
            stmt.onConflict.target.where
          ) {
            // conflict_target WHERE clause constrains the arbiter (partial indexes)
            const scope = tableRowScope(env, table, label, newRow);
            conflictWhereOk = evalPredicate(env, scope, stmt.onConflict.target.where);
          }
          const idx = findConflict(env, table, a.spec, newRow);
          if (idx !== null) {
            conflictIdx = idx;
            break;
          }
        }
        if (conflictIdx !== null && conflictWhereOk) {
          if (stmt.onConflict.action === "nothing") continue;
          const did = applyOnConflictUpdate(
            env,
            table,
            label,
            conflictIdx,
            newRow,
            stmt.onConflict.action.sets,
            stmt.onConflict.action.where,
          );
          if (did) {
            insertedCount++;
            insertedRows.push(rows[conflictIdx]!);
            fireRowTriggers(env, table, "after", "update", null, rows[conflictIdx]!);
          }
          continue;
        }
      }

      checkNotNull(env, table, newRow);
      checkChecks(env, table, newRow);
      checkUnique(env, table, newRow, rows.length);
      checkForeignKeys(env, table, newRow);
      rows.push(newRow);
      indexInsertRow(env, table, rows.length - 1, newRow);
      insertedCount++;
      insertedRows.push(newRow);
      fireRowTriggers(env, table, "after", "insert", null, newRow);
    }

    env.ctx.state.changes = insertedCount;
    if (stmt.returning) {
      const res = evalReturning(env, table, label, stmt.returning, insertedRows, "INSERT");
      return { ...res, rowCount: insertedCount };
    }
    return commandResult("INSERT", insertedCount);
  });
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

function applyUpdateSets(env: ExecEnv, table: TableData, sets: UpdateSet[], scope: RowScope, row: Datum[]): void {
  for (const set of sets) {
    if (set.columns.some((c) => c.subscripts !== null || c.fields.length > 0)) {
      throw unsupported("UPDATE with subscripted or field-qualified target columns");
    }
    const colIdxs = set.columns.map((c) => {
      const i = table.columnIndex(c.name);
      if (i === -1) {
        throw pgError("undefined_column", `column "${c.name}" of relation "${table.name}" does not exist`, "42703");
      }
      if (table.columns[i]!.generated) {
        throw pgError("generated_always", `column "${c.name}" can only be updated to DEFAULT`, "428C9");
      }
      return i;
    });

    if (typeof set.value === "object" && "kind" in set.value && set.value.kind === "row_subquery") {
      const rel = executeSelectStmt(
        { ctx: env.ctx, params: env.params, ctes: env.ctes, outer: scope },
        set.value.query,
      );
      if (rel.rows.length > 1) {
        throw pgError(
          "cardinality_violation",
          "more than one row returned by a subquery used as an expression",
          "21000",
        );
      }
      const srcRow = rel.rows[0] ?? null;
      for (let k = 0; k < colIdxs.length; k++) {
        const col = table.columns[colIdxs[k]!]!;
        const v = srcRow === null ? tv(col.type.id, null) : tv(rel.columns[k]?.type ?? "text", srcRow[k] ?? null);
        row[colIdxs[k]!] = coerceToColumn(env, v.t === UNKNOWN ? tv("text", v.v) : v, col);
      }
      continue;
    }
    if (typeof set.value === "object" && "kind" in set.value && set.value.kind === "row_values") {
      if (set.value.items.length !== colIdxs.length) {
        throw pgError("syntax", "number of columns does not match number of values", "42601");
      }
      for (let k = 0; k < colIdxs.length; k++) {
        const col = table.columns[colIdxs[k]!]!;
        const e = set.value.items[k]!;
        if (e.type === "default_expr") {
          row[colIdxs[k]!] = columnDefault(env, table, col);
        } else {
          const v = evalScalar(env, scope, e);
          row[colIdxs[k]!] = coerceToColumn(env, v, col);
        }
      }
      continue;
    }
    // single expression
    const e = set.value as Expr;
    const col = table.columns[colIdxs[0]!]!;
    if (e.type === "default_expr") {
      row[colIdxs[0]!] = columnDefault(env, table, col);
    } else {
      const v = evalScalar(env, scope, e);
      row[colIdxs[0]!] = coerceToColumn(env, v, col);
    }
  }
}

export function executeUpdate(env0: ExecEnv, stmt: UpdateStmt): ExecResult {
  if (stmt.whereCurrentOf) throw unsupported("WHERE CURRENT OF");
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "update");
  const label = stmt.alias ?? table.name;

  // FROM items build an auxiliary relation each target row can join against
  const fromSource = stmt.from.length > 0 ? buildFrom(env, stmt.from) : null;

  const rows = table.mutableRows();
  const targetCols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label }));
  const updatedRows: Datum[][] = [];
  let updateCount = 0;

  for (let ri = 0; ri < rows.length; ri++) {
    const oldRow = rows[ri]!;
    let matchScope: RowScope | null = null;

    if (fromSource) {
      // find the first FROM row satisfying WHERE
      let found = false;
      for (const frow of fromSource.rel.rows) {
        const cols = [...targetCols, ...fromSource.rel.columns];
        const scope = new RowScope(cols, [...oldRow, ...frow], env.outer, new Set([label, ...fromSource.rangeVars]));
        if (!stmt.where || evalPredicate(env, scope, stmt.where)) {
          matchScope = scope;
          found = true;
          break;
        }
      }
      if (!found) continue;
    } else {
      const scope = new RowScope(targetCols, oldRow, env.outer, new Set([label]));
      if (stmt.where && !evalPredicate(env, scope, stmt.where)) continue;
      matchScope = scope;
    }

    const newRow = oldRow.slice();
    applyUpdateSets(env, table, stmt.sets, matchScope!, newRow);

    const fired = fireRowTriggers(env, table, "before", "update", oldRow, newRow);
    if (fired.row === null) continue;
    const finalRow = fired.row;

    computeGeneratedColumns(env, table, finalRow);
    rows[ri] = finalRow;
    try {
      checkNotNull(env, table, finalRow);
      checkChecks(env, table, finalRow);
      checkUnique(env, table, finalRow, ri);
      checkForeignKeys(env, table, finalRow);
    } catch (err) {
      rows[ri] = oldRow;
      throw err;
    }
    indexUpdateRow(env, table, ri, oldRow, finalRow);
    handleReferencedUpdate(env, table, [oldRow], [finalRow]);
    updateCount++;
    updatedRows.push(finalRow);
    fireRowTriggers(env, table, "after", "update", oldRow, finalRow);
  }

  env.ctx.state.changes = updateCount;
  if (stmt.returning) {
    const res = evalReturning(env, table, label, stmt.returning, updatedRows, "UPDATE");
    return { ...res, rowCount: updateCount };
  }
  return commandResult("UPDATE", updateCount);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export function executeDelete(env0: ExecEnv, stmt: DeleteStmt): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "delete from");
  const label = stmt.alias ?? table.name;

  const rows = table.mutableRows();
  const usingSource = stmt.using.length > 0 ? buildFrom(env, stmt.using) : null;
  const targetCols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label }));

  const toDelete: number[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    let matched: boolean;
    if (usingSource) {
      matched = usingSource.rel.rows.some((urow) => {
        const cols = [...targetCols, ...usingSource.rel.columns];
        const scope = new RowScope(cols, [...row, ...urow], env.outer, new Set([label, ...usingSource.rangeVars]));
        return !stmt.where || evalPredicate(env, scope, stmt.where);
      });
    } else {
      const scope = new RowScope(targetCols, row, env.outer, new Set([label]));
      matched = !stmt.where || evalPredicate(env, scope, stmt.where);
    }
    if (matched) toDelete.push(ri);
  }

  const deletedRows: Datum[][] = [];
  // delete from the end to keep indexes stable
  const skipped = new Set<number>();
  for (const ri of toDelete) {
    const fired = fireRowTriggers(env, table, "before", "delete", rows[ri]!, null);
    if (fired.row === null) skipped.add(ri);
  }
  for (let k = toDelete.length - 1; k >= 0; k--) {
    const ri = toDelete[k]!;
    if (skipped.has(ri)) continue;
    const row = rows[ri]!;
    handleReferencedDelete(env, table, row, 0);
    rows.splice(ri, 1);
    deletedRows.unshift(row);
  }
  for (const row of deletedRows) {
    fireRowTriggers(env, table, "after", "delete", row, null);
  }
  if (deletedRows.length > 0) rebuildTableIndexes(env, table);

  env.ctx.state.changes = deletedRows.length;
  if (stmt.returning) {
    const res = evalReturning(env, table, label, stmt.returning, deletedRows, "DELETE");
    return { ...res, rowCount: deletedRows.length };
  }
  return commandResult("DELETE", deletedRows.length);
}

// ---------------------------------------------------------------------------
// referential actions
// ---------------------------------------------------------------------------

const MAX_FK_DEPTH = 100;

function rowKeyFor(table: TableData, row: Datum[], columns: string[]): string | null {
  const parts: string[] = [];
  for (const c of columns) {
    const i = table.columnIndex(c);
    const v = row[i] ?? null;
    if (v === null) return null;
    parts.push(datumKey(table.columns[i]!.type.id, v));
  }
  return parts.join("\u0001");
}

/** rows in `ref.table` whose FK points at `key` */
function referencingRowIdxs(ref: ReturnType<typeof referencingConstraints>[number], key: string): number[] {
  const { table: rt, constraint: con } = ref;
  const out: number[] = [];
  for (let i = 0; i < rt.rowCount(); i++) {
    const k = rowKeyFor(rt, rt.rowAt(i), con.columns);
    if (k === key) out.push(i);
  }
  return out;
}

export function handleReferencedDelete(env: ExecEnv, table: TableData, row: Datum[], depth: number): void {
  if (depth > MAX_FK_DEPTH) {
    throw pgError("program_limit_exceeded", "foreign key cascade depth exceeded", "54001");
  }
  for (const ref of referencingConstraints(env, table)) {
    const con = ref.constraint;
    const key = rowKeyFor(table, row, con.refColumns);
    if (key === null) continue;
    const idxs = referencingRowIdxs(ref, key);
    if (idxs.length === 0) continue;
    const action = con.onDelete ?? "no_action";
    const child = env.ctx.state.ensureWritableTable(ref.table);
    const childRows = child.mutableRows();
    switch (action) {
      case "cascade": {
        for (let k = idxs.length - 1; k >= 0; k--) {
          const childRow = childRows[idxs[k]!]!;
          handleReferencedDelete(env, child, childRow, depth + 1);
          childRows.splice(idxs[k]!, 1);
        }
        break;
      }
      case "set_null": {
        for (const i of idxs) {
          const newRow = childRows[i]!.slice();
          for (const c of con.columns) {
            newRow[child.columnIndex(c)] = null;
          }
          childRows[i] = newRow;
          checkNotNull(env, child, newRow);
          checkChecks(env, child, newRow);
        }
        break;
      }
      case "set_default": {
        for (const i of idxs) {
          const newRow = childRows[i]!.slice();
          for (const c of con.columns) {
            const ci = child.columnIndex(c);
            newRow[ci] = columnDefault(env, child, child.columns[ci]!);
          }
          childRows[i] = newRow;
          checkNotNull(env, child, newRow);
          checkChecks(env, child, newRow);
          checkForeignKeys(env, child, newRow);
        }
        break;
      }
      default:
        throw pgError(
          "constraint_foreign_key",
          `update or delete on table "${table.name}" violates foreign key constraint "${con.name}" on table "${ref.table.name}"`,
          "23503",
        );
    }
  }
}

export function handleReferencedUpdate(env: ExecEnv, table: TableData, oldRows: Datum[][], newRows: Datum[][]): void {
  for (const ref of referencingConstraints(env, table)) {
    const con = ref.constraint;
    for (let r = 0; r < oldRows.length; r++) {
      const oldKey = rowKeyFor(table, oldRows[r]!, con.refColumns);
      const newKey = rowKeyFor(table, newRows[r]!, con.refColumns);
      if (oldKey === null || oldKey === newKey) continue;
      const idxs = referencingRowIdxs(ref, oldKey);
      if (idxs.length === 0) continue;
      const action = con.onUpdate ?? "no_action";
      const child = env.ctx.state.ensureWritableTable(ref.table);
      const childRows = child.mutableRows();
      switch (action) {
        case "cascade": {
          for (const i of idxs) {
            const newRow = childRows[i]!.slice();
            for (let c = 0; c < con.columns.length; c++) {
              const localIdx = child.columnIndex(con.columns[c]!);
              const refIdx = table.columnIndex(con.refColumns[c]!);
              newRow[localIdx] = newRows[r]![refIdx] ?? null;
            }
            childRows[i] = newRow;
            checkChecks(env, child, newRow);
          }
          break;
        }
        case "set_null": {
          for (const i of idxs) {
            const newRow = childRows[i]!.slice();
            for (const c of con.columns) newRow[child.columnIndex(c)] = null;
            childRows[i] = newRow;
            checkNotNull(env, child, newRow);
          }
          break;
        }
        case "set_default": {
          for (const i of idxs) {
            const newRow = childRows[i]!.slice();
            for (const c of con.columns) {
              const ci = child.columnIndex(c);
              newRow[ci] = columnDefault(env, child, child.columns[ci]!);
            }
            childRows[i] = newRow;
            checkForeignKeys(env, child, newRow);
          }
          break;
        }
        default:
          throw pgError(
            "constraint_foreign_key",
            `update or delete on table "${table.name}" violates foreign key constraint "${con.name}" on table "${ref.table.name}"`,
            "23503",
          );
      }
    }
  }
}

export type { Relation, SelectStmt };
