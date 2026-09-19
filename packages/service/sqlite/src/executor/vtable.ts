import type { CreateVirtualTableStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { normalizeMasterSql } from "../schema/master-sql.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { SqlValue } from "../types/value.ts";
import type { Fts5VirtualTable } from "../vtable/fts5.ts";
import type { ExecutionEnv } from "./env.ts";
import { emptyResult, type ResultSet } from "./result.ts";

export function executeCreateVirtualTable(stmt: CreateVirtualTableStmt, env: ExecutionEnv): ResultSet {
  env.state.createVirtualTable(stmt, env.statementSql ? normalizeMasterSql(env.statementSql) : null);
  env.state.recordChange(0);
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeFtsInsert(
  table: Fts5VirtualTable,
  columnNames: string[],
  sourceRows: SqlValue[][],
  env: ExecutionEnv,
): { changes: number; lastInsertRowid: number | bigint } {
  let changes = 0;
  let last = env.state.lastInsertRowid;
  for (const source of sourceRows) {
    if (source.length !== columnNames.length) {
      throw new SqliteError(`${source.length} values for ${columnNames.length} columns`, "other");
    }
    const values = new Map<string, SqlValue>();
    let explicitRowid: number | bigint | undefined;
    for (let i = 0; i < columnNames.length; i++) {
      const name = columnNames[i]!;
      const lower = name.toLowerCase();
      const value = source[i] ?? null;
      if (lower === "rowid" || lower === "_rowid_" || lower === "oid") {
        if (typeof value === "number" || typeof value === "bigint") explicitRowid = value;
        else if (value !== null) explicitRowid = Number(value);
        continue;
      }
      values.set(normalizeColumnName(name), value);
    }
    for (const column of table.columns) {
      const key = normalizeColumnName(column);
      if (!values.has(key) && !columnNames.some((n) => n.toLowerCase() === key)) {
        values.set(key, null);
      }
    }
    const rowid = table.insert(values, explicitRowid);
    // Special commands don't change row counts the same way — still count as a write
    changes++;
    last = rowid;
  }
  return { changes, lastInsertRowid: last };
}

export function executeFtsUpdate(
  table: Fts5VirtualTable,
  updates: Map<string, SqlValue>,
  rowids: Iterable<number | bigint>,
): number {
  let changes = 0;
  for (const rowid of rowids) {
    table.update(rowid, updates);
    changes++;
  }
  return changes;
}

export function executeFtsDelete(table: Fts5VirtualTable, rowids: Iterable<number | bigint>): number {
  let changes = 0;
  for (const rowid of rowids) {
    table.delete(rowid);
    changes++;
  }
  return changes;
}
