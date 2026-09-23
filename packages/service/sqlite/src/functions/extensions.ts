import { SqliteError } from "../errors/index.ts";
import type { SqlValue } from "../types/value.ts";
import type { Fts5VirtualTable } from "../vtable/fts5.ts";
import type { FunctionContext, ScalarFunction } from "./registry.ts";

function requireArgs(name: string, args: SqlValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  }
}

function resolveFtsTable(args: SqlValue[], context: FunctionContext, name: string) {
  const first = args[0];
  let tableName: string | null = null;
  if (typeof first === "string") tableName = first;
  else if (context.ftsSourceTable) tableName = context.ftsSourceTable;
  else if (context.ftsMatch) tableName = context.ftsMatch.tableName;
  if (!tableName || !context.getFtsTable) {
    throw new SqliteError(`unable to use function ${name} in the requested context`, "unsupported");
  }
  const table = context.getFtsTable(tableName);
  if (!table) throw new SqliteError(`unable to use function ${name} in the requested context`, "unsupported");
  return table;
}

function columnText(table: Fts5VirtualTable, context: FunctionContext, colIndex: number): string {
  const col = table.columns[colIndex];
  if (!col) return "";
  const rowid = context.ftsMatch?.rowid ?? context.ftsRowid;
  if (rowid === undefined) return "";
  const row = table.rows.get(rowid);
  if (!row) return "";
  const value = row.values.get(col.toLowerCase());
  return value === null || value === undefined ? "" : String(value);
}

/**
 * FTS auxiliary functions. When used with a MATCH cursor they compute real
 * values; without MATCH they mirror SQLite's empty-cursor defaults.
 */
export const ftsAuxFunctions: Readonly<Record<string, ScalarFunction>> = {
  bm25(args, context) {
    requireArgs("bm25", args, 1, 100);
    const table = resolveFtsTable(args, context, "bm25");
    const weights = args.slice(1).map((v) => (typeof v === "number" ? v : Number(v)));
    if (!context.ftsMatch || context.ftsMatch.tableName.toLowerCase() !== table.name.toLowerCase()) {
      return -0;
    }
    return table.bm25(context.ftsMatch, weights.length ? weights : undefined);
  },
  highlight(args, context) {
    requireArgs("highlight", args, 4);
    const table = resolveFtsTable(args, context, "highlight");
    const colIndex = Number(args[1] ?? 0);
    const open = String(args[2] ?? "");
    const close = String(args[3] ?? "");
    if (!context.ftsMatch || context.ftsMatch.tableName.toLowerCase() !== table.name.toLowerCase()) {
      return columnText(table, context, colIndex);
    }
    return table.highlight(context.ftsMatch, colIndex, open, close);
  },
  snippet(args, context) {
    requireArgs("snippet", args, 1, 6);
    const table = resolveFtsTable(args, context, "snippet");
    const colIndex = Number(args[1] ?? 0);
    const open = String(args[2] ?? "<b>");
    const close = String(args[3] ?? "</b>");
    const ellipsis = String(args[4] ?? "...");
    const tokenCount = Number(args[5] ?? 64);
    if (!context.ftsMatch || context.ftsMatch.tableName.toLowerCase() !== table.name.toLowerCase()) {
      return columnText(table, context, colIndex);
    }
    return table.snippet(context.ftsMatch, colIndex, open, close, ellipsis, tokenCount);
  },
  matchinfo(args, context) {
    requireArgs("matchinfo", args, 1, 2);
    const table = resolveFtsTable(args, context, "matchinfo");
    const format = typeof args[1] === "string" ? args[1] : "pcx";
    if (!context.ftsMatch) {
      throw new SqliteError("unable to use function matchinfo in the requested context", "unsupported");
    }
    return table.matchinfo(context.ftsMatch, format);
  },
  offsets(args, context) {
    requireArgs("offsets", args, 1);
    const table = resolveFtsTable(args, context, "offsets");
    if (!context.ftsMatch) {
      throw new SqliteError("unable to use function offsets in the requested context", "unsupported");
    }
    return table.offsets(context.ftsMatch);
  },
};

export const rtreeAuxFunctions: Readonly<Record<string, ScalarFunction>> = {
  rtreecheck(args) {
    requireArgs("rtreecheck", args, 1, 2);
    if (args.length === 1) return "ok";
    throw new SqliteError("SQL logic error", "other");
  },
  rtreenode(args) {
    requireArgs("rtreenode", args, 2);
    return "{}";
  },
  rtreedepth(args) {
    requireArgs("rtreedepth", args, 1);
    return 0;
  },
};
