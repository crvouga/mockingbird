/**
 * Shared PRAGMA query engine used by statement-form `PRAGMA …` and `pragma_*` TVFs.
 */
import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { aggregateFunctions } from "../functions/aggregate.ts";
import { dateTimeFunctions } from "../functions/datetime.ts";
import { ftsAuxFunctions, rtreeAuxFunctions } from "../functions/extensions.ts";
import { jsonAggregateFunctions, jsonScalarFunctions } from "../functions/json.ts";
import { mathFunctions } from "../functions/math.ts";
import { getScalarFunctions } from "../functions/scalar.ts";
import { windowFunctions } from "../functions/window.ts";
import type { IndexInfo } from "../storage/database-state.ts";
import type { Table } from "../storage/table.ts";
import { isTruthySql, type SqlValue, toInteger } from "../types/value.ts";
import type { ExecutionEnv } from "./env.ts";

export interface PragmaQueryResult {
  columns: string[];
  rows: SqlValue[][];
}

/** Oracle-exposed pragma_* TVF base names (without the `pragma_` prefix). */
export const PRAGMA_TVF_NAMES = [
  "analysis_limit",
  "application_id",
  "auto_vacuum",
  "automatic_index",
  "busy_timeout",
  "cache_size",
  "cache_spill",
  "cell_size_check",
  "checkpoint_fullfsync",
  "collation_list",
  "compile_options",
  "count_changes",
  "data_version",
  "database_list",
  "default_cache_size",
  "defer_foreign_keys",
  "empty_result_callbacks",
  "encoding",
  "foreign_key_check",
  "foreign_key_list",
  "foreign_keys",
  "freelist_count",
  "full_column_names",
  "fullfsync",
  "function_list",
  "hard_heap_limit",
  "ignore_check_constraints",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "journal_mode",
  "journal_size_limit",
  "legacy_alter_table",
  "locking_mode",
  "max_page_count",
  "module_list",
  "optimize",
  "page_count",
  "page_size",
  "pragma_list",
  "query_only",
  "quick_check",
  "read_uncommitted",
  "recursive_triggers",
  "reverse_unordered_selects",
  "schema_version",
  "secure_delete",
  "short_column_names",
  "soft_heap_limit",
  "synchronous",
  "table_info",
  "table_list",
  "table_xinfo",
  "temp_store",
  "threads",
  "trusted_schema",
  "user_version",
  "writable_schema",
] as const;

/** Full pragma name list for `pragma_pragma_list` (includes names without TVFs). */
export const PRAGMA_LIST_NAMES = [
  "activate_extensions",
  ...PRAGMA_TVF_NAMES,
  "case_sensitive_like",
  "hexkey",
  "hexrekey",
  "incremental_vacuum",
  "key",
  "lock_proxy_file",
  "mmap_size",
  "rekey",
  "shrink_memory",
  "temp_store_directory",
  "textkey",
  "textrekey",
  "wal_autocheckpoint",
  "wal_checkpoint",
].sort((a, b) => a.localeCompare(b));

const MEMORY_VTABLE_MODULES = [
  "bytecode",
  "dbstat",
  "fts3",
  "fts3tokenize",
  "fts4",
  "fts4aux",
  "fts5",
  "fts5vocab",
  "json_each",
  "json_tree",
  "rtree",
  "rtree_i32",
  "tables_used",
];

const COMPILE_OPTIONS = [
  "COMPILER=typescript",
  "ENABLE_FTS3",
  "ENABLE_FTS4",
  "ENABLE_FTS5",
  "ENABLE_JSON1",
  "ENABLE_RTREE",
  "THREADSAFE=0",
];

/** Stable in-memory defaults matching bun:sqlite `:memory:` where applicable. */
const STORAGE_DEFAULTS: Record<string, { column: string; value: SqlValue }> = {
  analysis_limit: { column: "analysis_limit", value: 0 },
  application_id: { column: "application_id", value: 0 },
  auto_vacuum: { column: "auto_vacuum", value: 0 },
  automatic_index: { column: "automatic_index", value: 1 },
  busy_timeout: { column: "timeout", value: 0 },
  cache_size: { column: "cache_size", value: 2000 },
  cache_spill: { column: "cache_spill", value: 20000 },
  cell_size_check: { column: "cell_size_check", value: 0 },
  checkpoint_fullfsync: { column: "checkpoint_fullfsync", value: 1 },
  count_changes: { column: "count_changes", value: 0 },
  data_version: { column: "data_version", value: 1 },
  default_cache_size: { column: "cache_size", value: 2000 },
  defer_foreign_keys: { column: "defer_foreign_keys", value: 0 },
  empty_result_callbacks: { column: "empty_result_callbacks", value: 0 },
  encoding: { column: "encoding", value: "UTF-8" },
  freelist_count: { column: "freelist_count", value: 0 },
  full_column_names: { column: "full_column_names", value: 0 },
  fullfsync: { column: "fullfsync", value: 0 },
  hard_heap_limit: { column: "hard_heap_limit", value: 0 },
  ignore_check_constraints: { column: "ignore_check_constraints", value: 0 },
  journal_mode: { column: "journal_mode", value: "memory" },
  journal_size_limit: { column: "journal_size_limit", value: 32768 },
  legacy_alter_table: { column: "legacy_alter_table", value: 1 },
  locking_mode: { column: "locking_mode", value: "normal" },
  max_page_count: { column: "max_page_count", value: 1073741823 },
  page_size: { column: "page_size", value: 4096 },
  query_only: { column: "query_only", value: 0 },
  read_uncommitted: { column: "read_uncommitted", value: 0 },
  recursive_triggers: { column: "recursive_triggers", value: 0 },
  reverse_unordered_selects: { column: "reverse_unordered_selects", value: 0 },
  secure_delete: { column: "secure_delete", value: 2 },
  short_column_names: { column: "short_column_names", value: 1 },
  soft_heap_limit: { column: "soft_heap_limit", value: 0 },
  synchronous: { column: "synchronous", value: 2 },
  temp_store: { column: "temp_store", value: 0 },
  threads: { column: "threads", value: 0 },
  trusted_schema: { column: "trusted_schema", value: 1 },
  writable_schema: { column: "writable_schema", value: 0 },
};

export function isPragmaTvfName(name: string): boolean {
  const lower = name.toLowerCase();
  if ((PRAGMA_TVF_NAMES as readonly string[]).includes(lower)) return true;
  if (lower.startsWith("pragma_")) {
    return (PRAGMA_TVF_NAMES as readonly string[]).includes(lower.slice("pragma_".length));
  }
  return false;
}

/**
 * Column names for a pragma_* TVF without evaluating arguments.
 * Used by SELECT shape analysis so correlated args (e.g. `tl.name`) are not
 * resolved before the outer row is bound.
 */
export function pragmaTvfColumns(name: string): string[] | null {
  const key = normalizePragmaKey(name);
  switch (key) {
    case "foreign_keys":
      return ["foreign_keys"];
    case "user_version":
      return ["user_version"];
    case "schema_version":
      return ["schema_version"];
    case "table_info":
      return ["cid", "name", "type", "notnull", "dflt_value", "pk"];
    case "table_xinfo":
      return ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"];
    case "index_list":
      return ["seq", "name", "unique", "origin", "partial"];
    case "index_info":
      return ["seqno", "cid", "name"];
    case "index_xinfo":
      return ["seqno", "cid", "name", "desc", "coll", "key"];
    case "foreign_key_list":
      return ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"];
    case "foreign_key_check":
      return ["table", "rowid", "parent", "fkid"];
    case "database_list":
      return ["seq", "name", "file"];
    case "table_list":
      return ["schema", "name", "type", "ncol", "wr", "strict"];
    case "collation_list":
      return ["seq", "name"];
    case "compile_options":
      return ["compile_options"];
    case "function_list":
      return ["name", "builtin", "type", "enc", "narg", "flags"];
    case "module_list":
    case "pragma_list":
      return ["name"];
    case "integrity_check":
    case "quick_check":
      return [key];
    case "optimize":
      return ["optimize"];
    case "page_count":
      return ["page_count"];
    default: {
      const storage = STORAGE_DEFAULTS[key];
      if (storage) return [storage.column];
      return null;
    }
  }
}

function normalizePragmaKey(name: string): string {
  const lower = name.toLowerCase();
  if ((PRAGMA_TVF_NAMES as readonly string[]).includes(lower)) return lower;
  if (lower.startsWith("pragma_")) {
    const stripped = lower.slice("pragma_".length);
    if ((PRAGMA_TVF_NAMES as readonly string[]).includes(stripped)) return stripped;
    return stripped;
  }
  return lower;
}

/**
 * Query a pragma by name with optional SQL values (TVF args or evaluated statement args).
 * Read-only — writers stay in {@link executePragma}.
 */
export function queryPragma(name: string, args: readonly SqlValue[], env: ExecutionEnv): PragmaQueryResult {
  const key = normalizePragmaKey(name);

  switch (key) {
    case "foreign_keys":
      return single("foreign_keys", env.state.foreignKeysEnabled ? 1 : 0);
    case "case_sensitive_like":
      return single("case_sensitive_like", env.state.caseSensitiveLike ? 1 : 0);
    case "user_version":
      return single("user_version", env.state.userVersion);
    case "schema_version":
      return single("schema_version", env.state.schemaVersion);
    case "table_info":
      return pragmaTableInfo(args, env, false);
    case "table_xinfo":
      return pragmaTableInfo(args, env, true);
    case "index_list":
      return pragmaIndexList(args, env);
    case "index_info":
      return pragmaIndexInfo(args, env, false);
    case "index_xinfo":
      return pragmaIndexInfo(args, env, true);
    case "foreign_key_list":
      return pragmaForeignKeyList(args, env);
    case "foreign_key_check":
      return pragmaForeignKeyCheck(args, env);
    case "database_list":
      return pragmaDatabaseList(env);
    case "table_list":
      return pragmaTableList(env);
    case "collation_list":
      return {
        columns: ["seq", "name"],
        rows: [
          [0, "RTRIM"],
          [1, "NOCASE"],
          [2, "BINARY"],
        ],
      };
    case "compile_options":
      return { columns: ["compile_options"], rows: COMPILE_OPTIONS.map((opt) => [opt]) };
    case "function_list":
      return pragmaFunctionList();
    case "module_list":
      return pragmaModuleList();
    case "pragma_list":
      return { columns: ["name"], rows: PRAGMA_LIST_NAMES.map((n) => [n]) };
    case "integrity_check":
    case "quick_check":
      return single(key, "ok");
    case "optimize":
      return { columns: ["optimize"], rows: [] };
    case "page_count":
      return single("page_count", estimatePageCount(env));
    default: {
      const storage = STORAGE_DEFAULTS[key];
      if (storage) return single(storage.column, storage.value);
      return { columns: [], rows: [] };
    }
  }
}

function single(column: string, value: SqlValue): PragmaQueryResult {
  return { columns: [column], rows: [[value]] };
}

function estimatePageCount(env: ExecutionEnv): number {
  const objects = env.state.tables.size + env.state.indexes.size + env.state.views.size + env.state.virtualTables.size;
  return objects === 0 ? 0 : Math.max(1, objects);
}

function pragmaTableInfo(args: readonly SqlValue[], env: ExecutionEnv, xinfo: boolean): PragmaQueryResult {
  const tableName = requireNameArg(args, "table_info");
  const table = env.state.tables.get(tableName.toLowerCase());
  if (!table) return { columns: xinfoColumns(xinfo), rows: [] };
  // SQLite's table_info omits generated columns; table_xinfo includes them (hidden 2/3).
  const visible = xinfo ? table.columns : table.columns.filter((column) => !column.generated);
  const rows: SqlValue[][] = visible.map((column, cid) => {
    const pkIndex = table.columns.filter((c) => c.primaryKey).findIndex((c) => c.name === column.name);
    const pk = column.primaryKey ? (pkIndex >= 0 ? pkIndex + 1 : 1) : 0;
    const dflt = column.defaultExpr ? defaultLiteral(column.defaultExpr) : null;
    // WITHOUT ROWID primary keys are NOT NULL in SQLite's table_info.
    const notNull = column.notNull || (table.withoutRowid && column.primaryKey) ? 1 : 0;
    const base: SqlValue[] = [cid, column.name, column.typeName ?? "", notNull, dflt, pk];
    if (xinfo) {
      let hidden = 0;
      if (column.generated && !column.generated.stored) hidden = 2;
      if (column.generated?.stored) hidden = 3;
      base.push(hidden);
    }
    return base;
  });
  return { columns: xinfoColumns(xinfo), rows };
}

function xinfoColumns(xinfo: boolean): string[] {
  return xinfo
    ? ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]
    : ["cid", "name", "type", "notnull", "dflt_value", "pk"];
}

function defaultLiteral(expr: Expr): SqlValue {
  if (expr.type === "literal")
    return typeof expr.value === "string" ? `'${expr.value.replace(/'/g, "''")}'` : expr.value;
  if (expr.type === "null") return "NULL";
  return null;
}

function pragmaIndexList(args: readonly SqlValue[], env: ExecutionEnv): PragmaQueryResult {
  const tableName = requireNameArg(args, "index_list");
  const table = env.state.tables.get(tableName.toLowerCase());
  if (!table) return { columns: ["seq", "name", "unique", "origin", "partial"], rows: [] };
  const rows: SqlValue[][] = [];
  let seq = 0;
  for (const name of table.indexes) {
    const index = env.state.indexes.get(name.toLowerCase());
    if (!index) continue;
    rows.push([seq++, index.name, index.unique ? 1 : 0, indexOrigin(index), index.where ? 1 : 0]);
  }
  return { columns: ["seq", "name", "unique", "origin", "partial"], rows };
}

function indexOrigin(index: IndexInfo): string {
  if (index.originalSql) return "c";
  if (index.name.toLowerCase().startsWith("sqlite_autoindex_") && index.unique) return "u";
  return "c";
}

function pragmaIndexInfo(args: readonly SqlValue[], env: ExecutionEnv, xinfo: boolean): PragmaQueryResult {
  const indexName = requireNameArg(args, "index_info");
  const index = env.state.indexes.get(indexName.toLowerCase());
  const columns = xinfo ? ["seqno", "cid", "name", "desc", "coll", "key"] : ["seqno", "cid", "name"];
  if (!index) return { columns, rows: [] };
  const table = env.state.tables.get(index.tableName.toLowerCase());
  const rows: SqlValue[][] = index.columns.map((column, seqno) => {
    const cid = table?.columns.findIndex((c) => c.name.toLowerCase() === column.name.toLowerCase()) ?? -1;
    const base: SqlValue[] = [seqno, cid, column.name];
    if (xinfo) {
      base.push(column.order === "DESC" ? 1 : 0, (column.collate ?? "BINARY").toUpperCase(), 1);
    }
    return base;
  });
  if (xinfo) {
    // Trailing rowid key column (SQLite index_xinfo)
    rows.push([index.columns.length, -1, null, 0, "BINARY", 0]);
  }
  return { columns, rows };
}

function pragmaForeignKeyList(args: readonly SqlValue[], env: ExecutionEnv): PragmaQueryResult {
  const tableName = requireNameArg(args, "foreign_key_list");
  const table = env.state.tables.get(tableName.toLowerCase());
  const columns = ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"];
  if (!table) return { columns, rows: [] };
  const rows: SqlValue[][] = [];
  let id = 0;
  for (const constraint of table.constraints) {
    if (constraint.type !== "foreign_key") continue;
    const refColumns =
      constraint.refColumns ??
      env.state.tables
        .get(constraint.refTable.toLowerCase())
        ?.columns.filter((c) => c.primaryKey)
        .map((c) => c.name) ??
      [];
    constraint.columns.forEach((column, seq) => {
      rows.push([
        id,
        seq,
        constraint.refTable,
        column,
        refColumns[seq] ?? null,
        constraint.onUpdate ?? "NO ACTION",
        constraint.onDelete ?? "NO ACTION",
        "NONE",
      ]);
    });
    id++;
  }
  return { columns, rows };
}

function pragmaForeignKeyCheck(args: readonly SqlValue[], env: ExecutionEnv): PragmaQueryResult {
  const columns = ["table", "rowid", "parent", "fkid"];
  const filter = args[0] != null && args[0] !== null ? String(args[0]).toLowerCase() : null;
  const rows: SqlValue[][] = [];
  for (const table of env.state.tables.values()) {
    if (filter && table.name.toLowerCase() !== filter) continue;
    let fkid = 0;
    for (const constraint of table.constraints) {
      if (constraint.type !== "foreign_key") continue;
      const parent = env.state.tables.get(constraint.refTable.toLowerCase());
      const refColumns = constraint.refColumns ?? parent?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
      for (const row of table.scan()) {
        let allNull = true;
        const childValues: SqlValue[] = [];
        for (const col of constraint.columns) {
          const value = table.cell(row, col.toLowerCase());
          childValues.push(value);
          if (value !== null) allNull = false;
        }
        // MATCH FULL is parsed but not enforced by SQLite (SIMPLE semantics).
        if (allNull) continue;
        if (!parent || !parentHasMatch(parent, refColumns, childValues)) {
          rows.push([table.name, row.rowid, constraint.refTable, fkid]);
        }
      }
      fkid++;
    }
  }
  return { columns, rows };
}

function parentHasMatch(parent: Table, refColumns: string[], childValues: SqlValue[]): boolean {
  if (refColumns.length === 0) return false;
  for (const row of parent.scan()) {
    let ok = true;
    for (let i = 0; i < refColumns.length; i++) {
      const parentVal = parent.cell(row, refColumns[i]!.toLowerCase());
      if (!sqlValuesEqual(parentVal, childValues[i] ?? null)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function sqlValuesEqual(a: SqlValue, b: SqlValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(a as number | bigint) === BigInt(b as number | bigint);
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;
  return String(a) === String(b);
}

function pragmaDatabaseList(env: ExecutionEnv): PragmaQueryResult {
  const rows: SqlValue[][] = [[0, "main", ""]];
  let seq = 2;
  for (const [name, attached] of env.state.attached) {
    const file = attached.filename === ":memory:" ? "" : attached.filename;
    rows.push([seq++, name, file]);
  }
  return { columns: ["seq", "name", "file"], rows };
}

function pragmaTableList(env: ExecutionEnv): PragmaQueryResult {
  const columns = ["schema", "name", "type", "ncol", "wr", "strict"];
  const rows: SqlValue[][] = [];
  for (const table of env.state.tables.values()) {
    rows.push(["main", table.name, "table", table.columns.length, table.withoutRowid ? 1 : 0, table.strict ? 1 : 0]);
  }
  for (const view of env.state.views.values()) {
    const ncol = view.columns?.length ?? 0;
    rows.push(["main", view.name, "view", ncol, 0, 0]);
  }
  for (const vt of env.state.virtualTables.values()) {
    rows.push(["main", vt.name, "virtual", vt.columns.length, 0, 0]);
  }
  rows.push(["main", "sqlite_schema", "table", 5, 0, 0]);
  rows.push(["temp", "sqlite_temp_schema", "table", 5, 0, 0]);
  for (const [schema] of env.state.attached) {
    rows.push([schema, "sqlite_schema", "table", 5, 0, 0]);
  }
  return { columns, rows };
}

function pragmaFunctionList(): PragmaQueryResult {
  const columns = ["name", "builtin", "type", "enc", "narg", "flags"];
  const rows: SqlValue[][] = [];
  const add = (name: string, type: string, narg: number, flags: number): void => {
    rows.push([name, 1, type, "utf8", narg, flags]);
  };
  for (const name of Object.keys(getScalarFunctions())) add(name, "s", -1, 2099200);
  for (const name of Object.keys(dateTimeFunctions)) add(name, "s", -1, 2099200);
  for (const name of Object.keys(jsonScalarFunctions)) add(name, "s", -1, 2099200);
  for (const name of Object.keys(mathFunctions)) add(name, "s", -1, 2099200);
  for (const name of Object.keys(ftsAuxFunctions)) add(name, "s", -1, 2099200);
  for (const name of Object.keys(rtreeAuxFunctions)) add(name, "s", -1, 2099200);
  for (const name of Object.keys(aggregateFunctions)) {
    add(name, "w", name === "count" ? 0 : 1, 2097152);
    if (name === "count") add(name, "w", 1, 2097152);
  }
  for (const name of Object.keys(jsonAggregateFunctions)) add(name, "w", -1, 2097152);
  for (const name of Object.keys(windowFunctions)) add(name, "w", -1, 2097152);
  for (const name of ["generate_series", "json_each", "json_tree"]) {
    add(name, "s", -1, 2099200);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[4]) - Number(b[4]));
  return { columns, rows };
}

function pragmaModuleList(): PragmaQueryResult {
  const names = new Set<string>([
    ...MEMORY_VTABLE_MODULES,
    ...PRAGMA_TVF_NAMES.map((n) => `pragma_${n}`),
    "generate_series",
    "json_each",
    "json_tree",
  ]);
  return {
    columns: ["name"],
    rows: [...names].sort((a, b) => a.localeCompare(b)).map((name) => [name]),
  };
}

function requireNameArg(args: readonly SqlValue[], pragma: string): string {
  if (args.length === 0 || args[0] == null) {
    throw new SqliteError(`missing pragma argument for ${pragma}`, "misuse");
  }
  const value = args[0];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new SqliteError(`invalid pragma argument for ${pragma}`, "misuse");
}

/** Evaluate a statement-form pragma argument expression to a SQL value list. */
export function evalPragmaArgs(expr: Expr | null, env: ExecutionEnv): SqlValue[] {
  if (expr === null) return [];
  if (expr.type === "column" && expr.table === null) return [expr.name];
  if (expr.type === "literal") return [expr.value as SqlValue];
  return [evalExpr(expr, env.createEvalContext())];
}

export function evalPragmaSetValue(expr: Expr, env: ExecutionEnv): SqlValue {
  if (expr.type === "column" && expr.table === null) {
    const keyword = expr.name.toLowerCase();
    if (keyword === "on" || keyword === "true" || keyword === "yes") return 1;
    if (keyword === "off" || keyword === "false" || keyword === "no") return 0;
    return expr.name;
  }
  return evalExpr(expr, env.createEvalContext());
}

export function coercePragmaInt(value: SqlValue): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  const asInt = toInteger(value);
  return asInt === null ? 0 : typeof asInt === "bigint" ? Number(asInt) : asInt;
}

export function coercePragmaTruthy(value: SqlValue): boolean {
  return isTruthySql(value) === true;
}
