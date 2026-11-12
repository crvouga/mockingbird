import type {
  DeleteStmt,
  Expr,
  InsertStmt,
  OnConflictClause,
  SelectStmt,
  UpdateSet,
  UpdateStmt,
} from "../ast/nodes.ts";
import {
  checkChecks,
  checkForeignKeys,
  checkNotNull,
  checkUnique,
  deferForeignKey,
  findConflict,
  foreignKeyDeferred,
  referencingConstraints,
  uniqueSpecsFor,
} from "../constraints/enforce.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { applyDomainChecks } from "../expressions/eval.ts";
import { sequenceNextval } from "../functions/misc-fns.ts";
import { indexInsertRow, indexUpdateRow, prepareDmlIndexStores, rebuildTableIndexes } from "../indexes/maintain.ts";
import { tryPointRowIndices } from "../planner/access.ts";
import type { ColumnMeta, TableData } from "../storage/database-state.ts";
import { replicaRole } from "../storage/guc.ts";
import { castTo } from "../types/cast.ts";
import { datumKey } from "../types/compare.ts";
import {
  type Datum,
  isCompositeType,
  type PgRecord,
  type TypedValue,
  tv,
  typeDisplayName,
  UNKNOWN,
} from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, type Relation, RowScope } from "./relation.ts";
import { evalReturning, type ReturningRow } from "./returning.ts";
import { applyWith, buildFrom, evalPredicate, evalScalar, executeSelectStmt } from "./select.ts";
import { mentionsSystemColumn, systemColumns, withSystemValues } from "./system-columns.ts";
import {
  checkPartitionConstraint,
  isPartitioned,
  leafPartitions,
  qualified,
  routeRow,
  satisfiesPartitionConstraint,
} from "./partition.ts";
import { checkReturnedRowVisible, checkRowSecurity, rowSecurityFilter } from "./row-security.ts";
import { fireRowTriggers, fireStatementTriggers } from "./triggers.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Roll back trigger/constraint side effects when a statement fails under autocommit. */
export function withStatementRollback<T>(env: ExecEnv, fn: () => T): T {
  if (env.ctx.state.inTransaction) return fn();
  const state = env.ctx.state;
  // O(1) in the catalog's size: the snapshot forks the catalog maps instead of copying them (#710)
  const prngSnap = state.prng.getState();
  const hold = state.holdForRollback();
  try {
    return fn();
  } catch (e) {
    state.restoreFrom(hold.state, true);
    state.prng.setState(prngSnap);
    throw e;
  } finally {
    state.releaseHold(hold.epoch);
  }
}

export function requireTargetTable(env: ExecEnv, parts: string[], verb: string): TableData {
  const state = env.ctx.state;
  const table = state.findTable(parts);
  if (table) {
    prepareDmlIndexStores(env, table);
    return state.ensureWritableTableForDml(table);
  }
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
export function coerceToColumn(env: ExecEnv, v: TypedValue, col: ColumnMeta): Datum {
  const ctx = env.ctx;
  const out = castTo(ctx, v, col.type.id, { assignment: true, mod: col.type.mod });
  if (col.domain) {
    applyDomainChecks(ctx, col.domain, out);
  }
  return out.v;
}

export function columnDefault(env: ExecEnv, _table: TableData, col: ColumnMeta): Datum {
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

export function computeGeneratedColumns(env: ExecEnv, table: TableData, row: Datum[]): void {
  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i]!;
    if (!col.generated) continue;
    const scope = tableRowScope(env, table, table.name, row);
    const v = evalScalar(env, scope, col.generated);
    row[i] = coerceToColumn(env, v, col);
  }
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
  const rows = table.writeRows();
  const existing = rows[existingIdx]!;
  // scope: target table columns visible under its alias/name, plus excluded.*
  const cols = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label })),
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: "excluded" })),
  ];
  const scope = new RowScope(cols, [...existing, ...newRow], env.outer, new Set([label, "excluded"]));
  // row security: the conflicting row must be one the role may update (an error, not a skip)
  const updatable = rowSecurityFilter(env, table, "update");
  if (updatable && !updatable(existing)) {
    throw pgError(
      "misuse",
      `new row violates row-level security policy (USING expression) for table "${table.name}"`,
      "42501",
    );
  }
  if (where && !evalPredicate(env, scope, where)) return false;

  const updated = existing.slice();
  applyUpdateSets(env, table, sets, scope, updated);
  computeGeneratedColumns(env, table, updated);
  checkRowSecurity(env, table, "update", updated);
  table.rowXmins.set(updated, env.ctx.rowVersionXid());
  table.replaceRow(existingIdx, updated);
  indexUpdateRow(env, table, existingIdx, existing, updated);
  checkNotNull(env, table, updated);
  checkChecks(env, table, updated);
  checkUnique(env, table, updated, existingIdx);
  checkForeignKeys(env, table, updated, true);
  handleReferencedUpdate(env, table, [existing], [updated]);
  return true;
}

export function executeInsert(env0: ExecEnv, stmt: InsertStmt): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "insert into");
  const rows = table.writeRows();
  const partitioned = isPartitioned(env.ctx.state, table);
  const label = stmt.alias ?? table.name;
  const colIdxs = insertTargetColumns(env, table, stmt);
  const sourceRows = insertSourceRows(env, stmt, colIdxs);

  const insertedRows: ReturningRow[] = [];
  let insertedCount = 0;
  // Rows the statement inserted, and the (old, new) pairs ON CONFLICT DO UPDATE rewrote: the transition tables.
  const addedRows: Datum[][] = [];
  const conflictOldRows: Datum[][] = [];
  const conflictNewRows: Datum[][] = [];
  const updatesOnConflict = stmt.onConflict !== null && stmt.onConflict.action !== "nothing";

  return withStatementRollback(env, () => {
    fireStatementTriggers(env, table, "before", "insert");
    if (updatesOnConflict) fireStatementTriggers(env, table, "before", "update");
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

      // a partitioned table routes the row to the partition that takes it
      const tgt = partitioned ? requireTargetTable(env, qualified(routeRow(env, table, row)), "insert into") : table;
      const tgtRows = tgt === table ? rows : tgt.writeRows();

      // BEFORE triggers
      const fired = fireRowTriggers(env, tgt, "before", "insert", null, row);
      if (fired.row === null) continue;
      const newRow = fired.row;

      computeGeneratedColumns(env, tgt, newRow);
      checkPartitionConstraint(env, tgt, newRow);
      checkRowSecurity(env, table, "insert", newRow);
      if (stmt.returning) checkReturnedRowVisible(env, table, newRow);

      // ON CONFLICT arbiter check
      if (stmt.onConflict) {
        const arbiters = resolveArbiters(env, tgt, stmt.onConflict);
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
            const scope = tableRowScope(env, tgt, label, newRow);
            conflictWhereOk = evalPredicate(env, scope, stmt.onConflict.target.where);
          }
          const idx = findConflict(env, tgt, a.spec, newRow);
          if (idx !== null) {
            conflictIdx = idx;
            break;
          }
        }
        if (conflictIdx !== null && conflictWhereOk) {
          if (stmt.onConflict.action === "nothing") continue;
          const replaced = tgtRows[conflictIdx]!;
          const did = applyOnConflictUpdate(
            env,
            tgt,
            label,
            conflictIdx,
            newRow,
            stmt.onConflict.action.sets,
            stmt.onConflict.action.where,
          );
          if (did) {
            insertedCount++;
            insertedRows.push({
              old: replaced,
              new: tgtRows[conflictIdx]!,
              position: conflictIdx,
              xmax: env.ctx.rowVersionXid(),
              table: tgt,
            });
            conflictOldRows.push(replaced);
            conflictNewRows.push(tgtRows[conflictIdx]!);
            fireRowTriggers(env, tgt, "after", "update", null, tgtRows[conflictIdx]!);
          }
          continue;
        }
      }

      checkNotNull(env, tgt, newRow);
      checkChecks(env, tgt, newRow);
      checkUnique(env, tgt, newRow, tgtRows.length);
      checkForeignKeys(env, tgt, newRow, true);
      tgt.rowXmins.set(newRow, env.ctx.rowVersionXid());
      tgtRows.push(newRow);
      tgt.recordDurableRow(newRow);
      indexInsertRow(env, tgt, tgtRows.length - 1, newRow);
      insertedCount++;
      insertedRows.push({ old: null, new: newRow, position: tgtRows.length - 1, xmax: 0, table: tgt });
      addedRows.push(newRow);
      fireRowTriggers(env, tgt, "after", "insert", null, newRow);
    }

    fireStatementTriggers(env, table, "after", "insert", { oldRows: [], newRows: addedRows });
    if (updatesOnConflict) {
      fireStatementTriggers(env, table, "after", "update", { oldRows: conflictOldRows, newRows: conflictNewRows });
    }
    env.ctx.state.changes = insertedCount;
    if (stmt.returning) {
      const res = evalReturning(env, table, label, stmt.returning, stmt.returningAliases, insertedRows, "INSERT");
      return { ...res, rowCount: insertedCount };
    }
    return commandResult("INSERT", insertedCount);
  });
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

export function applyUpdateSets(
  env: ExecEnv,
  table: TableData,
  sets: UpdateSet[],
  scope: RowScope,
  row: Datum[],
): void {
  for (const set of sets) {
    const target = set.columns[0];
    if (
      set.columns.length === 1 &&
      target &&
      target.subscripts === null &&
      target.fields.length > 0 &&
      "type" in set.value &&
      set.value.type !== "default_expr"
    ) {
      // SET composite_column.field = value
      const i = table.columnIndex(target.name);
      if (i === -1) {
        throw pgError(
          "undefined_column",
          `column "${target.name}" of relation "${table.name}" does not exist`,
          "42703",
        );
      }
      const v = evalScalar(env, scope, set.value);
      row[i] = assignCompositeField(env, table.columns[i]!, row[i] ?? null, target.fields, v);
      continue;
    }
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
        {
          ctx: env.ctx,
          params: env.params,
          ctes: env.ctes,
          outer: scope,
          allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
        },
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

/** The value of a composite column with `fields` (a path of attribute names) set to `value`. */
function assignCompositeField(
  env: ExecEnv,
  col: ColumnMeta,
  current: Datum,
  fields: string[],
  value: TypedValue,
): Datum {
  const assign = (type: string, base: Datum, path: string[]): Datum => {
    const attrs = isCompositeType(type) ? env.ctx.compositeAttributes(type) : null;
    if (!attrs) {
      throw pgError(
        "datatype_mismatch",
        `cannot assign to field "${path[0]}" of column "${col.name}" because its type ${typeDisplayName(type)} is not a composite type`,
        "42804",
      );
    }
    const index = attrs.names.indexOf(path[0]!);
    if (index === -1) {
      throw pgError(
        "undefined_column",
        `cannot assign to field "${path[0]}" of column "${col.name}" because there is no such column in data type ${typeDisplayName(type)}`,
        "42703",
      );
    }
    const old = base === null ? attrs.types.map(() => null) : (base as PgRecord).values;
    const fieldType = attrs.types[index]!;
    const next =
      path.length > 1
        ? assign(fieldType, old[index] ?? null, path.slice(1))
        : castTo(env.ctx, value, fieldType, { assignment: true }).v;
    const values = old.slice();
    values[index] = next;
    return { kind: "pgrecord", types: attrs.types.slice(), values, names: attrs.names.slice() };
  };
  return assign(col.type.id, current, fields);
}

export function executeUpdate(env0: ExecEnv, stmt: UpdateStmt): ExecResult {
  if (stmt.whereCurrentOf) throw unsupported("WHERE CURRENT OF");
  // A row that fails a constraint, or a referenced key it strands, undoes the rows updated before it.
  return withStatementRollback(env0, () => {
    const parent = env0.ctx.state.findTable(stmt.table);
    if (parent && isPartitioned(env0.ctx.state, parent)) {
      return throughPartitions(env0, parent, stmt, "update", (env, leaf) => updateRows(env, leaf, parent));
    }
    return updateRows(env0, stmt);
  });
}

/**
 * UPDATE / DELETE through a partitioned table: the statement runs on each leaf partition (under the
 * parent's name), with the parent's statement triggers around it once.
 */
function throughPartitions<S extends UpdateStmt | DeleteStmt>(
  env0: ExecEnv,
  parent: TableData,
  stmt: S,
  event: "update" | "delete",
  run: (env: ExecEnv, stmt: S) => ExecResult,
): ExecResult {
  const env = applyWith(env0, stmt.with);
  fireStatementTriggers(env, parent, "before", event);
  const results: ExecResult[] = [];
  for (const leaf of leafPartitions(env.ctx.state, parent)) {
    results.push(run(env, { ...stmt, with: null, table: qualified(leaf), alias: stmt.alias ?? parent.name }));
  }
  fireStatementTriggers(env, parent, "after", event);
  const count = results.reduce((n, r) => n + r.rowCount, 0);
  env.ctx.state.changes = count;
  const command = event === "update" ? "UPDATE" : "DELETE";
  if (!stmt.returning) return commandResult(command, count);
  return {
    // a partition with no RETURNING rows cannot type an expression column: take one that has rows
    columns: (results.find((r) => r.rows.length > 0) ?? results[0])?.columns ?? [],
    rows: results.flatMap((r) => r.rows),
    command,
    rowCount: count,
  };
}

/** Insert a row moved out of a partition by UPDATE into the partition of `root` that takes it. */
function insertRoutedRow(env: ExecEnv, root: TableData, row: Datum[]): { table: TableData; position: number } {
  const target = requireTargetTable(env, qualified(routeRow(env, root, row)), "insert into");
  const fired = fireRowTriggers(env, target, "before", "insert", null, row);
  const newRow = fired.row ?? row;
  checkNotNull(env, target, newRow);
  checkChecks(env, target, newRow);
  const rows = target.writeRows();
  checkUnique(env, target, newRow, rows.length);
  checkForeignKeys(env, target, newRow, true);
  target.rowXmins.set(newRow, env.ctx.rowVersionXid());
  rows.push(newRow);
  target.recordDurableRow(newRow);
  indexInsertRow(env, target, rows.length - 1, newRow);
  fireRowTriggers(env, target, "after", "insert", null, newRow);
  return { table: target, position: rows.length - 1 };
}

function updateRows(env0: ExecEnv, stmt: UpdateStmt, root?: TableData): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "update");
  const label = stmt.alias ?? table.name;
  fireStatementTriggers(env, table, "before", "update");

  // FROM items build an auxiliary relation each target row can join against
  const fromSource = stmt.from.length > 0 ? buildFrom(env, stmt.from) : null;

  // xmin / xmax / ctid / tableoid join the scan only when the statement reads them
  const system = mentionsSystemColumn([stmt.where, stmt.sets]);
  const targetCols = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label })),
    ...(system ? systemColumns(label) : []),
  ];
  const updatedRows: Datum[][] = [];
  const returningRows: ReturningRow[] = [];
  const moved: Array<{ ri: number; oldRow: Datum[]; newRow: Datum[] }> = [];
  const replacedRows: Datum[][] = [];
  let updateCount = 0;

  // Volatile SET expressions, triggers and CHECK/domain/generated expressions may mutate
  // other tuples while scanning. Keep their established full-scan evaluation order.
  const point =
    !fromSource &&
    !system &&
    stmt.where &&
    table.triggers.length === 0 &&
    !table.columns.some((column) => column.generated || column.domain) &&
    !table.constraints.some((constraint) => constraint.kind === "check") &&
    stmt.sets.every(
      (set) =>
        set.columns.every((column) => column.subscripts === null && column.fields.length === 0) &&
        "type" in set.value &&
        isPureUpdateValue(set.value),
    ) &&
    referencingConstraints(env, table).length === 0
      ? tryPointRowIndices(env, table, label, stmt.where)
      : null;
  const rows = point ? null : table.writeRows();
  // row-level security: the rows UPDATE may change, and (when it reads them) may see
  const updatable = rowSecurityFilter(env, table, "update");
  const readable = stmt.where || stmt.returning || fromSource ? rowSecurityFilter(env, table, "select") : null;

  for (let candidate = 0; candidate < (point ? point.indices.length : rows!.length); candidate++) {
    const ri = point ? point.indices[candidate]! : candidate;
    const oldRow = point ? table.rowAt(ri) : rows![ri]!;
    if ((updatable && !updatable(oldRow)) || (readable && !readable(oldRow))) continue;
    let matchScope: RowScope | null = null;

    if (fromSource) {
      // find the first FROM row satisfying WHERE
      let found = false;
      for (const frow of fromSource.rel.rows) {
        const cols = [...targetCols, ...fromSource.rel.columns];
        const targetRow = system ? withSystemValues(table, oldRow, ri) : oldRow;
        const scope = new RowScope(cols, [...targetRow, ...frow], env.outer, new Set([label, ...fromSource.rangeVars]));
        if (!stmt.where || evalPredicate(env, scope, stmt.where)) {
          matchScope = scope;
          found = true;
          break;
        }
      }
      if (!found) continue;
    } else {
      const scope = new RowScope(
        targetCols,
        system ? withSystemValues(table, oldRow, ri) : oldRow,
        env.outer,
        new Set([label]),
      );
      if (stmt.where && !evalPredicate(env, scope, stmt.where)) continue;
      matchScope = scope;
    }

    const newRow = oldRow.slice();
    applyUpdateSets(env, table, stmt.sets, matchScope!, newRow);

    const fired = fireRowTriggers(env, table, "before", "update", oldRow, newRow);
    if (fired.row === null) continue;
    const finalRow = fired.row;

    computeGeneratedColumns(env, table, finalRow);
    checkRowSecurity(env, root ?? table, "update", finalRow);
    if (stmt.returning) checkReturnedRowVisible(env, root ?? table, finalRow);
    // through a partitioned table a row whose key now belongs elsewhere moves there
    if (root && !satisfiesPartitionConstraint(env, table, finalRow)) {
      moved.push({ ri, oldRow, newRow: finalRow });
      continue;
    }
    checkPartitionConstraint(env, table, finalRow);
    table.rowXmins.set(finalRow, env.ctx.rowVersionXid());
    table.replaceRow(ri, finalRow);
    try {
      checkNotNull(env, table, finalRow);
      checkChecks(env, table, finalRow);
      checkUnique(env, table, finalRow, ri);
      checkForeignKeys(env, table, finalRow, true);
    } catch (err) {
      table.replaceRow(ri, oldRow);
      throw err;
    }
    indexUpdateRow(env, table, ri, oldRow, finalRow);
    handleReferencedUpdate(env, table, [oldRow], [finalRow]);
    updateCount++;
    updatedRows.push(finalRow);
    if (stmt.returning) returningRows.push({ old: oldRow, new: finalRow, position: ri, xmax: 0 });
    replacedRows.push(oldRow);
    fireRowTriggers(env, table, "after", "update", oldRow, finalRow);
  }

  if (root && moved.length > 0) {
    // the moved rows leave this partition (as a DELETE) and enter their new one (as an INSERT)
    const current = table.writeRows();
    for (const { oldRow } of moved) fireRowTriggers(env, table, "before", "delete", oldRow, null);
    for (const { ri } of [...moved].sort((a, b) => b.ri - a.ri)) {
      table.recordDurableDelete(current[ri]!);
      current.splice(ri, 1);
    }
    rebuildTableIndexes(env, table);
    for (const { oldRow } of moved) fireRowTriggers(env, table, "after", "delete", oldRow, null);
    for (const { oldRow, newRow } of moved) {
      const placed = insertRoutedRow(env, root, newRow);
      updateCount++;
      if (stmt.returning) {
        returningRows.push({ old: oldRow, new: newRow, position: placed.position, xmax: 0, table: placed.table });
      }
    }
  }
  fireStatementTriggers(env, table, "after", "update", { oldRows: replacedRows, newRows: updatedRows });
  env.ctx.state.changes = updateCount;
  if (stmt.returning) {
    const res = evalReturning(env, table, label, stmt.returning, stmt.returningAliases, returningRows, "UPDATE");
    return { ...res, rowCount: updateCount };
  }
  return commandResult("UPDATE", updateCount);
}

function isPureUpdateValue(expr: Expr): boolean {
  switch (expr.type) {
    case "param":
    case "number_lit":
    case "string_lit":
    case "bool_lit":
    case "null_lit":
    case "colref":
      return true;
    case "binop":
      return isPureUpdateValue(expr.left) && isPureUpdateValue(expr.right);
    case "unop":
      return isPureUpdateValue(expr.operand);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export function executeDelete(env0: ExecEnv, stmt: DeleteStmt): ExecResult {
  const parent = env0.ctx.state.findTable(stmt.table);
  if (parent && isPartitioned(env0.ctx.state, parent)) {
    return withStatementRollback(env0, () =>
      throughPartitions(env0, parent, stmt, "delete", (env, leaf) => deleteRows(env, leaf)),
    );
  }
  return deleteRows(env0, stmt);
}

function deleteRows(env0: ExecEnv, stmt: DeleteStmt): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "delete from");
  const label = stmt.alias ?? table.name;
  fireStatementTriggers(env, table, "before", "delete");

  const rows = table.writeRows();
  const usingSource = stmt.using.length > 0 ? buildFrom(env, stmt.using) : null;
  const system = mentionsSystemColumn(stmt.where);
  const targetCols = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: label })),
    ...(system ? systemColumns(label) : []),
  ];

  const toDelete: number[] = [];
  const deletable = rowSecurityFilter(env, table, "delete");
  const readable = stmt.where || stmt.returning || usingSource ? rowSecurityFilter(env, table, "select") : null;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    if ((deletable && !deletable(row)) || (readable && !readable(row))) continue;
    let matched: boolean;
    if (usingSource) {
      matched = usingSource.rel.rows.some((urow) => {
        const cols = [...targetCols, ...usingSource.rel.columns];
        const targetRow = system ? withSystemValues(table, row, ri) : row;
        const scope = new RowScope(
          cols,
          [...targetRow, ...urow],
          env.outer,
          new Set([label, ...usingSource.rangeVars]),
        );
        return !stmt.where || evalPredicate(env, scope, stmt.where);
      });
    } else {
      const scope = new RowScope(
        targetCols,
        system ? withSystemValues(table, row, ri) : row,
        env.outer,
        new Set([label]),
      );
      matched = !stmt.where || evalPredicate(env, scope, stmt.where);
    }
    if (matched) toDelete.push(ri);
  }

  const deletedRows: Datum[][] = [];
  const deletedPositions: number[] = [];
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
    table.recordDurableDelete(row);
    rows.splice(ri, 1);
    deletedRows.unshift(row);
    deletedPositions.unshift(ri);
  }
  for (const row of deletedRows) {
    fireRowTriggers(env, table, "after", "delete", row, null);
  }
  if (deletedRows.length > 0) rebuildTableIndexes(env, table);

  fireStatementTriggers(env, table, "after", "delete", { oldRows: deletedRows, newRows: [] });
  env.ctx.state.changes = deletedRows.length;
  if (stmt.returning) {
    const xmax = env.ctx.rowVersionXid();
    const returningRows = deletedRows.map((row, k) => ({ old: row, new: null, position: deletedPositions[k]!, xmax }));
    const res = evalReturning(env, table, label, stmt.returning, stmt.returningAliases, returningRows, "DELETE");
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

/** A referenced row removed or re-keyed under its referencing rows: RESTRICT is 23001, NO ACTION 23503. */
function referencedViolation(table: TableData, child: TableData, constraint: string, action: string) {
  return action === "restrict"
    ? pgError(
        "restrict_violation",
        `update or delete on table "${table.name}" violates RESTRICT setting of foreign key constraint "${constraint}" on table "${child.name}"`,
        "23001",
      )
    : pgError(
        "constraint_foreign_key",
        `update or delete on table "${table.name}" violates foreign key constraint "${constraint}" on table "${child.name}"`,
        "23503",
      );
}

export function handleReferencedDelete(env: ExecEnv, table: TableData, row: Datum[], depth: number): void {
  if (replicaRole(env.ctx.state)) return;
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
    const child = env.ctx.state.ensureWritableTableForDml(ref.table);
    const childRows = child.writeRows();
    switch (action) {
      case "cascade": {
        for (let k = idxs.length - 1; k >= 0; k--) {
          const childRow = childRows[idxs[k]!]!;
          handleReferencedDelete(env, child, childRow, depth + 1);
          child.recordDurableDelete(childRow);
          childRows.splice(idxs[k]!, 1);
        }
        break;
      }
      case "set_null": {
        for (const i of idxs) {
          const newRow = childRows[i]!.slice();
          for (const c of con.onDeleteColumns ?? con.columns) {
            newRow[child.columnIndex(c)] = null;
          }
          child.rowXmins.set(newRow, env.ctx.rowVersionXid());
          child.replaceRow(i, newRow);
          checkNotNull(env, child, newRow);
          checkChecks(env, child, newRow);
        }
        break;
      }
      case "set_default": {
        for (const i of idxs) {
          const newRow = childRows[i]!.slice();
          for (const c of con.onDeleteColumns ?? con.columns) {
            const ci = child.columnIndex(c);
            newRow[ci] = columnDefault(env, child, child.columns[ci]!);
          }
          // the defaults still pointing at the row being deleted fail like a dangling key
          if (rowKeyFor(child, newRow, con.columns) === key)
            throw referencedViolation(table, child, con.name, "no_action");
          child.rowXmins.set(newRow, env.ctx.rowVersionXid());
          child.replaceRow(i, newRow);
          checkNotNull(env, child, newRow);
          checkChecks(env, child, newRow);
          checkForeignKeys(env, child, newRow, true);
        }
        break;
      }
      default:
        // NO ACTION waits for COMMIT when the constraint is deferred; RESTRICT never does.
        if (action === "no_action" && foreignKeyDeferred(env.ctx.state, ref.table.schema, con)) {
          deferForeignKey(env.ctx.state, ref.table, con, "referenced", table.name);
          break;
        }
        throw referencedViolation(table, ref.table, con.name, action);
    }
  }
}

export function handleReferencedUpdate(env: ExecEnv, table: TableData, oldRows: Datum[][], newRows: Datum[][]): void {
  if (replicaRole(env.ctx.state)) return;
  for (const ref of referencingConstraints(env, table)) {
    const con = ref.constraint;
    for (let r = 0; r < oldRows.length; r++) {
      const oldKey = rowKeyFor(table, oldRows[r]!, con.refColumns);
      const newKey = rowKeyFor(table, newRows[r]!, con.refColumns);
      if (oldKey === null || oldKey === newKey) continue;
      const idxs = referencingRowIdxs(ref, oldKey);
      if (idxs.length === 0) continue;
      const action = con.onUpdate ?? "no_action";
      const child = env.ctx.state.ensureWritableTableForDml(ref.table);
      const childRows = child.writeRows();
      switch (action) {
        case "cascade": {
          for (const i of idxs) {
            const newRow = childRows[i]!.slice();
            for (let c = 0; c < con.columns.length; c++) {
              const localIdx = child.columnIndex(con.columns[c]!);
              const refIdx = table.columnIndex(con.refColumns[c]!);
              newRow[localIdx] = newRows[r]![refIdx] ?? null;
            }
            child.rowXmins.set(newRow, env.ctx.rowVersionXid());
            child.replaceRow(i, newRow);
            checkChecks(env, child, newRow);
          }
          break;
        }
        case "set_null": {
          for (const i of idxs) {
            const newRow = childRows[i]!.slice();
            for (const c of con.columns) newRow[child.columnIndex(c)] = null;
            child.rowXmins.set(newRow, env.ctx.rowVersionXid());
            child.replaceRow(i, newRow);
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
            child.rowXmins.set(newRow, env.ctx.rowVersionXid());
            child.replaceRow(i, newRow);
            checkForeignKeys(env, child, newRow, true);
          }
          break;
        }
        default:
          if (action === "no_action" && foreignKeyDeferred(env.ctx.state, ref.table.schema, con)) {
            deferForeignKey(env.ctx.state, ref.table, con, "referenced", table.name);
            break;
          }
          throw referencedViolation(table, ref.table, con.name, action);
      }
    }
  }
}

export type { Relation, SelectStmt };
