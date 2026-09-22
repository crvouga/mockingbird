import type { DatabaseState } from "../storage/database-state.ts";
import { makeColumnInfo, Table } from "../storage/table.ts";
import type { SqlValue } from "../types/value.ts";

export type SchemaObjectType = "table" | "index" | "view" | "trigger";

export interface SchemaCatalogRow {
  type: SchemaObjectType;
  name: string;
  tbl_name: string;
  rootpage: number;
  sql: string | null;
}

export function schemaCatalogRows(state: DatabaseState): SchemaCatalogRow[] {
  const tables = [...state.tables.values()].sort((a, b) => compareNames(a.name, b.name));
  const indexes = [...state.indexes.values()].sort((a, b) => compareNames(a.name, b.name));
  const views = [...state.views.values()].sort((a, b) => compareNames(a.name, b.name));
  const triggers = [...state.triggers.values()].sort((a, b) => compareNames(a.name, b.name));

  const rows: SchemaCatalogRow[] = [];
  let rootpage = 2;

  for (const table of tables) {
    rows.push({
      type: "table",
      name: table.name,
      tbl_name: table.name,
      rootpage: rootpage++,
      sql: table.originalSql,
    });
  }
  for (const index of indexes) {
    rows.push({
      type: "index",
      name: index.name,
      tbl_name: index.tableName,
      rootpage: rootpage++,
      sql: index.originalSql,
    });
  }
  for (const view of views) {
    rows.push({
      type: "view",
      name: view.name,
      tbl_name: view.name,
      rootpage: 0,
      sql: view.originalSql,
    });
  }
  for (const trigger of triggers) {
    rows.push({
      type: "trigger",
      name: trigger.name,
      tbl_name: trigger.tableName,
      rootpage: 0,
      sql: trigger.originalSql,
    });
  }
  return rows;
}

/** Locale-independent UTF-16 code-unit order for stable catalog/snapshot encoding. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildSchemaCatalog(state: DatabaseState, name = "sqlite_schema"): Table {
  const catalog = new Table(name, [
    makeColumnInfo("type", "TEXT"),
    makeColumnInfo("name", "TEXT"),
    makeColumnInfo("tbl_name", "TEXT"),
    makeColumnInfo("rootpage", "INTEGER"),
    makeColumnInfo("sql", "TEXT"),
  ]);

  for (const row of schemaCatalogRows(state)) {
    catalog.insert({
      values: {
        type: row.type,
        name: row.name,
        tbl_name: row.tbl_name,
        rootpage: row.rootpage,
        sql: row.sql,
      } satisfies Record<string, SqlValue>,
    });
  }
  return catalog;
}

export function buildSqliteSchema(state: DatabaseState): Table {
  return buildSchemaCatalog(state, "sqlite_schema");
}

export function buildSqliteMaster(state: DatabaseState): Table {
  return buildSchemaCatalog(state, "sqlite_master");
}
