import type {
  AlterTableStmt,
  CreateIndexStmt,
  CreateTableStmt,
  CreateViewStmt,
  DropIndexStmt,
  DropTableStmt,
  DropViewStmt,
} from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { heapRowCells, rebuildIndexFromTable } from "../indexes/keys.ts";
import { appendAddColumnToMasterSql, normalizeMasterSql, synthesizeCtasMasterSql } from "../schema/master-sql.ts";
import { normalizeColumnName } from "../storage/row.ts";
import { makeColumnInfo } from "../storage/table.ts";
import type { ExecutionEnv } from "./env.ts";
import { emptyResult, type ResultSet, resultValues } from "./result.ts";
import { executeSelect } from "./select.ts";

export function executeCreateTable(stmt: CreateTableStmt, env: ExecutionEnv): ResultSet {
  const sourceSql = env.statementSql ? normalizeMasterSql(env.statementSql) : null;
  if (!stmt.asSelect) {
    env.state.createTable(stmt, sourceSql);
    env.state.recordChange(0);
    return emptyResult(0, env.state.lastInsertRowid);
  }
  const result = executeSelect(stmt.asSelect, env);
  const columns = result.columns.map((name) => ({ name, typeName: null, constraints: [] }));
  const bareName = stmt.name.includes(".") ? (stmt.name.split(".").pop() ?? stmt.name) : stmt.name;
  const ctasSql = synthesizeCtasMasterSql(bareName, result.columns);
  const table = env.state.createTable({ ...stmt, columns, constraints: [], asSelect: null }, ctasSql);
  for (const values of resultValues(result)) {
    table.insert(
      new Map(table.columns.map((column, index) => [normalizeColumnName(column.name), values[index] ?? null])),
    );
  }
  // Populate any autoindexes created with the empty table.
  const db = env.state.databaseForTable(table);
  for (const indexName of table.indexes) {
    const index = db.indexes.get(indexName.toLowerCase());
    if (!index) continue;
    rebuildIndexFromTable(index, table, (row) =>
      env.createEvalContext({ rowid: row.rowid, sourceTable: table.name, cells: heapRowCells(table, row, env) }),
    );
  }
  env.state.recordChange(0);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeCreateIndex(stmt: CreateIndexStmt, env: ExecutionEnv): ResultSet {
  const index = env.state.createIndex(stmt, env.statementSql ? normalizeMasterSql(env.statementSql) : null);
  const table = env.state.getTable(stmt.table);
  try {
    rebuildIndexFromTable(index, table, (row) =>
      env.createEvalContext({ rowid: row.rowid, sourceTable: table.name, cells: heapRowCells(table, row, env) }),
    );
  } catch (error) {
    env.state.dropIndex(stmt.name, true);
    throw error;
  }
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeAlterTable(stmt: AlterTableStmt, env: ExecutionEnv): ResultSet {
  const table = env.state.getWritableTable(stmt.table);
  const action = stmt.action;
  if (action.kind === "rename_table") {
    env.state.renameTable(stmt.table, action.newName);
  } else if (action.kind === "rename_column") {
    const column = table.columns.find((item) => item.name.toLowerCase() === action.oldName.toLowerCase());
    if (!column) throw new SqliteError(`no such column: ${action.oldName}`, "no_such_column");
    if (table.columns.some((item) => item.name.toLowerCase() === action.newName.toLowerCase()))
      throw new SqliteError(`duplicate column name: ${action.newName}`, "other");
    column.name = action.newName;
    column.nameLower = action.newName.toLowerCase();
    table.rebuildColIndex();
    for (const constraint of table.constraints) renameConstraintColumn(constraint, action.oldName, action.newName);
    for (const name of table.indexes) {
      const index = env.state.getWritableIndex(name);
      if (index)
        for (const indexed of index.columns)
          if (indexed.name.toLowerCase() === action.oldName.toLowerCase()) indexed.name = action.newName;
    }
    table.clearEqualityHashes();
    env.state.schemaVersion++;
  } else if (action.kind === "add_column") {
    if (table.columns.some((item) => item.name.toLowerCase() === action.column.name.toLowerCase()))
      throw new SqliteError(`duplicate column name: ${action.column.name}`, "other");
    const primary = action.column.constraints.some((item) => item.type === "primary_key");
    const unique = action.column.constraints.some((item) => item.type === "unique");
    if ((primary || unique) && table.rowCount() > 0)
      throw new SqliteError("Cannot add a PRIMARY KEY or UNIQUE column", "other");
    const defaultExpr = action.column.constraints.find((item) => item.type === "default")?.expr ?? null;
    const collate = action.column.constraints.find((item) => item.type === "collate");
    const generated = action.column.constraints.find((item) => item.type === "generated");
    const column = makeColumnInfo(action.column.name, action.column.typeName, {
      notNull: action.column.constraints.some((item) => item.type === "not_null"),
      primaryKey: primary,
      unique,
      defaultExpr,
      collate: collate?.type === "collate" ? collate.name : null,
      generated: generated?.type === "generated" ? { expr: generated.expr, stored: generated.stored } : null,
    });
    const defaultValue = defaultExpr ? evalExpr(defaultExpr, env.createEvalContext()) : null;
    if (column.notNull && defaultValue === null && table.rowCount() > 0)
      throw new SqliteError("Cannot add a NOT NULL column with default value NULL", "other");
    table.materializeSlab();
    table.columns.push(column);
    table.rebuildColIndex();
    for (const row of table.rows.values()) row.values.push(defaultValue);
    table.originalSql = appendAddColumnToMasterSql(table.originalSql, env.statementSql);
    table.clearEqualityHashes();
    env.state.schemaVersion++;
  } else {
    const index = table.columns.findIndex((item) => item.name.toLowerCase() === action.name.toLowerCase());
    if (index < 0) throw new SqliteError(`no such column: ${action.name}`, "no_such_column");
    if (table.columns.length === 1)
      throw new SqliteError("cannot drop column: table must have at least one column", "other");
    const column = table.columns[index]!;
    if (column.primaryKey) {
      throw new SqliteError(`cannot drop PRIMARY KEY or UNIQUE column: ${action.name}`, "other");
    }
    if (column.unique) {
      throw new SqliteError(`cannot drop UNIQUE column: "${action.name}"`, "other");
    }
    if (
      table.constraints.some(
        (item) =>
          (item.type === "primary_key" || item.type === "unique") &&
          item.columns.some((part) => part.name.toLowerCase() === action.name.toLowerCase()),
      )
    ) {
      throw new SqliteError(
        `error in table ${stmt.table} after drop column: no such column: ${action.name}`,
        "no_such_column",
      );
    }
    for (const name of table.indexes) {
      const schemaIndex = env.state.indexes.get(name.toLowerCase());
      if (schemaIndex?.columns.some((part) => part.name.toLowerCase() === action.name.toLowerCase())) {
        throw new SqliteError(
          `error in index ${name} after drop column: no such column: ${action.name}`,
          "no_such_column",
        );
      }
    }
    table.columns.splice(index, 1);
    table.rebuildColIndex();
    for (const row of table.rows.values()) row.values.splice(index, 1);
    table.clearEqualityHashes();
    env.state.schemaVersion++;
  }
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeDropTable(stmt: DropTableStmt, env: ExecutionEnv): ResultSet {
  env.state.dropTable(stmt.name, stmt.ifExists);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeDropIndex(stmt: DropIndexStmt, env: ExecutionEnv): ResultSet {
  env.state.dropIndex(stmt.name, stmt.ifExists);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeCreateView(stmt: CreateViewStmt, env: ExecutionEnv): ResultSet {
  env.state.createView(stmt, env.statementSql ? normalizeMasterSql(env.statementSql) : null);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeDropView(stmt: DropViewStmt, env: ExecutionEnv): ResultSet {
  env.state.dropView(stmt.name, stmt.ifExists);
  return emptyResult(0, env.state.lastInsertRowid);
}

function renameConstraintColumn(
  constraint: import("../ast/nodes.ts").TableConstraint,
  oldName: string,
  newName: string,
): void {
  if (constraint.type === "primary_key" || constraint.type === "unique") {
    for (const column of constraint.columns)
      if (column.name.toLowerCase() === oldName.toLowerCase()) column.name = newName;
  } else if (constraint.type === "foreign_key") {
    constraint.columns = constraint.columns.map((name) =>
      name.toLowerCase() === oldName.toLowerCase() ? newName : name,
    );
  }
}
