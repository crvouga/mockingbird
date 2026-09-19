import type { ReindexStmt, Statement } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { assertUnreachable } from "../runtime/assert.ts";
import { heapRowCells, rebuildIndexFromTable } from "../indexes/keys.ts";
import type { DatabaseState, IndexInfo } from "../storage/database-state.ts";
import { executeAttach, executeDetach } from "./attach.ts";
import {
  executeAlterTable,
  executeCreateIndex,
  executeCreateTable,
  executeCreateView,
  executeDropIndex,
  executeDropTable,
  executeDropView,
} from "./ddl.ts";
import { checkDeferredForeignKeys, executeDelete, executeInsert, executeUpdate } from "./dml.ts";
import type { ExecutionEnv } from "./env.ts";
import { executePragma } from "./pragma.ts";
import { emptyResult, type ResultSet, valuesToResult } from "./result.ts";
import { executeSelect } from "./select.ts";
import { executeCreateTrigger, executeDropTrigger } from "./triggers.ts";
import { executeCreateVirtualTable } from "./vtable.ts";

export function executeStatement(stmt: Statement, env: ExecutionEnv): ResultSet {
  env.selectRunner = executeSelect;
  switch (stmt.type) {
    case "select":
      return executeSelect(stmt, env);
    case "insert":
      return executeInsert(stmt, env);
    case "update":
      return executeUpdate(stmt, env);
    case "delete":
      return executeDelete(stmt, env);
    case "create_table":
      return executeCreateTable(stmt, env);
    case "drop_table":
      return executeDropTable(stmt, env);
    case "alter_table":
      return executeAlterTable(stmt, env);
    case "create_index":
      return executeCreateIndex(stmt, env);
    case "drop_index":
      return executeDropIndex(stmt, env);
    case "create_view":
      return executeCreateView(stmt, env);
    case "drop_view":
      return executeDropView(stmt, env);
    case "create_trigger":
      return executeCreateTrigger(stmt, env);
    case "drop_trigger":
      return executeDropTrigger(stmt, env);
    case "create_virtual_table":
      return executeCreateVirtualTable(stmt, env);
    case "attach":
      return executeAttach(stmt, env);
    case "detach":
      return executeDetach(stmt, env);
    case "begin":
      env.transactions.begin();
      return emptyResult(0, env.state.lastInsertRowid);
    case "commit":
      checkDeferredForeignKeys(env);
      env.transactions.commit();
      return emptyResult(0, env.state.lastInsertRowid);
    case "rollback":
      env.transactions.rollback(stmt.savepoint ?? undefined);
      return emptyResult(0, env.state.lastInsertRowid);
    case "savepoint":
      env.transactions.savepoint(stmt.name);
      return emptyResult(0, env.state.lastInsertRowid);
    case "release":
      env.transactions.release(stmt.name);
      return emptyResult(0, env.state.lastInsertRowid);
    case "pragma":
      return executePragma(stmt.name, stmt.value, env);
    case "explain":
      return valuesToResult(
        stmt.queryPlan
          ? ["id", "parent", "notused", "detail"]
          : ["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment"],
        stmt.queryPlan
          ? [[0, 0, 0, `EXECUTE ${stmt.statement.type.toUpperCase()}`]]
          : [[0, "Execute", 0, 0, 0, stmt.statement.type, 0, null]],
        0,
        env.state.lastInsertRowid,
      );
    case "analyze":
      return executeAnalyze(stmt, env);
    case "reindex":
      return executeReindex(stmt, env);
    case "vacuum":
      // :memory: VACUUM is a successful no-op (matches bun:sqlite).
      env.state.recordChange(0);
      return emptyResult(0, env.state.lastInsertRowid);
    default:
      return assertUnreachable(stmt);
  }
}

function executeReindex(stmt: ReindexStmt, env: ExecutionEnv): ResultSet {
  const targets = resolveReindexTargets(stmt, env);
  for (const { db, index } of targets) rebuildOneIndex(env, db, index);
  env.state.recordChange(0);
  return emptyResult(0, env.state.lastInsertRowid);
}

function resolveReindexTargets(stmt: ReindexStmt, env: ExecutionEnv): Array<{ db: DatabaseState; index: IndexInfo }> {
  if (stmt.name === null) {
    return allDatabaseStates(env.state).flatMap((db) => [...db.indexes.values()].map((index) => ({ db, index })));
  }
  const name = stmt.name;
  const collation = builtinCollationName(name);
  // SQLite: collation-name wins over a table/index of the same name when un-qualified.
  if (stmt.schema === null && collation) {
    return allDatabaseStates(env.state).flatMap((db) =>
      [...db.indexes.values()].filter((index) => indexUsesCollation(index, collation)).map((index) => ({ db, index })),
    );
  }
  const db = env.state.databaseForSchema(stmt.schema, stmt.schema ? `${stmt.schema}.${name}` : name);
  const table = db.tables.get(name.toLowerCase());
  if (table) {
    return table.indexes
      .map((indexName) => db.indexes.get(indexName.toLowerCase()))
      .filter((index): index is IndexInfo => index !== undefined)
      .map((index) => ({ db, index }));
  }
  const index = db.indexes.get(name.toLowerCase());
  if (index) return [{ db, index }];
  throw new SqliteError(`unable to identify the object to be reindexed: ${qualifiedReindexName(stmt)}`, "other");
}

function rebuildOneIndex(env: ExecutionEnv, db: DatabaseState, index: IndexInfo): void {
  const table = db.tables.get(index.tableName.toLowerCase());
  if (!table) return;
  const writable = db.ensureWritableIndex(index);
  rebuildIndexFromTable(writable, table, (row) =>
    env.createEvalContext({ rowid: row.rowid, sourceTable: table.name, cells: heapRowCells(table, row, env) }),
  );
}

function allDatabaseStates(root: DatabaseState): DatabaseState[] {
  return [root, ...[...root.attached.values()].map((entry) => entry.state)];
}

function indexUsesCollation(index: IndexInfo, collation: string): boolean {
  return index.columns.some((column) => (column.collate ?? "BINARY").toUpperCase() === collation);
}

function builtinCollationName(name: string): "BINARY" | "NOCASE" | "RTRIM" | null {
  const upper = name.toUpperCase();
  if (upper === "BINARY" || upper === "NOCASE" || upper === "RTRIM") return upper;
  return null;
}

function qualifiedReindexName(stmt: ReindexStmt): string {
  return stmt.schema ? `${stmt.schema}.${stmt.name}` : (stmt.name ?? "");
}

function executeAnalyze(stmt: import("../ast/nodes.ts").AnalyzeStmt, env: ExecutionEnv): ResultSet {
  // Populate sqlite_stat1 with simple row counts for oracle-visible ANALYZE behavior.
  let stat = env.state.tables.get("sqlite_stat1");
  if (!stat) {
    env.state.createTable(
      {
        type: "create_table",
        ifNotExists: true,
        temp: false,
        name: "sqlite_stat1",
        columns: [
          { name: "tbl", typeName: "TEXT", constraints: [] },
          { name: "idx", typeName: "TEXT", constraints: [] },
          { name: "stat", typeName: "TEXT", constraints: [] },
        ],
        constraints: [],
        asSelect: null,
        withoutRowid: false,
        strict: false,
      },
      "CREATE TABLE sqlite_stat1(tbl,idx,stat)",
    );
    stat = env.state.tables.get("sqlite_stat1");
  }
  if (stat) {
    for (const row of [...stat.scan()]) {
      stat.delete(row.rowid);
    }
    const tables = [...env.state.tables.values()].filter((t) => t.name.toLowerCase() !== "sqlite_stat1");
    const targets = stmt.name ? tables.filter((t) => t.name.toLowerCase() === stmt.name!.toLowerCase()) : tables;
    for (const table of targets) {
      const rowCount = [...table.scan()].length;
      const indexes = [...env.state.indexes.values()].filter(
        (i) => i.tableName.toLowerCase() === table.name.toLowerCase(),
      );
      if (indexes.length === 0) {
        stat.insert(
          new Map<string, import("../types/value.ts").SqlValue>([
            ["tbl", table.name],
            ["idx", null],
            ["stat", String(rowCount)],
          ]),
        );
      } else {
        for (const index of indexes) {
          stat.insert(
            new Map<string, import("../types/value.ts").SqlValue>([
              ["tbl", table.name],
              ["idx", index.name],
              ["stat", `${rowCount} ${Math.max(1, Math.floor(rowCount / 2))}`],
            ]),
          );
        }
      }
    }
  }
  env.state.recordChange(0);
  return emptyResult(0, env.state.lastInsertRowid);
}
