import type {
  DeleteStmt,
  Expr,
  IndexedColumn,
  InsertStmt,
  ResultColumn,
  SetItem,
  UpdateStmt,
  WithClause,
} from "../ast/nodes.ts";
import { checkTableConstraints } from "../constraints/check.ts";
import { SqliteError } from "../errors/index.ts";
import { isExpectedFastPathMiss } from "../runtime/catch.ts";
import { exprEquals } from "../expressions/equals.ts";
import { evalExpr } from "../expressions/eval.ts";
import { indexKeyValues } from "../indexes/keys.ts";
import { tryIndexedTableRows } from "../planner/access.ts";
import { normalizeForCollation } from "../types/collation.ts";
import { splitQualifiedName, type ViewInfo } from "../storage/database-state.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { cloneRow, normalizeColumnName } from "../storage/row.ts";
import { makeColumnInfo, Table } from "../storage/table.ts";
import { applyStrictValue } from "../types/strict.ts";
import { applyAffinity, asSqlReal, compareSql, isTruthySql, type SqlValue } from "../types/value.ts";
import type { Fts5Row, Fts5VirtualTable } from "../vtable/fts5.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { emptyResult, type ResultSet, resultValues, valuesToResult } from "./result.ts";
import { executeSelect, executeWith, scanFrom } from "./select.ts";
import { fireDeleteTriggers, fireInsertTriggers, fireUpdateTriggers } from "./triggers.ts";
import { executeFtsDelete, executeFtsInsert, executeFtsUpdate } from "./vtable.ts";

function storeColumnValue(
  table: Table,
  column: { name: string; typeName: string | null; affinity: import("../types/value.ts").Affinity },
  value: SqlValue,
): SqlValue {
  const affined = applyAffinity(value, column.affinity);
  if (table.strict) return applyStrictValue(affined, column.typeName ?? "", table.name, column.name);
  return affined;
}

export function executeInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  try {
    return withDmlCtes(stmt.with, env, () => executeInsertCore(stmt, env));
  } catch (error) {
    handleConflictRollback(stmt.mode === "insert_or_rollback", error, env);
    throw error;
  }
}

function executeInsertCore(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualInsert(stmt, env);
  }
  const totalBefore = env.state.totalChanges;
  const view = writableView(stmt.table, "INSERT", env);
  if (view) return executeViewInsert(stmt, view, env, totalBefore);
  const fast = env.forceFullInsert ? null : tryFastInsert(stmt, env);
  if (fast) return fast;
  let table = env.state.getWritableTable(stmt.table);
  const columnNames = stmt.columns ?? table.columns.map((column) => column.name);
  const rowidIndexes = columnNames.map((name, index) => (isRowidName(name) ? index : -1)).filter((index) => index >= 0);
  if (rowidIndexes.length > 1) throw new SqliteError("duplicate column name: rowid", "other");
  if (table.withoutRowid && rowidIndexes.length > 0) {
    throw new SqliteError(`table ${table.name} has no column named rowid`, "other");
  }
  for (const name of columnNames) if (!isRowidName(name)) columnOf(table, name);
  const sourceRows = evaluateInsertSource(stmt, env);
  const returningRows: SqlValue[][] = [];
  let changes = 0;
  let last = env.state.lastInsertRowid;
  const suppliedIndexes = table.columns.map((column) =>
    columnNames.findIndex((name) => name.toLowerCase() === (column.nameLower ?? column.name.toLowerCase())),
  );
  const unconstrained =
    table.isUnconstrained() &&
    env.state.databaseForTable(table).triggers.size === 0 &&
    !stmt.upsert &&
    stmt.mode === "insert" &&
    stmt.returning.length === 0 &&
    rowidIndexes.length === 0;

  if (unconstrained) {
    for (const source of sourceRows) {
      if (source.length !== columnNames.length)
        throw new SqliteError(
          stmt.columns
            ? `${source.length} values for ${columnNames.length} columns`
            : `table ${table.name} has ${columnNames.length} columns but ${source.length} values were supplied`,
          "other",
        );
      const values = new Map<string, SqlValue>();
      for (let index = 0; index < table.columns.length; index++) {
        const column = table.columns[index]!;
        const suppliedIndex = suppliedIndexes[index]!;
        const value = suppliedIndex >= 0 ? (source[suppliedIndex] ?? null) : null;
        values.set(column.nameLower ?? column.name.toLowerCase(), storeColumnValue(table, column, value));
      }
      last = table.insert({ values }, { prepared: true, skipValidate: true });
      changes++;
    }
    env.state.recordChange(changes, last);
    return emptyResult(changes, last);
  }

  // ABORT undoes earlier rows from this statement without cloning the whole DB (critical for
  // bulk single-row inserts inside a user transaction — savepoints would be O(n²)).
  const abortMode = insertAbortResolution(stmt.mode) === "abort";
  const undoInserted: Rowid[] = [];
  const undoRemoved: Row[] = [];
  const undoStatement = (): void => {
    if (!abortMode) return;
    for (let i = undoInserted.length - 1; i >= 0; i--) {
      const row = table.rows.get(undoInserted[i]!);
      if (row) removeOne(table, row, env);
    }
    for (let i = undoRemoved.length - 1; i >= 0; i--) {
      const row = undoRemoved[i]!;
      table = env.state.ensureWritableTable(table);
      table.rows.set(row.rowid, row);
      if (table.indexes.length > 0) addIndexes(table, row, env);
    }
  };

  try {
    for (const source of sourceRows) {
      if (source.length !== columnNames.length)
        throw new SqliteError(
          stmt.columns
            ? `${source.length} values for ${columnNames.length} columns`
            : `table ${table.name} has ${columnNames.length} columns but ${source.length} values were supplied`,
          "other",
        );
      const values = new Map<string, SqlValue>();
      for (const column of table.columns) {
        if (column.generated) continue;
        const suppliedIndex = suppliedIndexes[table.columns.indexOf(column)] ?? -1;
        const value =
          suppliedIndex >= 0
            ? (source[suppliedIndex] ?? null)
            : column.defaultExpr
              ? evalExpr(column.defaultExpr, env.createEvalContext())
              : null;
        values.set(column.nameLower ?? column.name.toLowerCase(), storeColumnValue(table, column, value));
      }
      for (const column of table.columns) {
        if (!column.generated) continue;
        if (columnNames.some((name) => name.toLowerCase() === column.name.toLowerCase())) {
          throw new SqliteError(`cannot INSERT into generated column "${column.name}"`, "misuse");
        }
        if (column.generated.stored) {
          const genCtx = env.createEvalContext({
            cells: table.columns
              .filter((c) => !c.generated || c === column)
              .flatMap((c) => {
                if (c.generated && c !== column) return [];
                if (c === column) return [];
                return [
                  {
                    table: table.name,
                    name: c.name,
                    value: values.get(normalizeColumnName(c.name)) ?? null,
                    affinity: c.affinity,
                    collate: c.collate,
                  },
                ];
              }),
          });
          const computed = evalExpr(column.generated.expr, genCtx);
          values.set(normalizeColumnName(column.name), storeColumnValue(table, column, computed));
        } else {
          values.set(normalizeColumnName(column.name), null);
        }
      }

      if (fireInsertTriggers("BEFORE", table, values, null, env) === "ignore") continue;

      const conflicts = conflictingRows(table, values, env);
      if (conflicts.length > 0) {
        if (stmt.upsert) {
          const targetConflicts = conflictsForUpsert(table, values, env, stmt.upsert);
          if (targetConflicts.length === 0) {
            throw new SqliteError(
              `UNIQUE constraint failed: ${table.name}`,
              "constraint_unique",
              "SQLITE_CONSTRAINT_UNIQUE",
            );
          }
          if (stmt.upsert.action === "nothing") continue;
          const row = targetConflicts[0]!;
          const scope = scopeFor(table, row, stmt.table, env);
          const excluded: ScopeRow = {
            cells: table.columns.map((column) => ({
              table: "excluded",
              name: column.name,
              value: values.get(normalizeColumnName(column.name)) ?? null,
            })),
          };
          const merged = { cells: [...scope.cells, ...excluded.cells], rowid: row.rowid, sourceTable: table.name };
          const ctx = env.createEvalContext(merged);
          if (stmt.upsert.action.where && isTruthySql(evalExpr(stmt.upsert.action.where, ctx)) !== true) continue;
          const updates = evaluateSet(stmt.upsert.action.set, table, ctx);
          const updated = updateOne(table, row, updates, env);
          changes += 1 + updated.cascaded;
          if (stmt.returning.length)
            returningRows.push(projectReturning(stmt.returning, scopeFor(table, updated.row, stmt.table, env), env));
          continue;
        }
        const mode = stmt.mode;
        if (mode === "insert_or_ignore") continue;
        if (mode === "replace" || mode === "insert_or_replace") {
          for (const row of conflicts) {
            if (abortMode) undoRemoved.push(cloneRow(row));
            removeOne(table, row, env);
          }
        } else {
          throw new SqliteError(
            `UNIQUE constraint failed: ${table.name}`,
            "constraint_unique",
            "SQLITE_CONSTRAINT_UNIQUE",
          );
        }
      }

      let insertedRowid: Rowid | undefined;
      try {
        const suppliedRowid = rowidIndexes.length ? asExplicitRowid(source[rowidIndexes[0]!] ?? null) : undefined;
        const rowid = table.insert({ values, rowid: suppliedRowid }, { prepared: true });
        insertedRowid = rowid;
        const row = table.rows.get(rowid)!;
        validateRow(table, row, env);
        if (table.indexes.length > 0) addIndexes(table, row, env);
        if (env.state.foreignKeysEnabled) checkForeignKeys(table, row, env);
        if (!table.withoutRowid) {
          last = rowid;
          env.state.lastInsertRowid = rowid;
        }
        fireInsertTriggers("AFTER", table, table.namedValues(row), null, env);
        changes++;
        if (abortMode) undoInserted.push(rowid);
        if (stmt.returning.length)
          returningRows.push(projectReturning(stmt.returning, scopeFor(table, row, stmt.table, env), env));
      } catch (error) {
        if (insertedRowid !== undefined) {
          const inserted = table.rows.get(insertedRowid);
          if (inserted) removeOne(table, inserted, env);
        }
        if (
          stmt.mode === "insert_or_ignore" &&
          error instanceof SqliteError &&
          error.category.startsWith("constraint") &&
          error.category !== "constraint_foreign"
        )
          continue;
        throw error;
      }
    }
  } catch (error) {
    undoStatement();
    throw error;
  }
  const reportedChanges = finalizeDmlChanges(totalBefore, changes, env, last);
  if (stmt.returning.length === 0) return emptyResult(reportedChanges, last);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, reportedChanges, last);
}

function evaluateInsertSource(stmt: InsertStmt, env: ExecutionEnv): SqlValue[][] {
  if (stmt.select) return resultValues(executeSelect(stmt.select, env));
  if (!stmt.values) return [[]];
  const ctx = env.createEvalContext();
  return stmt.values.map((items) =>
    items.map((expr) => {
      if (expr.type === "parameter") return env.getBoundParameter(expr.name);
      return evalExpr(expr, ctx);
    }),
  );
}

interface FastInsertSlot {
  key: string;
  affinity: import("../types/value.ts").Affinity;
  read: (env: ExecutionEnv) => SqlValue;
}

interface FastInsertPlan {
  tableName: string;
  slots: FastInsertSlot[];
}

const fastInsertPlans = new WeakMap<InsertStmt, FastInsertPlan>();

function tryFastInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet | null {
  if (stmt.with || stmt.select || stmt.upsert || stmt.returning.length > 0 || stmt.mode !== "insert") return null;
  if (stmt.values?.length !== 1) return null;
  let plan = fastInsertPlans.get(stmt);
  if (!plan) {
    const built = buildFastInsertPlan(stmt, env);
    if (!built) return null;
    plan = built;
    fastInsertPlans.set(stmt, plan);
  }
  let table: Table;
  try {
    table = env.state.getWritableTable(plan.tableName);
  } catch (error) {
    if (!isExpectedFastPathMiss(error)) throw error;
    return null;
  }
  if (env.state.databaseForTable(table).triggers.size > 0) return null;
  if (!table.isUnconstrained()) return null;
  const values = new Map<string, SqlValue>();
  for (const slot of plan.slots) values.set(slot.key, applyAffinity(slot.read(env), slot.affinity));
  const last = table.insert({ values }, { prepared: true, skipValidate: true });
  env.state.recordChange(1, last);
  return emptyResult(1, last);
}

function buildFastInsertPlan(stmt: InsertStmt, env: ExecutionEnv): FastInsertPlan | null {
  let table: Table;
  try {
    table = env.state.getTable(stmt.table);
  } catch (error) {
    if (!isExpectedFastPathMiss(error)) throw error;
    return null;
  }
  if (!table.isUnconstrained()) return null;
  const tuple = stmt.values?.[0];
  if (!tuple) return null;
  const columnNames = stmt.columns ?? table.columns.map((column) => column.name);
  if (tuple.length !== columnNames.length) return null;
  if (columnNames.some((name) => isRowidName(name))) return null;
  const slots: FastInsertSlot[] = [];
  for (const column of table.columns) {
    const key = column.nameLower ?? column.name.toLowerCase();
    const suppliedIndex = columnNames.findIndex((name) => name.toLowerCase() === key);
    if (suppliedIndex < 0) {
      if (column.defaultExpr) return null;
      slots.push({ key, affinity: column.affinity, read: () => null });
      continue;
    }
    const expr = tuple[suppliedIndex];
    if (!expr) return null;
    if (expr.type === "parameter") {
      const name = expr.name;
      slots.push({ key, affinity: column.affinity, read: (exec) => exec.getBoundParameter(name) });
    } else if (expr.type === "literal") {
      const value = expr.forceReal && typeof expr.value === "number" ? asSqlReal(expr.value) : expr.value;
      slots.push({ key, affinity: column.affinity, read: () => value });
    } else if (expr.type === "null") {
      slots.push({ key, affinity: column.affinity, read: () => null });
    } else return null;
  }
  return { tableName: stmt.table, slots };
}

export function executeUpdate(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  try {
    return withDmlCtes(stmt.with, env, () => executeUpdateCore(stmt, env));
  } catch (error) {
    handleConflictRollback(stmt.or === "rollback", error, env);
    throw error;
  }
}

function executeUpdateCore(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualUpdate(stmt, env);
  }
  const totalBefore = env.state.totalChanges;
  const view = writableView(stmt.table, "UPDATE", env);
  if (view) return executeViewUpdate(stmt, view, env, totalBefore);
  // Scan for candidates before any statement savepoint. getWritableTable must run *after*
  // freeze/clone so all row mutations share one live writable table (not re-clone from frozen).
  const scanTable = env.state.getTable(stmt.table);
  const alias = stmt.alias ?? stmt.table;
  const candidates: { row: Row; scope: ScopeRow }[] = [];

  if (stmt.from) {
    const fromRows = scanFrom(stmt.from, env);
    for (const row of scanTable.scan()) {
      const targetScope = scopeFor(scanTable, row, alias, env);
      let matchedScope: ScopeRow | null = null;
      for (const fromRow of fromRows) {
        const joined: ScopeRow = {
          ...targetScope,
          cells: [...targetScope.cells, ...fromRow.cells],
        };
        if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(joined))) !== true) continue;
        // SQLite keeps the last matching FROM row when multiple sources match.
        matchedScope = joined;
      }
      if (matchedScope) candidates.push({ row, scope: matchedScope });
    }
  } else {
    const indexed =
      stmt.where === null
        ? null
        : tryIndexedTableRows({ type: "table", schema: null, name: stmt.table, alias: stmt.alias }, stmt.where, env);
    const scanRows = indexed ? indexed.rows : scanTable.scan();
    for (const row of scanRows) {
      const scope = scopeFor(scanTable, row, alias, env);
      if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) !== true) continue;
      candidates.push({ row, scope });
    }
  }

  const applyUpdates = (): ResultSet => {
    let table = env.state.getWritableTable(stmt.table);
    const returningRows: SqlValue[][] = [];
    let changes = 0;
    for (const { row, scope } of candidates) {
      const ctx = env.createEvalContext(scope);
      const updates = evaluateSet(stmt.set, table, ctx);
      const newValues = mergedValues(table, row, updates);
      const updatedColumns = new Set(
        [...updates.keys()].map((key) => {
          const column = table.columns.find((item) => normalizeColumnName(item.name) === key);
          return column?.name ?? key;
        }),
      );
      if (fireUpdateTriggers("BEFORE", table, row, newValues, updatedColumns, env) === "ignore") continue;
      try {
        if (stmt.or === "replace") {
          for (const conflict of conflictingRows(table, newValues, env)) {
            if (conflict.rowid === row.rowid) continue;
            removeOne(table, conflict, env);
            table = env.state.getWritableTable(stmt.table);
            // SQLite changes() counts the updated row only, not replaced conflict deletions.
          }
        }
        const updated = updateOne(table, row, updates, env);
        table = env.state.getWritableTable(stmt.table);
        fireUpdateTriggers("AFTER", table, row, table.namedValues(updated.row), updatedColumns, env);
        changes += 1 + updated.cascaded;
        if (stmt.returning.length)
          returningRows.push(projectReturning(stmt.returning, scopeFor(table, updated.row, alias, env), env));
      } catch (error) {
        if (
          stmt.or === "ignore" &&
          error instanceof SqliteError &&
          error.category.startsWith("constraint") &&
          error.category !== "constraint_foreign"
        )
          continue;
        throw error;
      }
    }
    const reportedChanges = finalizeDmlChanges(totalBefore, changes, env);
    return valuesToResult(
      returningNames(stmt.returning, table),
      returningRows,
      reportedChanges,
      env.state.lastInsertRowid,
    );
  };

  if (updateAbortResolution(stmt.or) === "abort" && candidates.length > 1) {
    return withStatementAtomicity(env, "abort", applyUpdates);
  }
  return applyUpdates();
}

export function executeDelete(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  try {
    return withDmlCtes(stmt.with, env, () => executeDeleteCore(stmt, env));
  } catch (error) {
    handleConflictRollback(stmt.or === "rollback", error, env);
    throw error;
  }
}

function executeDeleteCore(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualDelete(stmt, env);
  }
  const totalBefore = env.state.totalChanges;
  const view = writableView(stmt.table, "DELETE", env);
  if (view) return executeViewDelete(stmt, view, env, totalBefore);
  // Select targets before any statement savepoint; get writable only inside applyDeletes.
  const scanTable = env.state.getTable(stmt.table);
  const selectedSource =
    stmt.where === null
      ? null
      : tryIndexedTableRows({ type: "table", schema: null, name: stmt.table, alias: stmt.alias }, stmt.where, env);
  const selected = [...(selectedSource ? selectedSource.rows : scanTable.scan())].filter((row) => {
    if (!stmt.where) return true;
    return (
      isTruthySql(
        evalExpr(stmt.where, env.createEvalContext(scopeFor(scanTable, row, stmt.alias ?? stmt.table, env))),
      ) === true
    );
  });

  const applyDeletes = (): ResultSet => {
    let table = env.state.getWritableTable(stmt.table);
    const returningRows: SqlValue[][] = [];
    let changes = 0;
    for (const row of selected) {
      try {
        if (fireDeleteTriggers("BEFORE", table, row, env) === "ignore") continue;
        if (stmt.returning.length)
          returningRows.push(
            projectReturning(stmt.returning, scopeFor(table, row, stmt.alias ?? stmt.table, env), env),
          );
        changes += applyReferentialDelete(table, row, env);
        table = env.state.getWritableTable(stmt.table);
        removeOne(table, row, env);
        table = env.state.getWritableTable(stmt.table);
        fireDeleteTriggers("AFTER", table, row, env);
        changes++;
      } catch (error) {
        if (
          stmt.or === "ignore" &&
          error instanceof SqliteError &&
          error.category.startsWith("constraint") &&
          error.category !== "constraint_foreign"
        )
          continue;
        throw error;
      }
    }
    const reportedChanges = finalizeDmlChanges(totalBefore, changes, env);
    return valuesToResult(
      returningNames(stmt.returning, table),
      returningRows,
      reportedChanges,
      env.state.lastInsertRowid,
    );
  };

  if (deleteAbortResolution(stmt.or) === "abort" && selected.length > 1) {
    return withStatementAtomicity(env, "abort", applyDeletes);
  }
  return applyDeletes();
}

function withDmlCtes(withClause: WithClause | null, env: ExecutionEnv, execute: () => ResultSet): ResultSet {
  if (!withClause) return execute();
  const savedCtes = new Map(env.ctes);
  try {
    executeWith(withClause, env);
    return execute();
  } finally {
    env.ctes.clear();
    for (const [name, result] of savedCtes) env.ctes.set(name, result);
  }
}

function handleConflictRollback(rollback: boolean, error: unknown, env: ExecutionEnv): void {
  if (
    rollback &&
    env.transactions.inTransaction &&
    error instanceof SqliteError &&
    error.category.startsWith("constraint")
  ) {
    env.transactions.rollback();
  }
}

let statementSavepointSeq = 0;
let statementAtomicityDepth = 0;

/** SQLite ABORT: undo all changes from the current statement; FAIL keeps prior row changes. */
function withStatementAtomicity<T>(env: ExecutionEnv, resolution: "abort" | "fail", run: () => T): T {
  if (resolution === "fail") return run();
  // Nested DML (e.g. triggers) shares the outer statement savepoint; re-freezing would
  // invalidate caller table references mid-statement.
  if (statementAtomicityDepth > 0) return run();
  const name = `__mem_stmt_${++statementSavepointSeq}`;
  statementAtomicityDepth++;
  env.transactions.savepoint(name);
  try {
    const result = run();
    env.transactions.release(name);
    return result;
  } catch (error) {
    if (env.transactions.inTransaction) {
      try {
        env.transactions.rollback(name);
        env.transactions.release(name);
      } catch {
        // Transaction may already have been rolled back (OR ROLLBACK).
      }
    }
    throw error;
  } finally {
    statementAtomicityDepth--;
  }
}

function insertAbortResolution(mode: InsertStmt["mode"]): "abort" | "fail" {
  return mode === "insert_or_fail" ? "fail" : "abort";
}

function updateAbortResolution(or: UpdateStmt["or"]): "abort" | "fail" {
  return or === "fail" ? "fail" : "abort";
}

function deleteAbortResolution(or: DeleteStmt["or"]): "abort" | "fail" {
  return or === "fail" ? "fail" : "abort";
}

interface WritableView {
  schema: string | null;
  name: string;
  view: ViewInfo;
  table: Table;
}

function writableView(name: string, event: "INSERT" | "UPDATE" | "DELETE", env: ExecutionEnv): WritableView | null {
  const { schema, bare } = splitQualifiedName(name);
  const db = env.state.databaseForSchema(schema, name);
  const view = db.views.get(bare.toLowerCase());
  if (!view) return null;
  const hasInsteadOf = [...db.triggers.values()].some(
    (trigger) =>
      trigger.tableName.toLowerCase() === bare.toLowerCase() && trigger.event === event && trigger.timing === "INSTEAD",
  );
  if (!hasInsteadOf) {
    throw new SqliteError(`cannot modify ${bare} because it is a view`, "other");
  }
  const names = view.columns ?? executeSelect(view.select, env).columns;
  return {
    schema,
    name: bare,
    view,
    table: new Table(
      bare,
      names.map((column) => makeColumnInfo(column, null)),
    ),
  };
}

function executeViewInsert(stmt: InsertStmt, target: WritableView, env: ExecutionEnv, totalBefore: number): ResultSet {
  const columnNames = stmt.columns ?? target.table.columns.map((column) => column.name);
  for (const name of columnNames) columnOf(target.table, name);
  const suppliedIndexes = target.table.columns.map((column) =>
    columnNames.findIndex((name) => name.toLowerCase() === normalizeColumnName(column.name)),
  );
  for (const source of evaluateInsertSource(stmt, env)) {
    if (source.length !== columnNames.length) {
      throw new SqliteError(`${source.length} values for ${columnNames.length} columns`, "other");
    }
    const values = new Map<string, SqlValue>();
    target.table.columns.forEach((column, index) => {
      const supplied = suppliedIndexes[index] ?? -1;
      values.set(normalizeColumnName(column.name), supplied < 0 ? null : (source[supplied] ?? null));
    });
    fireInsertTriggers("INSTEAD", target.table, values, null, env);
  }
  const changes = finalizeDmlChanges(totalBefore, 0, env);
  return emptyResult(changes, env.state.lastInsertRowid);
}

function executeViewUpdate(stmt: UpdateStmt, target: WritableView, env: ExecutionEnv, totalBefore: number): ResultSet {
  const alias = stmt.alias ?? target.name;
  const scopes = scanView(target, alias, env);
  const updatedColumns = new Set(
    stmt.set.flatMap((item) => item.columns.map((name) => columnOf(target.table, name).name)),
  );
  for (const scope of scopes) {
    const ctx = env.createEvalContext(scope);
    if (stmt.where && isTruthySql(evalExpr(stmt.where, ctx)) !== true) continue;
    const oldRow = viewRow(target.table, scope);
    const updates = evaluateSet(stmt.set, target.table, ctx);
    const newValues = mergedValues(target.table, oldRow, updates);
    fireUpdateTriggers("INSTEAD", target.table, oldRow, newValues, updatedColumns, env);
  }
  const changes = finalizeDmlChanges(totalBefore, 0, env);
  return emptyResult(changes, env.state.lastInsertRowid);
}

function executeViewDelete(stmt: DeleteStmt, target: WritableView, env: ExecutionEnv, totalBefore: number): ResultSet {
  const alias = stmt.alias ?? target.name;
  for (const scope of scanView(target, alias, env)) {
    if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) !== true) continue;
    fireDeleteTriggers("INSTEAD", target.table, viewRow(target.table, scope), env);
  }
  const changes = finalizeDmlChanges(totalBefore, 0, env);
  return emptyResult(changes, env.state.lastInsertRowid);
}

function scanView(target: WritableView, alias: string, env: ExecutionEnv): ScopeRow[] {
  return scanFrom(
    { type: "table", schema: target.schema, name: target.name, alias: alias === target.name ? null : alias },
    env,
  );
}

function viewRow(table: Table, scope: ScopeRow): Row {
  const values: SqlValue[] = [];
  for (const column of table.columns) {
    const key = normalizeColumnName(column.name);
    const cell = scope.cells.find((candidate) => normalizeColumnName(candidate.name) === key);
    values.push(cell?.value ?? null);
  }
  return { rowid: scope.rowid ?? 0, values };
}

function finalizeDmlChanges(totalBefore: number, directChanges: number, env: ExecutionEnv, last?: Rowid): number {
  const triggerChanges = env.state.totalChanges - totalBefore;
  env.state.recordChange(directChanges, last);
  const reportedChanges = triggerChanges + directChanges;
  env.state.changes = reportedChanges;
  return reportedChanges;
}

function mergedValues(table: Table, row: Row, updates: Map<string, SqlValue>): Map<string, SqlValue> {
  const values = new Map<string, SqlValue>();
  for (const column of table.columns) {
    const key = normalizeColumnName(column.name);
    values.set(key, updates.has(key) ? updates.get(key)! : table.cell(row, key));
  }
  return values;
}

function evaluateSet(
  items: SetItem[],
  table: Table,
  ctx: ReturnType<ExecutionEnv["createEvalContext"]>,
): Map<string, SqlValue> {
  const updates = new Map<string, SqlValue>();
  for (const item of items) {
    if (item.columns.length === 1) {
      const column = columnOf(table, item.columns[0]!);
      if (column.generated) throw new SqliteError(`cannot UPDATE generated column "${column.name}"`, "misuse");
      updates.set(normalizeColumnName(column.name), storeColumnValue(table, column, evalExpr(item.expr, ctx)));
      continue;
    }
    if (item.expr.type !== "row" || item.expr.values.length !== item.columns.length) {
      throw new SqliteError(
        `${item.columns.length} columns assigned ${item.expr.type === "row" ? item.expr.values.length : 1} values`,
        "other",
      );
    }
    item.columns.forEach((name, index) => {
      const column = columnOf(table, name);
      if (column.generated) throw new SqliteError(`cannot UPDATE generated column "${column.name}"`, "misuse");
      updates.set(
        normalizeColumnName(column.name),
        storeColumnValue(table, column, evalExpr(item.expr.type === "row" ? item.expr.values[index]! : item.expr, ctx)),
      );
    });
  }
  return updates;
}

function updateOne(
  table: Table,
  row: Row,
  updates: Map<string, SqlValue>,
  env: ExecutionEnv,
): { row: Row; cascaded: number } {
  table = env.state.ensureWritableTable(table);
  const before = row;
  let after: Row | undefined;
  let indexesAdded = false;
  removeIndexes(table, before, env);
  try {
    const merged = table.namedValues(row);
    for (const [name, value] of updates) merged.set(name, value);
    for (const column of table.columns) {
      if (!column.generated?.stored) continue;
      const genCtx = env.createEvalContext({
        cells: table.columns
          .filter((c) => !c.generated)
          .map((c) => ({
            table: table.name,
            name: c.name,
            value: merged.get(normalizeColumnName(c.name)) ?? null,
            affinity: c.affinity,
            collate: c.collate,
          })),
      });
      merged.set(
        normalizeColumnName(column.name),
        storeColumnValue(table, column, evalExpr(column.generated.expr, genCtx)),
      );
    }
    after = table.update(row.rowid, merged);
    if (!after) throw new SqliteError(`no such row: ${row.rowid}`, "other");
    validateRow(table, after, env);
    addIndexes(table, after, env);
    indexesAdded = true;
    checkForeignKeys(table, after, env);
    const cascaded = applyReferentialUpdate(table, before, after, env);
    return { row: after, cascaded };
  } catch (error) {
    if (after) {
      if (indexesAdded) removeIndexes(table, after, env);
      // Revert row storage (including WITHOUT ROWID clustered keys), not just `rows`.
      table.update(before.rowid, table.namedValues(before));
    }
    addIndexes(table, before, env);
    throw error;
  }
}

function validateRow(table: Table, row: Row, env: ExecutionEnv): void {
  checkTableConstraints(table, row, (expr, candidate) =>
    evalExpr(expr, env.createEvalContext(scopeFor(table, candidate, table.name, env))),
  );
}

function addIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  const db = env.state.databaseForTable(table);
  for (const name of table.indexes) {
    const found = db.indexes.get(name.toLowerCase());
    if (!found) continue;
    const index = db.ensureWritableIndex(found);
    if (
      index.where &&
      isTruthySql(evalExpr(index.where, env.createEvalContext(scopeFor(table, row, table.name, env)))) !== true
    )
      continue;
    index.store.insert(indexValues(index.columns, row, env, table), row.rowid, index.unique);
  }
}

function removeIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  const db = env.state.databaseForTable(table);
  for (const name of table.indexes) {
    const found = db.indexes.get(name.toLowerCase());
    if (!found) continue;
    const index = db.ensureWritableIndex(found);
    index.store.remove(indexValues(index.columns, row, env, table), row.rowid);
  }
}

function removeOne(table: Table, row: Row, env: ExecutionEnv): void {
  table = env.state.ensureWritableTable(table);
  removeIndexes(table, row, env);
  table.delete(row.rowid);
}

function conflictingRows(table: Table, values: Map<string, SqlValue>, env: ExecutionEnv): Row[] {
  return conflictsForSets(table, values, uniqueColumnSets(table, env), env);
}

function conflictsMatchingTarget(
  table: Table,
  values: Map<string, SqlValue>,
  env: ExecutionEnv,
  targetColumns: string[],
): Row[] {
  const targetKeys = targetColumns.map((name) => normalizeColumnName(name));
  const matchingSets = uniqueColumnSets(table, env).filter((columns) => {
    if (columns.length !== targetKeys.length) return false;
    const setKeys = columns.map((column) => normalizeColumnName(column.name));
    return targetKeys.every((key) => setKeys.includes(key));
  });
  if (matchingSets.length === 0) {
    // Infer INTEGER PRIMARY KEY / rowid target.
    if (
      targetKeys.length === 1 &&
      (targetKeys[0] === "rowid" ||
        table.columns.some((column) => normalizeColumnName(column.name) === targetKeys[0] && column.primaryKey))
    ) {
      const pkSets = uniqueColumnSets(table, env).filter(
        (columns) =>
          columns.length === 1 &&
          (normalizeColumnName(columns[0]!.name) === targetKeys[0] ||
            table.columns.find((column) => normalizeColumnName(column.name) === normalizeColumnName(columns[0]!.name))
              ?.primaryKey),
      );
      return conflictsForSets(
        table,
        values,
        pkSets.length > 0 ? pkSets : [[{ name: targetColumns[0]!, collate: null, order: null }]],
        env,
      );
    }
    return [];
  }
  return conflictsForSets(table, values, matchingSets, env);
}

function conflictsForUpsert(
  table: Table,
  values: Map<string, SqlValue>,
  env: ExecutionEnv,
  upsert: NonNullable<InsertStmt["upsert"]>,
): Row[] {
  if (!upsert.targetColumns) return conflictingRows(table, values, env);
  const exprs = upsert.targetExprs;
  const hasExpr = exprs?.some((expr) => expr.type !== "column") ?? false;
  if (hasExpr && exprs) {
    const db = env.state.databaseForTable(table);
    for (const indexName of table.indexes) {
      const index = db.indexes.get(indexName.toLowerCase());
      if (!index?.unique || index.columns.length !== exprs.length) continue;
      const matches = index.columns.every((column, i) => {
        const expr = exprs[i]!;
        if (column.expr) return exprEquals(column.expr, expr);
        return expr.type === "column" && expr.name.toLowerCase() === column.name.toLowerCase();
      });
      if (!matches) continue;
      if (upsert.targetWhere && index.where && !exprEquals(upsert.targetWhere, index.where)) continue;
      return conflictsForSets(table, values, [index.columns], env);
    }
  }
  return conflictsMatchingTarget(table, values, env, upsert.targetColumns.filter(Boolean));
}

function uniqueColumnSets(table: Table, env: ExecutionEnv): IndexedColumn[][] {
  const sets: IndexedColumn[][] = [];
  const seen = new Set<string>();
  const remember = (columns: IndexedColumn[]): void => {
    const key = columns.map((column) => normalizeColumnName(column.name)).join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    sets.push(columns);
  };

  for (const indexName of table.indexes) {
    const index = env.state.databaseForTable(table).indexes.get(indexName.toLowerCase());
    if (index?.unique) remember(index.columns);
  }

  // INTEGER PRIMARY KEY / rowid uniqueness (no autoindex).
  const pk = table.integerPkColumn();
  if (pk) remember([{ name: pk.name, collate: pk.collate, order: null }]);

  // Fallback for any UNIQUE/PK constraints not yet covered by an index (legacy / edge cases).
  const hasTablePrimary = table.constraints.some((constraint) => constraint.type === "primary_key");
  for (const column of table.columns) {
    if (column.unique || (column.primaryKey && !hasTablePrimary)) {
      remember([{ name: column.name, collate: column.collate, order: null }]);
    }
  }
  for (const constraint of table.constraints) {
    if (constraint.type === "unique" || constraint.type === "primary_key") remember(constraint.columns);
  }
  return sets;
}

function conflictsForSets(
  table: Table,
  values: Map<string, SqlValue>,
  sets: IndexedColumn[][],
  env: ExecutionEnv,
): Row[] {
  const found: Row[] = [];
  const seen = new Set<string>();
  const push = (row: Row): void => {
    const key = String(row.rowid);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(row);
  };

  const db = env.state.databaseForTable(table);
  for (const columns of sets) {
    const desired = indexValuesFromMap(columns, values, table, env);
    if (desired.some((value) => value === null)) continue;

    // INTEGER PRIMARY KEY / rowid map.
    if (columns.length === 1) {
      const pk = table.integerPkColumn();
      if (pk && normalizeColumnName(columns[0]!.name) === normalizeColumnName(pk.name)) {
        const row = table.getByKey(desired[0]!);
        if (row) push(row);
        continue;
      }
    }

    // Prefer IndexStore lookup (autoindexes + CREATE INDEX).
    let usedIndex = false;
    for (const indexName of table.indexes) {
      const index = db.indexes.get(indexName.toLowerCase());
      if (!index?.unique) continue;
      if (index.columns.length !== columns.length) continue;
      if (
        !index.columns.every((column, i) => normalizeColumnName(column.name) === normalizeColumnName(columns[i]!.name))
      ) {
        continue;
      }
      usedIndex = true;
      if (index.where && !indexWhereMatches(index.where, values, table, env)) continue;
      for (const rowid of index.store.lookup(desired)) {
        const row = table.get(rowid);
        if (row) push(row);
      }
      break;
    }
    if (usedIndex) continue;

    // Slow fallback: full scan (should be rare once autoindexes exist).
    for (const row of table.scan()) {
      const existing = indexValues(columns, row, env, table);
      if (desired.every((value, index) => compareSql(value, existing[index] ?? null) === 0)) push(row);
    }
  }
  return found;
}

function indexValues(columns: IndexedColumn[], row: Row, env?: ExecutionEnv, table?: Table): SqlValue[] {
  if (!env || !table) return indexKeyValues(columns, row, null, table);
  return indexKeyValues(columns, row, env.createEvalContext(scopeFor(table, row, table.name, env)), table);
}

function indexValuesFromMap(
  columns: IndexedColumn[],
  values: Map<string, SqlValue>,
  table: Table,
  env: ExecutionEnv,
): SqlValue[] {
  const fake = table.rowFromNamed(values);
  return indexValues(columns, fake, env, table);
}

function indexWhereMatches(where: Expr, values: Map<string, SqlValue>, table: Table, env: ExecutionEnv): boolean {
  const fake = table.rowFromNamed(values);
  return isTruthySql(evalExpr(where, env.createEvalContext(scopeFor(table, fake, table.name, env)))) === true;
}

function checkForeignKeys(table: Table, row: Row, env: ExecutionEnv): void {
  if (!env.state.foreignKeysEnabled) return;
  for (const constraint of table.constraints) {
    if (constraint.type !== "foreign_key") continue;
    if (fkIsDeferred(constraint, env)) continue;
    assertForeignKeySatisfied(table, row, constraint, env);
  }
}

function fkIsDeferred(
  constraint: Extract<Table["constraints"][number], { type: "foreign_key" }>,
  env: ExecutionEnv,
): boolean {
  return env.transactions.inTransaction && constraint.initiallyDeferred;
}

function assertForeignKeySatisfied(
  table: Table,
  row: Row,
  constraint: Extract<Table["constraints"][number], { type: "foreign_key" }>,
  env: ExecutionEnv,
  excludeParent: Row | null = null,
): void {
  const values = constraint.columns.map((name) => table.cell(row, normalizeColumnName(name)));
  assertForeignKeyValues(values, constraint, env, excludeParent);
}

/** Like assertForeignKeySatisfied, but using pending column updates (ON DELETE SET DEFAULT). */
function assertForeignKeySatisfiedWithUpdates(
  table: Table,
  row: Row,
  constraint: Extract<Table["constraints"][number], { type: "foreign_key" }>,
  updates: Map<string, SqlValue>,
  env: ExecutionEnv,
  excludeParent: Row | null,
): void {
  const values = constraint.columns.map((name) => {
    const key = normalizeColumnName(name);
    return updates.has(key) ? (updates.get(key) ?? null) : table.cell(row, key);
  });
  assertForeignKeyValues(values, constraint, env, excludeParent);
}

function assertForeignKeyValues(
  values: SqlValue[],
  constraint: Extract<Table["constraints"][number], { type: "foreign_key" }>,
  env: ExecutionEnv,
  excludeParent: Row | null,
): void {
  // SQLite parses MATCH FULL/PARTIAL but enforces MATCH SIMPLE only (any NULL skips the check).
  if (values.some((value) => value === null)) return;
  const parent = env.state.getTable(constraint.refTable);
  const parentColumns =
    constraint.refColumns ?? parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (findParentRowsForFk(parent, parentColumns, values, env, excludeParent).length === 0) {
    throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
  }
}

function parentRowMatchesFk(
  parent: Table,
  parentColumns: string[],
  values: SqlValue[],
  excludeParent: Row | null,
  candidate: Row,
): boolean {
  if (excludeParent && candidate.rowid === excludeParent.rowid) return false;
  return values.every((value, index) => {
    const parentColumn = parentColumns[index];
    return (
      parentColumn !== undefined && compareSql(value, parent.cell(candidate, normalizeColumnName(parentColumn))) === 0
    );
  });
}

function findParentRowsForFk(
  parent: Table,
  parentColumns: string[],
  values: SqlValue[],
  env: ExecutionEnv,
  excludeParent: Row | null,
): Row[] {
  const db = env.state.databaseForTable(parent);
  const pk = parent.integerPkColumn();
  if (parentColumns.length === 1) {
    const col = parentColumns[0]!.toLowerCase();
    if (
      col === "rowid" ||
      col === "_rowid_" ||
      col === "oid" ||
      (pk && col === (pk.nameLower ?? pk.name.toLowerCase()))
    ) {
      const row = parent.getByKey(values[0]!);
      if (row && parentRowMatchesFk(parent, parentColumns, values, excludeParent, row)) return [row];
      return [];
    }
  }

  const normalizedValues = values.map((value, index) => {
    const colName = parentColumns[index]!;
    const column = parent.columns.find((item) => (item.nameLower ?? item.name.toLowerCase()) === colName.toLowerCase());
    return normalizeForCollation(value, column?.collate ?? "BINARY");
  });
  for (const indexName of parent.indexes) {
    const index = db.indexes.get(indexName.toLowerCase());
    if (!index?.unique || index.where || index.columns.some((column) => column.expr)) continue;
    if (index.columns.length !== parentColumns.length) continue;
    if (!index.columns.every((column, idx) => column.name.toLowerCase() === parentColumns[idx]!.toLowerCase()))
      continue;
    const rows: Row[] = [];
    for (const rowid of index.store.lookup(normalizedValues)) {
      const candidate = parent.get(rowid);
      if (candidate && parentRowMatchesFk(parent, parentColumns, values, excludeParent, candidate))
        rows.push(candidate);
    }
    return rows;
  }

  return [...parent.scan()].filter((candidate) =>
    parentRowMatchesFk(parent, parentColumns, values, excludeParent, candidate),
  );
}

function findChildRowsForFk(
  child: Table,
  childColumns: string[],
  parentColumns: string[],
  parent: Table,
  parentRow: Row,
  env: ExecutionEnv,
): Row[] {
  const refValues = parentColumns.map((name) => parent.cell(parentRow, normalizeColumnName(name)));
  if (refValues.some((value) => value === null)) return [];

  if (childColumns.length === 1) {
    const col = childColumns[0]!.toLowerCase();
    const matches = child.lookupEquality(col, refValues[0]!);
    if (matches) {
      return matches.filter((candidate) =>
        foreignKeyMatches(childColumns, candidate, parentColumns, parentRow, child, parent),
      );
    }
  }

  const db = env.state.databaseForTable(child);
  const normalizedValues = refValues.map((value, index) => {
    const colName = childColumns[index]!;
    const column = child.columns.find((item) => (item.nameLower ?? item.name.toLowerCase()) === colName.toLowerCase());
    return normalizeForCollation(value, column?.collate ?? "BINARY");
  });
  for (const indexName of child.indexes) {
    const index = db.indexes.get(indexName.toLowerCase());
    if (!index || index.where || index.columns.some((column) => column.expr)) continue;
    if (index.columns.length < childColumns.length) continue;
    if (!childColumns.every((name, idx) => index.columns[idx]?.name.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    const lookupValues = normalizedValues.slice(0, index.columns.length);
    const rowids =
      lookupValues.length === index.columns.length
        ? index.store.lookup(lookupValues)
        : index.store.lookupPrefix(lookupValues);
    const rows: Row[] = [];
    for (const rowid of rowids) {
      const candidate = child.get(rowid);
      if (candidate && foreignKeyMatches(childColumns, candidate, parentColumns, parentRow, child, parent)) {
        rows.push(candidate);
      }
    }
    return rows;
  }

  return [...child.scan()].filter((candidate) =>
    foreignKeyMatches(childColumns, candidate, parentColumns, parentRow, child, parent),
  );
}

export function checkDeferredForeignKeys(env: ExecutionEnv): void {
  if (!env.state.foreignKeysEnabled) return;
  for (const table of env.state.tables.values()) {
    for (const constraint of table.constraints) {
      if (constraint.type !== "foreign_key" || !constraint.initiallyDeferred) continue;
      for (const row of table.scan()) assertForeignKeySatisfied(table, row, constraint, env);
    }
  }
}

function applyReferentialDelete(parent: Table, row: Row, env: ExecutionEnv): number {
  if (!env.state.foreignKeysEnabled) return 0;
  let changes = 0;
  const parentPk = parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  for (const childKey of [...env.state.tables.keys()]) {
    let child = env.state.tables.get(childKey);
    if (!child) continue;
    for (const constraint of child.constraints) {
      if (constraint.type !== "foreign_key" || constraint.refTable.toLowerCase() !== parent.name.toLowerCase())
        continue;
      child = env.state.ensureWritableTable(child);
      const target = child;
      const referenced = constraint.refColumns ?? parentPk;
      const matches = findChildRowsForFk(target, constraint.columns, referenced, parent, row, env).filter(
        (candidate) => !(target === parent && candidate.rowid === row.rowid),
      );
      for (const candidate of matches) {
        if (constraint.onDelete === "CASCADE") {
          changes += applyReferentialDelete(child, candidate, env);
          if (fireDeleteTriggers("BEFORE", child, candidate, env) === "ignore") continue;
          removeOne(child, candidate, env);
          fireDeleteTriggers("AFTER", child, candidate, env);
          changes++;
        } else if (constraint.onDelete === "SET NULL") {
          const updated = updateOne(
            child,
            candidate,
            new Map(constraint.columns.map((name) => [normalizeColumnName(name), null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onDelete === "SET DEFAULT") {
          const updates = defaultUpdates(child, constraint.columns, env);
          // Default must resolve to a surviving parent row (exclude the row being deleted).
          assertForeignKeySatisfiedWithUpdates(child, candidate, constraint, updates, env, row);
          const updated = updateOne(child, candidate, updates, env);
          changes += 1 + updated.cascaded;
        } else if (constraint.onDelete === "RESTRICT" || !fkIsDeferred(constraint, env)) {
          throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
        }
      }
    }
  }
  return changes;
}

function applyReferentialUpdate(parent: Table, before: Row, after: Row, env: ExecutionEnv): number {
  if (!env.state.foreignKeysEnabled) return 0;
  let changes = 0;
  const parentPk = parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  for (const childKey of [...env.state.tables.keys()]) {
    let child = env.state.tables.get(childKey);
    if (!child) continue;
    for (const constraint of child.constraints) {
      if (constraint.type !== "foreign_key" || constraint.refTable.toLowerCase() !== parent.name.toLowerCase())
        continue;
      child = env.state.ensureWritableTable(child);
      const target = child;
      const referenced = constraint.refColumns ?? parentPk;
      const oldValues = referenced.map((name) => parent.cell(before, normalizeColumnName(name)));
      const newValues = referenced.map((name) => parent.cell(after, normalizeColumnName(name)));
      if (oldValues.every((value, index) => compareSql(value, newValues[index] ?? null) === 0)) continue;

      const matches = findChildRowsForFk(target, constraint.columns, referenced, parent, before, env);
      for (const candidate of matches) {
        if (constraint.onUpdate === "CASCADE") {
          const updated = updateOne(
            target,
            candidate,
            new Map(constraint.columns.map((name, index) => [normalizeColumnName(name), newValues[index] ?? null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onUpdate === "SET NULL") {
          const updated = updateOne(
            target,
            candidate,
            new Map(constraint.columns.map((name) => [normalizeColumnName(name), null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onUpdate === "SET DEFAULT") {
          const updated = updateOne(target, candidate, defaultUpdates(target, constraint.columns, env), env);
          changes += 1 + updated.cascaded;
        } else if (constraint.onUpdate === "RESTRICT" || !fkIsDeferred(constraint, env)) {
          throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
        }
      }
    }
  }
  return changes;
}

function foreignKeyMatches(
  childColumns: string[],
  child: Row,
  parentColumns: string[],
  parent: Row,
  childTable: Table,
  parentTable: Table,
): boolean {
  const childValues = childColumns.map((name) => childTable.cell(child, normalizeColumnName(name)));
  if (childValues.some((value) => value === null)) return false;
  return childValues.every((value, index) => {
    const parentColumn = parentColumns[index];
    return (
      parentColumn !== undefined && compareSql(value, parentTable.cell(parent, normalizeColumnName(parentColumn))) === 0
    );
  });
}

function defaultUpdates(table: Table, columns: string[], env: ExecutionEnv): Map<string, SqlValue> {
  return new Map(
    columns.map((name) => {
      const column = columnOf(table, name);
      const value = column.defaultExpr ? evalExpr(column.defaultExpr, env.createEvalContext()) : null;
      return [normalizeColumnName(column.name), value];
    }),
  );
}

function scopeFor(table: Table, row: Row, alias: string, env?: ExecutionEnv): ScopeRow {
  const integerPkAlias = table.withoutRowid
    ? undefined
    : table.columns.find((column) => column.primaryKey && column.typeName?.trim().toUpperCase() === "INTEGER")?.name;
  const baseCells = table.columns
    .filter((c) => !c.generated || c.generated.stored)
    .map((column) => ({
      table: alias,
      name: column.name,
      value: table.cell(row, normalizeColumnName(column.name)),
      affinity: column.affinity,
      collate: column.collate,
    }));
  const cells = [...baseCells];
  if (env) {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      const ctx = env.createEvalContext({ cells: baseCells, sourceTable: table.name });
      const value = applyAffinity(evalExpr(column.generated.expr, ctx), column.affinity);
      cells.push({
        table: alias,
        name: column.name,
        value,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
    // Preserve column order
    cells.sort((a, b) => {
      const ai = table.columns.findIndex((c) => c.name.toLowerCase() === a.name.toLowerCase());
      const bi = table.columns.findIndex((c) => c.name.toLowerCase() === b.name.toLowerCase());
      return ai - bi;
    });
  } else {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      cells.push({
        table: alias,
        name: column.name,
        value: null,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
    cells.sort((a, b) => {
      const ai = table.columns.findIndex((c) => c.name.toLowerCase() === a.name.toLowerCase());
      const bi = table.columns.findIndex((c) => c.name.toLowerCase() === b.name.toLowerCase());
      return ai - bi;
    });
  }
  return {
    ...(table.withoutRowid ? {} : { rowid: row.rowid }),
    rowidName: integerPkAlias ?? (table.withoutRowid ? undefined : "rowid"),
    sourceTable: table.name,
    cells,
  };
}

function projectReturning(columns: ResultColumn[], scope: ScopeRow, env: ExecutionEnv): SqlValue[] {
  const values: SqlValue[] = [];
  const ctx = env.createEvalContext(scope);
  for (const column of columns) {
    if (column.type === "star") {
      for (const cell of scope.cells)
        if (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase()) values.push(cell.value);
    } else values.push(evalExpr(column.expr, ctx));
  }
  return values;
}

function returningNames(columns: ResultColumn[], table: Table): string[] {
  return columns.flatMap((column) =>
    column.type === "star"
      ? table.columns.map((item) => item.name)
      : [column.alias ?? (column.expr.type === "column" ? column.expr.name : column.expr.type)],
  );
}

function columnOf(table: Table, name: string) {
  const column = table.columns.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!column) throw new SqliteError(`no such column: ${name}`, "no_such_column");
  return column;
}

function isRowidName(name: string): boolean {
  const key = name.toLowerCase();
  return key === "rowid" || key === "_rowid_" || key === "oid";
}

function ftsScopeFor(table: Fts5VirtualTable, row: Fts5Row, alias: string): ScopeRow {
  return {
    rowid: row.rowid,
    rowidName: "rowid",
    sourceTable: table.name,
    cells: table.columns.map((column) => ({
      table: alias,
      name: column,
      value: row.values.get(column.toLowerCase()) ?? null,
    })),
  };
}

function executeVirtualInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const columnNames = stmt.columns ?? any.columns;
    const sourceRows = stmt.values
      ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
      : stmt.select
        ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env))
        : [[]];
    let changes = 0;
    let last = env.state.lastInsertRowid;
    for (const source of sourceRows) {
      const values = new Map<string, SqlValue>();
      for (let i = 0; i < columnNames.length; i++) {
        values.set(columnNames[i]!.toLowerCase(), source[i] ?? null);
      }
      last = any.insert(values);
      changes++;
    }
    env.state.recordChange(changes, last);
    return valuesToResult([], [], changes, last);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const columnNames = stmt.columns ?? table.columns;
  for (const name of columnNames) {
    const lower = name.toLowerCase();
    if (lower === table.name.toLowerCase()) continue; // FTS special-command column
    if (lower === "rowid" || lower === "_rowid_" || lower === "oid") continue;
    if (!table.columns.some((column) => column.toLowerCase() === lower)) {
      throw new SqliteError(`table ${table.name} has no column named ${name}`, "no_such_column");
    }
  }
  const sourceRows = stmt.values
    ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
    : stmt.select
      ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env))
      : [[]];
  const { changes, lastInsertRowid } = executeFtsInsert(table, columnNames, sourceRows, env);
  env.state.recordChange(changes, lastInsertRowid);
  return valuesToResult([], [], changes, lastInsertRowid);
}

function executeVirtualUpdate(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  if (stmt.from) throw new SqliteError("UPDATE FROM is not supported", "unsupported");
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const alias = stmt.alias ?? stmt.table;
    const candidates = any.scan().filter((row) => {
      if (!stmt.where) return true;
      const scope: ScopeRow = {
        rowid: row.rowid,
        rowidName: "rowid",
        sourceTable: any.name,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) === true;
    });
    let changes = 0;
    for (const row of candidates) {
      const updates = new Map<string, SqlValue>();
      const scope: ScopeRow = {
        rowid: row.rowid,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      for (const item of stmt.set) {
        if (item.columns.length !== 1)
          throw new SqliteError("multi-column SET is not supported on virtual tables", "unsupported");
        updates.set(item.columns[0]!.toLowerCase(), evalExpr(item.expr, env.createEvalContext(scope)));
      }
      any.update(row.rowid, updates);
      changes++;
    }
    env.state.recordChange(changes);
    return valuesToResult([], [], changes, env.state.lastInsertRowid);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const alias = stmt.alias ?? stmt.table;
  const candidates: Rowid[] = [];
  for (const row of table.scan()) {
    const scope = ftsScopeFor(table, row, alias);
    if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) !== true) continue;
    candidates.push(row.rowid);
  }
  let changes = 0;
  for (const rowid of candidates) {
    const row = table.rows.get(rowid)!;
    const scope = ftsScopeFor(table, row, alias);
    const updates = evaluateFtsSet(stmt.set, table, env.createEvalContext(scope));
    executeFtsUpdate(table, updates, [rowid]);
    changes++;
  }
  env.state.recordChange(changes);
  return valuesToResult([], [], changes, env.state.lastInsertRowid);
}

function executeVirtualDelete(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const alias = stmt.alias ?? stmt.table;
    const selected = any.scan().filter((row) => {
      if (!stmt.where) return true;
      const scope: ScopeRow = {
        rowid: row.rowid,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) === true;
    });
    let changes = 0;
    for (const row of selected) {
      any.delete(row.rowid);
      changes++;
    }
    env.state.recordChange(changes);
    return valuesToResult([], [], changes, env.state.lastInsertRowid);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const alias = stmt.alias ?? stmt.table;
  const selected = table.scan().filter((row) => {
    if (!stmt.where) return true;
    return isTruthySql(evalExpr(stmt.where, env.createEvalContext(ftsScopeFor(table, row, alias)))) === true;
  });
  const changes = executeFtsDelete(
    table,
    selected.map((row) => row.rowid),
  );
  env.state.recordChange(changes);
  return valuesToResult([], [], changes, env.state.lastInsertRowid);
}

function evaluateFtsSet(
  items: SetItem[],
  table: Fts5VirtualTable,
  ctx: ReturnType<ExecutionEnv["createEvalContext"]>,
): Map<string, SqlValue> {
  const updates = new Map<string, SqlValue>();
  for (const item of items) {
    if (item.columns.length !== 1)
      throw new SqliteError("multi-column SET is not supported on virtual tables", "unsupported");
    const name = item.columns[0]!;
    if (!table.columns.some((column) => column.toLowerCase() === name.toLowerCase())) {
      throw new SqliteError(`no such column: ${name}`, "no_such_column");
    }
    updates.set(normalizeColumnName(name), evalExpr(item.expr, ctx));
  }
  return updates;
}

function asExplicitRowid(value: SqlValue): Rowid | undefined {
  if (value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new SqliteError("datatype mismatch", "datatype_mismatch", "SQLITE_MISMATCH");
}
