import type { Expr, MergeStmt, MergeWhenClause } from "../ast/nodes.ts";
import { checkChecks, checkForeignKeys, checkNotNull, checkUnique } from "../constraints/enforce.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { indexInsertRow, indexUpdateRow, rebuildTableIndexes } from "../indexes/maintain.ts";
import type { TableData } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { isPartitioned } from "./partition.ts";
import { rowSecurityActive } from "./row-security.ts";
import {
  applyUpdateSets,
  coerceToColumn,
  columnDefault,
  computeGeneratedColumns,
  handleReferencedDelete,
  handleReferencedUpdate,
  requireTargetTable,
  withStatementRollback,
} from "./dml.ts";
import { commandResult, type ExecEnv, type ExecResult, type RelColumn, RowScope } from "./relation.ts";
import { evalReturning, type ReturningRow } from "./returning.ts";
import { applyWith, buildFrom, evalPredicate, evalScalar } from "./select.ts";
import { systemColumns, withSystemValues } from "./system-columns.ts";
import { fireRowTriggers, fireStatementTriggers, type TriggerEvent } from "./triggers.ts";

/**
 * MERGE (https://www.postgresql.org/docs/18/sql-merge.html). Every source row is joined to the
 * target rows the ON condition matches; each pair takes the first WHEN MATCHED clause whose
 * condition holds, a source row with no match the first WHEN NOT MATCHED [BY TARGET] clause, and a
 * target row no source row matched the first WHEN NOT MATCHED BY SOURCE clause. The actions are
 * decided against the target as it was when the statement started, then applied in source order
 * (deletions last), like the other DML executors: triggers, constraints, indexes and RETURNING.
 * A target row two source rows would both change raises 21000.
 */

type InsertClause = MergeWhenClause & { readonly action: Extract<MergeWhenClause["action"], { kind: "insert" }> };

type Planned =
  | { kind: "update"; index: number; old: Datum[]; row: Datum[]; source: Datum[] }
  | { kind: "delete"; index: number; old: Datum[]; source: Datum[] }
  | { kind: "insert"; clause: InsertClause; scope: RowScope; source: Datum[] };

export function executeMerge(env0: ExecEnv, stmt: MergeStmt): ExecResult {
  // a failing action undoes the ones applied before it (the target table is copied on first write)
  return withStatementRollback(env0, () => mergeRows(env0, stmt));
}

function mergeRows(env0: ExecEnv, stmt: MergeStmt): ExecResult {
  const env = applyWith(env0, stmt.with);
  const table = requireTargetTable(env, stmt.table, "execute MERGE on");
  if (rowSecurityActive(env.ctx.state, table)) throw unsupported("MERGE on a table with row-level security");
  if (isPartitioned(env.ctx.state, table)) throw unsupported("MERGE into a partitioned table");
  const label = stmt.alias ?? table.name;
  const source = buildFrom(env, [stmt.source]);
  const sourceCols: RelColumn[] = source.rel.columns;
  const targetCols: RelColumn[] = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, mod: c.type.mod, table: label })),
    ...systemColumns(label),
  ];
  const joinedCols = [...targetCols, ...sourceCols];
  const joinedVars = new Set([label, ...source.rangeVars]);
  const nullSource = sourceCols.map(() => null);

  const startRows = table.writeRows().slice();
  const matchedTargets = new Array<boolean>(startRows.length).fill(false);
  const affected = new Set<number>();
  const plan: Planned[] = [];
  const firstClause = (match: MergeWhenClause["match"], scope: RowScope): MergeWhenClause | null =>
    stmt.clauses.find((c) => c.match === match && (c.condition === null || evalPredicate(env, scope, c.condition))) ??
    null;

  const planTargetAction = (clause: MergeWhenClause | null, index: number, scope: RowScope, src: Datum[]): void => {
    if (clause === null || clause.action.kind === "nothing") return;
    if (affected.has(index)) {
      throw pgError("cardinality_violation", "MERGE command cannot affect row a second time", "21000");
    }
    affected.add(index);
    const old = startRows[index]!;
    if (clause.action.kind === "update") {
      const row = old.slice();
      applyUpdateSets(env, table, clause.action.sets, scope, row);
      plan.push({ kind: "update", index, old, row, source: src });
    } else if (clause.action.kind === "delete") {
      plan.push({ kind: "delete", index, old, source: src });
    }
  };

  // a NOT MATCHED [BY TARGET] clause sees only the source, a NOT MATCHED BY SOURCE clause only the target
  for (const clause of stmt.clauses) {
    if (clause.match === "not_matched_by_target") rejectReferences(clause, new Set([label]));
    if (clause.match === "not_matched_by_source") rejectReferences(clause, source.rangeVars);
  }

  for (const src of source.rel.rows) {
    let matched = false;
    for (let i = 0; i < startRows.length; i++) {
      const scope = new RowScope(
        joinedCols,
        [...withSystemValues(table, startRows[i]!, i), ...src],
        env.outer,
        joinedVars,
      );
      if (!evalPredicate(env, scope, stmt.on)) continue;
      matched = true;
      matchedTargets[i] = true;
      planTargetAction(firstClause("matched", scope), i, scope, src);
    }
    if (matched) continue;
    const scope = new RowScope(sourceCols, src, env.outer, new Set(source.rangeVars));
    const clause = firstClause("not_matched_by_target", scope);
    if (clause !== null && clause.action.kind === "insert") {
      plan.push({ kind: "insert", clause: clause as InsertClause, scope, source: src });
    }
  }
  if (stmt.clauses.some((c) => c.match === "not_matched_by_source")) {
    for (let i = 0; i < startRows.length; i++) {
      if (matchedTargets[i]) continue;
      const scope = new RowScope(targetCols, withSystemValues(table, startRows[i]!, i), env.outer, new Set([label]));
      planTargetAction(firstClause("not_matched_by_source", scope), i, scope, nullSource);
    }
  }

  const events = new Set<TriggerEvent>();
  for (const c of stmt.clauses) if (c.action.kind !== "nothing") events.add(c.action.kind);
  return applyPlan(env, stmt, table, label, plan, events, sourceCols, source.rangeVars);
}

function rejectReferences(node: unknown, hidden: ReadonlySet<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) rejectReferences(item, hidden);
    return;
  }
  const ref = node as { type?: unknown; parts?: unknown; table?: unknown };
  const qualifier =
    ref.type === "colref" && Array.isArray(ref.parts) && ref.parts.length >= 2
      ? ref.parts[ref.parts.length - 2]
      : ref.type === "star" && Array.isArray(ref.table)
        ? ref.table[ref.table.length - 1]
        : undefined;
  if (typeof qualifier === "string" && hidden.has(qualifier)) {
    throw pgError("undefined_table", `invalid reference to FROM-clause entry for table "${qualifier}"`, "42P01");
  }
  // a subquery's own FROM items may reuse the name
  if (ref.type === "select" || ref.type === "select_core") return;
  for (const value of Object.values(node)) rejectReferences(value, hidden);
}

function insertRow(env: ExecEnv, table: TableData, planned: Planned & { kind: "insert" }): Datum[] {
  const { columns, overriding, values } = planned.clause.action;
  const targets: number[] = [];
  if (columns !== null) {
    const seen = new Set<string>();
    for (const name of columns) {
      const i = table.columnIndex(name);
      if (i === -1) {
        throw pgError("undefined_column", `column "${name}" of relation "${table.name}" does not exist`, "42703");
      }
      if (seen.has(name)) throw pgError("duplicate_column", `column "${name}" specified more than once`, "42701");
      seen.add(name);
      targets.push(i);
    }
  } else {
    for (let i = 0; i < table.columns.length; i++) if (!table.columns[i]!.generated) targets.push(i);
  }
  const exprs: Expr[] = values ?? [];
  if (exprs.length > targets.length) {
    throw pgError("syntax", "INSERT has more expressions than target columns", "42601");
  }
  if (values !== null && exprs.length < targets.length && columns !== null) {
    throw pgError("syntax", "INSERT has more target columns than expressions", "42601");
  }
  const row: Datum[] = table.columns.map(() => null);
  const provided = new Set<number>();
  exprs.forEach((e, k) => {
    const ci = targets[k]!;
    const col = table.columns[ci]!;
    provided.add(ci);
    if (e.type === "default_expr") {
      row[ci] = col.generated ? null : columnDefault(env, table, col);
      return;
    }
    if (col.generated) {
      throw pgError("generated_always", `cannot insert a non-DEFAULT value into column "${col.name}"`, "428C9");
    }
    if (col.identity?.always && overriding !== "system") {
      throw pgError("generated_always", `cannot insert a non-DEFAULT value into column "${col.name}"`, "428C9");
    }
    row[ci] = coerceToColumn(env, evalScalar(env, planned.scope, e), col);
  });
  for (let i = 0; i < table.columns.length; i++) {
    const col = table.columns[i]!;
    if (!provided.has(i) && !col.generated) row[i] = columnDefault(env, table, col);
  }
  return row;
}

function applyPlan(
  env: ExecEnv,
  stmt: MergeStmt,
  table: TableData,
  label: string,
  plan: Planned[],
  events: Set<TriggerEvent>,
  sourceCols: RelColumn[],
  sourceVars: Set<string>,
): ExecResult {
  for (const event of ["insert", "update", "delete"] as const) {
    if (events.has(event)) fireStatementTriggers(env, table, "before", event);
  }
  const rows = table.writeRows();
  const returning: ReturningRow[] = [];
  const inserted: Datum[][] = [];
  const updatedOld: Datum[][] = [];
  const updatedNew: Datum[][] = [];
  const deletions: { index: number; row: Datum[]; entry: number }[] = [];
  let count = 0;

  for (const step of plan) {
    if (step.kind === "update") {
      const fired = fireRowTriggers(env, table, "before", "update", step.old, step.row);
      if (fired.row === null) continue;
      const row = fired.row;
      computeGeneratedColumns(env, table, row);
      table.rowXmins.set(row, env.ctx.rowVersionXid());
      table.replaceRow(step.index, row);
      checkNotNull(env, table, row);
      checkChecks(env, table, row);
      checkUnique(env, table, row, step.index);
      checkForeignKeys(env, table, row, true);
      indexUpdateRow(env, table, step.index, step.old, row);
      handleReferencedUpdate(env, table, [step.old], [row]);
      fireRowTriggers(env, table, "after", "update", step.old, row);
      updatedOld.push(step.old);
      updatedNew.push(row);
      returning.push({ old: step.old, new: row, position: step.index, xmax: 0, source: step.source, action: "UPDATE" });
      count++;
    } else if (step.kind === "insert") {
      const fired = fireRowTriggers(env, table, "before", "insert", null, insertRow(env, table, step));
      if (fired.row === null) continue;
      const row = fired.row;
      computeGeneratedColumns(env, table, row);
      checkNotNull(env, table, row);
      checkChecks(env, table, row);
      checkUnique(env, table, row, rows.length);
      checkForeignKeys(env, table, row, true);
      table.rowXmins.set(row, env.ctx.rowVersionXid());
      rows.push(row);
      table.recordDurableRow(row);
      indexInsertRow(env, table, rows.length - 1, row);
      fireRowTriggers(env, table, "after", "insert", null, row);
      inserted.push(row);
      returning.push({
        old: null,
        new: row,
        position: rows.length - 1,
        xmax: 0,
        source: step.source,
        action: "INSERT",
      });
      count++;
    } else {
      const fired = fireRowTriggers(env, table, "before", "delete", step.old, null);
      if (fired.row === null) continue;
      deletions.push({ index: step.index, row: step.old, entry: returning.length });
      returning.push({
        old: step.old,
        new: null,
        position: step.index,
        xmax: env.ctx.rowVersionXid(),
        source: step.source,
        action: "DELETE",
      });
      count++;
    }
  }
  // deletions last, from the highest position down, so the positions planned against stay valid
  for (const deletion of [...deletions].sort((a, b) => b.index - a.index)) {
    handleReferencedDelete(env, table, deletion.row, 0);
    table.recordDurableDelete(deletion.row);
    rows.splice(deletion.index, 1);
  }
  for (const deletion of deletions) fireRowTriggers(env, table, "after", "delete", deletion.row, null);
  if (deletions.length > 0) rebuildTableIndexes(env, table);

  // ExecASMergeTriggers: DELETE, UPDATE, then INSERT (the BEFORE ones run INSERT, UPDATE, DELETE)
  if (events.has("delete")) {
    fireStatementTriggers(env, table, "after", "delete", { oldRows: deletions.map((d) => d.row), newRows: [] });
  }
  if (events.has("update"))
    fireStatementTriggers(env, table, "after", "update", { oldRows: updatedOld, newRows: updatedNew });
  if (events.has("insert")) fireStatementTriggers(env, table, "after", "insert", { oldRows: [], newRows: inserted });
  env.ctx.state.changes = count;
  if (stmt.returning) {
    const res = evalReturning(env, table, label, stmt.returning, stmt.returningAliases, returning, "MERGE", {
      columns: sourceCols,
      rangeVars: sourceVars,
    });
    return { ...res, rowCount: count };
  }
  return commandResult("MERGE", count);
}
