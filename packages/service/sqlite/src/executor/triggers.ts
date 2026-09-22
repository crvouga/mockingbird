import type { CreateTriggerStmt, DropTriggerStmt, Statement } from "../ast/nodes.ts";
import { SqliteError, TriggerRaiseError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { normalizeMasterSql } from "../schema/master-sql.ts";
import type { TriggerInfo } from "../storage/database-state.ts";
import { splitQualifiedName } from "../storage/database-state.ts";
import type { Row } from "../storage/row.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { isTruthySql, type SqlValue } from "../types/value.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { executeStatement } from "./execute.ts";
import { emptyResult, type ResultSet } from "./result.ts";

const MAX_TRIGGER_DEPTH = 1000;

export function executeCreateTrigger(stmt: CreateTriggerStmt, env: ExecutionEnv): ResultSet {
  const { schema, bare } = splitQualifiedName(stmt.name);
  const target = schema !== null ? env.state.databaseForSchema(schema, stmt.name) : env.state;
  const existing = target.triggers.get(bare.toLowerCase());
  if (existing && stmt.ifNotExists) {
    return emptyResult(0, env.state.lastInsertRowid);
  }

  const tableKey = splitQualifiedName(stmt.table).bare.toLowerCase();
  const isView = target.views.has(tableKey);
  const isTable = target.tables.has(tableKey);
  if (stmt.timing === "INSTEAD") {
    if (!isView) throw new SqliteError(`cannot create INSTEAD OF trigger on table: ${stmt.table}`, "other");
  } else if (isView) {
    throw new SqliteError(`cannot create ${stmt.timing} trigger on view: ${stmt.table}`, "other");
  } else if (!isTable) {
    throw new SqliteError(`no such table: ${stmt.table}`, "no_such_table");
  }

  if (existing) throw new SqliteError(`object already exists: ${bare}`, "other");

  target.createTrigger({
    name: bare,
    tableName: splitQualifiedName(stmt.table).bare,
    timing: stmt.timing,
    event: stmt.event,
    when: stmt.when,
    forEachRow: stmt.forEachRow,
    body: stmt.body,
    updateColumns: stmt.updateColumns,
    originalSql: env.statementSql ? normalizeMasterSql(env.statementSql) : null,
  });
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeDropTrigger(stmt: DropTriggerStmt, env: ExecutionEnv): ResultSet {
  env.state.dropTrigger(stmt.name, stmt.ifExists);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function fireInsertTriggers(
  timing: "BEFORE" | "AFTER" | "INSTEAD",
  table: Table,
  values: Map<string, SqlValue>,
  oldRow: Row | null,
  env: ExecutionEnv,
): "ok" | "ignore" {
  return runTriggers(table, "INSERT", timing, oldRow, values, null, env);
}

export function fireUpdateTriggers(
  timing: "BEFORE" | "AFTER" | "INSTEAD",
  table: Table,
  oldRow: Row,
  newValues: Map<string, SqlValue>,
  updatedColumns: Set<string>,
  env: ExecutionEnv,
): "ok" | "ignore" {
  return runTriggers(table, "UPDATE", timing, oldRow, newValues, updatedColumns, env);
}

export function fireDeleteTriggers(
  timing: "BEFORE" | "AFTER" | "INSTEAD",
  table: Table,
  oldRow: Row,
  env: ExecutionEnv,
): "ok" | "ignore" {
  return runTriggers(table, "DELETE", timing, oldRow, null, null, env);
}

function runTriggers(
  table: Table,
  event: TriggerInfo["event"],
  timing: TriggerInfo["timing"],
  oldRow: Row | null,
  newValues: Map<string, SqlValue> | null,
  updatedColumns: Set<string> | null,
  env: ExecutionEnv,
): "ok" | "ignore" {
  const db = env.state.databaseForTable(table);
  if (db.triggers.size === 0) return "ok";
  const triggers = [...db.triggers.values()].filter(
    (trigger) =>
      trigger.tableName.toLowerCase() === table.name.toLowerCase() &&
      trigger.event === event &&
      trigger.timing === timing,
  );

  for (const trigger of triggers) {
    if (event === "UPDATE" && trigger.updateColumns) {
      const watched = new Set(trigger.updateColumns.map((name) => name.toLowerCase()));
      if (!updatedColumns || ![...updatedColumns].some((name) => watched.has(name.toLowerCase()))) continue;
    }
    if (trigger.when) {
      const scope = triggerScope(table, oldRow, newValues);
      if (isTruthySql(evalExpr(trigger.when, env.createEvalContext(scope))) !== true) continue;
    }
    const result = executeTriggerProgram(trigger, table, oldRow, newValues, env);
    if (result === "ignore") return "ignore";
  }
  return "ok";
}

function executeTriggerProgram(
  trigger: TriggerInfo,
  table: Table,
  oldRow: Row | null,
  newValues: Map<string, SqlValue> | null,
  env: ExecutionEnv,
): "ok" | "ignore" {
  if (env.triggerDepth >= MAX_TRIGGER_DEPTH) {
    throw new SqliteError("too many levels of trigger recursion", "other");
  }
  env.triggerDepth++;
  const savedScope = env.triggerScope;
  const savedLastInsertRowid = env.state.lastInsertRowid;
  env.triggerScope = triggerScope(table, oldRow, newValues);
  try {
    for (const statement of trigger.body) {
      executeTriggerStatement(statement, env);
    }
    return "ok";
  } catch (error) {
    if (error instanceof TriggerRaiseError) {
      if (error.action === "IGNORE") return "ignore";
      if (error.action === "ROLLBACK") {
        env.transactions.rollback();
        throw error;
      }
      throw error;
    }
    throw error;
  } finally {
    env.state.lastInsertRowid = savedLastInsertRowid;
    env.triggerScope = savedScope;
    env.triggerDepth--;
  }
}

function executeTriggerStatement(statement: Statement, env: ExecutionEnv): void {
  executeStatement(statement, env);
}

function triggerScope(table: Table, oldRow: Row | null, newValues: Map<string, SqlValue> | null): ScopeRow {
  const cells: ScopeRow["cells"] = [];
  for (const column of table.columns) {
    const key = normalizeColumnName(column.name);
    cells.push({
      table: "old",
      name: column.name,
      value: oldRow ? table.cell(oldRow, key) : null,
      affinity: column.affinity,
      collate: column.collate,
    });
    cells.push({
      table: "new",
      name: column.name,
      value: newValues ? (newValues.get(key) ?? null) : null,
      affinity: column.affinity,
      collate: column.collate,
    });
  }
  return {
    cells,
    rowid: oldRow?.rowid ?? undefined,
    sourceTable: table.name,
  };
}
