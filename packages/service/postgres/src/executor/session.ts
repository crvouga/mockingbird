import type {
  CopyStmt,
  DeallocateStmt,
  ExecuteStmt,
  ExplainStmt,
  Expr,
  InsertStmt,
  PrepareStmt,
  ResetStmt,
  SetStmt,
  ShowStmt,
  TransactionStmt,
} from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { Prng } from "../runtime/prng.ts";
import { DatabaseState } from "../storage/database-state.ts";
import { TransactionManager } from "../transactions/manager.ts";
import { castTo } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import { type Datum, datumText, tv, UNKNOWN } from "../types/value.ts";
import { executeInsert } from "./dml.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";
import { evalScalar, executeSelectStmt, runStatement } from "./select.ts";

// ---------------------------------------------------------------------------
// transaction manager registry (one per database state)
// ---------------------------------------------------------------------------

const txManagers = new WeakMap<DatabaseState, TransactionManager>();

export function txManagerFor(state: DatabaseState): TransactionManager {
  let tx = txManagers.get(state);
  if (!tx) {
    tx = new TransactionManager(state);
    txManagers.set(state, tx);
  }
  return tx;
}

export function executeTransaction(env: ExecEnv, stmt: TransactionStmt): ExecResult {
  const tx = txManagerFor(env.ctx.state);
  switch (stmt.action) {
    case "begin":
      tx.begin();
      return commandResult("BEGIN", 0);
    case "commit":
      tx.commit();
      return commandResult("COMMIT", 0);
    case "rollback":
      tx.rollback();
      return commandResult("ROLLBACK", 0);
    case "savepoint":
      tx.savepoint(stmt.savepointName!);
      return commandResult("SAVEPOINT", 0);
    case "release":
      tx.releaseSavepoint(stmt.savepointName!);
      return commandResult("RELEASE", 0);
    case "rollback_to":
      tx.rollbackToSavepoint(stmt.savepointName!);
      return commandResult("ROLLBACK", 0);
  }
}

// ---------------------------------------------------------------------------
// SET / SHOW / RESET
// ---------------------------------------------------------------------------

let defaultSettings: Map<string, string> | null = null;

function getDefaultSettings(): Map<string, string> {
  if (!defaultSettings) {
    const probe = new DatabaseState(new Prng(1), () => new Date(0));
    defaultSettings = new Map(probe.settings);
  }
  return defaultSettings;
}

function canonicalGucName(name: string): string {
  const n = name.toLowerCase();
  if (n === "time zone" || n === "timezone") return "timezone";
  if (n === "session characteristics as transaction isolation level") return "transaction_isolation";
  return n;
}

/** display name PG uses in SHOW output */
function showColumnName(guc: string): string {
  switch (guc) {
    case "timezone":
      return "TimeZone";
    case "datestyle":
      return "DateStyle";
    case "intervalstyle":
      return "IntervalStyle";
    default:
      return guc;
  }
}

function isKnownGuc(name: string): boolean {
  return getDefaultSettings().has(name) || name.includes(".");
}

export function executeSet(env: ExecEnv, stmt: SetStmt): ExecResult {
  const state = env.ctx.state;
  const name = canonicalGucName(stmt.name);
  if (!isKnownGuc(name) && !state.settings.has(name)) {
    throw pgError("undefined_object", `unrecognized configuration parameter "${stmt.name}"`, "42704");
  }
  const target = stmt.local ? state.localSettings : state.settings;
  if (stmt.local && !txManagerFor(state).inTransaction) {
    // SET LOCAL outside a transaction is a no-op with a warning in PG
    return commandResult("SET", 0);
  }
  if (stmt.value === null) {
    // SET x TO DEFAULT
    const dflt = getDefaultSettings().get(name);
    if (dflt !== undefined) target.set(name, dflt);
    else target.delete(name);
    return commandResult("SET", 0);
  }
  target.set(name, stmt.value);
  return commandResult("SET", 0);
}

export function executeShow(env: ExecEnv, stmt: ShowStmt): ExecResult {
  const state = env.ctx.state;
  const name = canonicalGucName(stmt.name);
  if (name === "all") {
    const rows: Datum[][] = [...state.settings.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => [k, state.localSettings.get(k) ?? v, ""]);
    return {
      columns: [
        { name: "name", type: "text" },
        { name: "setting", type: "text" },
        { name: "description", type: "text" },
      ],
      rows,
      command: "SHOW",
      rowCount: rows.length,
    };
  }
  const value = state.getSetting(name);
  if (value === undefined) {
    throw pgError("undefined_object", `unrecognized configuration parameter "${stmt.name}"`, "42704");
  }
  return {
    columns: [{ name: showColumnName(name), type: "text" }],
    rows: [[value]],
    command: "SHOW",
    rowCount: 1,
  };
}

export function executeReset(env: ExecEnv, stmt: ResetStmt): ExecResult {
  const state = env.ctx.state;
  const name = canonicalGucName(stmt.name);
  if (name === "all") {
    state.settings = new Map(getDefaultSettings());
    state.localSettings.clear();
    return commandResult("RESET", 0);
  }
  if (!isKnownGuc(name) && !state.settings.has(name)) {
    throw pgError("undefined_object", `unrecognized configuration parameter "${stmt.name}"`, "42704");
  }
  const dflt = getDefaultSettings().get(name);
  if (dflt !== undefined) state.settings.set(name, dflt);
  else state.settings.delete(name);
  state.localSettings.delete(name);
  return commandResult("RESET", 0);
}

// ---------------------------------------------------------------------------
// PREPARE / EXECUTE / DEALLOCATE
// ---------------------------------------------------------------------------

export function executePrepare(env: ExecEnv, stmt: PrepareStmt): ExecResult {
  const state = env.ctx.state;
  if (state.prepared.has(stmt.name)) {
    throw pgError("duplicate_prepared_statement", `prepared statement "${stmt.name}" already exists`, "42P05");
  }
  state.prepared.set(stmt.name, {
    name: stmt.name,
    argTypes: stmt.argTypes ? stmt.argTypes.map((t) => resolveTypeName(state, t).column.id) : null,
    stmt: stmt.query,
  });
  return commandResult("PREPARE", 0);
}

export function executeExecute(env: ExecEnv, stmt: ExecuteStmt): ExecResult {
  const state = env.ctx.state;
  const prep = state.prepared.get(stmt.name);
  if (!prep) {
    throw pgError("undefined_prepared_statement", `prepared statement "${stmt.name}" does not exist`, "26000");
  }
  const params = stmt.params.map((e, i) => {
    const v = evalScalar(env, null, e);
    const t = prep.argTypes?.[i];
    if (t) return castTo(env.ctx, v, t, {});
    return v.t === UNKNOWN ? tv("text", v.v) : v;
  });
  if (prep.argTypes && params.length !== prep.argTypes.length) {
    throw pgError("syntax", `wrong number of parameters for prepared statement "${stmt.name}"`, "42601");
  }
  const execEnv: ExecEnv = { ctx: env.ctx, params, ctes: new Map(), outer: null };
  return runStatement(execEnv, prep.stmt);
}

export function executeDeallocate(env: ExecEnv, stmt: DeallocateStmt): ExecResult {
  const state = env.ctx.state;
  if (stmt.name === null) {
    state.prepared.clear();
    return commandResult("DEALLOCATE ALL", 0);
  }
  if (!state.prepared.delete(stmt.name)) {
    throw pgError("undefined_prepared_statement", `prepared statement "${stmt.name}" does not exist`, "26000");
  }
  return commandResult("DEALLOCATE", 0);
}

// ---------------------------------------------------------------------------
// EXPLAIN (stub plans, documented divergence) / COPY
// ---------------------------------------------------------------------------

export function executeExplain(env: ExecEnv, stmt: ExplainStmt): ExecResult {
  if (stmt.analyze) {
    runStatement(env, stmt.query);
  }
  const kind = stmt.query.type === "select" ? "Seq Scan" : "ModifyTable";
  const lines = [`${kind}  (cost=0.00..0.00 rows=0 width=0)`];
  return {
    columns: [{ name: "QUERY PLAN", type: "text" }],
    rows: lines.map((l) => [l]),
    command: "EXPLAIN",
    rowCount: lines.length,
  };
}

/** text-format COPY escaping */
function copyEscape(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
}

export function executeCopy(env: ExecEnv, stmt: CopyStmt): ExecResult {
  const format = String(stmt.options.format ?? "text").toLowerCase();
  if (format !== "text" && format !== "csv") {
    throw unsupported(`COPY format ${format}`);
  }
  if (stmt.direction === "to") {
    let columns: Array<{ name: string; type: import("../types/value.ts").TypeId }>;
    let rows: Datum[][];
    if (stmt.query) {
      const res = runStatement(env, stmt.query);
      columns = res.columns;
      rows = res.rows;
    } else {
      const table = env.ctx.state.findTable(stmt.table!);
      if (!table) {
        throw pgError("undefined_table", `relation "${stmt.table!.join(".")}" does not exist`, "42P01");
      }
      const idxs = stmt.columns
        ? stmt.columns.map((c) => {
            const i = table.columnIndex(c);
            if (i === -1) {
              throw pgError("undefined_column", `column "${c}" of relation "${table.name}" does not exist`, "42703");
            }
            return i;
          })
        : table.columns.map((_, i) => i);
      columns = idxs.map((i) => ({ name: table.columns[i]!.name, type: table.columns[i]!.type.id }));
      rows = Array.from({ length: table.rowCount() }, (_, i) => idxs.map((j) => table.rowAt(i)[j] ?? null));
    }
    const delim = format === "csv" ? "," : "\t";
    const nullStr = String(stmt.options.null ?? (format === "csv" ? "" : "\\N"));
    const lines = rows.map((r) =>
      r
        .map((v, i) => {
          if (v === null) return nullStr;
          const text = datumText(columns[i]!.type === UNKNOWN ? "text" : columns[i]!.type, v, env.ctx);
          if (format === "csv") {
            return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
          }
          return copyEscape(text);
        })
        .join(delim),
    );
    return {
      columns: [{ name: "copy", type: "text" }],
      rows: lines.map((l) => [l]),
      command: `COPY ${rows.length}`,
      rowCount: rows.length,
    };
  }
  // COPY FROM stdin: data arrives via the API-level hook (Database.copyFrom)
  throw unsupported("COPY FROM STDIN without api-provided data");
}

/** Unescape one text-format COPY field. */
function copyUnescape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case undefined:
        break;
      default:
        out += n;
    }
  }
  return out;
}

function parseCsvLine(line: string, delim: string, quote: string): (string | { quoted: string })[] {
  const fields: (string | { quoted: string })[] = [];
  let i = 0;
  while (true) {
    if (line[i] === quote) {
      let val = "";
      i++;
      for (;;) {
        if (i >= line.length) throw pgError("invalid_text_representation", "unterminated CSV quoted field", "22P04");
        if (line[i] === quote) {
          if (line[i + 1] === quote) {
            val += quote;
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          val += line[i];
          i++;
        }
      }
      fields.push({ quoted: val });
    } else {
      let val = "";
      while (i < line.length && line[i] !== delim) {
        val += line[i];
        i++;
      }
      fields.push(val);
    }
    if (i >= line.length) break;
    i++; // skip delimiter
  }
  return fields;
}

/**
 * Execute COPY ... FROM STDIN with api-provided text/csv data by synthesizing
 * an INSERT (reuses defaults, identity, constraints, FK actions, triggers).
 */
export function executeCopyFromData(env: ExecEnv, stmt: CopyStmt, data: string): ExecResult {
  const format = String(stmt.options.format ?? "text").toLowerCase();
  if (format !== "text" && format !== "csv") throw unsupported(`COPY format ${format}`);
  if (stmt.direction !== "from" || stmt.table === null) {
    throw pgError("syntax", "COPY FROM requires a table", "42601");
  }
  const delim = String(stmt.options.delimiter ?? (format === "csv" ? "," : "\t"));
  const nullStr = String(stmt.options.null ?? (format === "csv" ? "" : "\\N"));
  const quote = String(stmt.options.quote ?? '"');
  const header = stmt.options.header === true || String(stmt.options.header ?? "").toLowerCase() === "true";

  let lines = data.split(/\r?\n/);
  // trailing newline yields an empty last line; "\." terminates the stream
  const endMarker = lines.indexOf("\\.");
  if (endMarker !== -1) lines = lines.slice(0, endMarker);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
  if (header && lines.length > 0) lines = lines.slice(1);

  const valueRows: Expr[][] = lines.map((line) => {
    let cells: Expr[];
    if (format === "csv") {
      cells = parseCsvLine(line, delim, quote).map((f) => {
        if (typeof f !== "string") return { type: "string_lit", value: f.quoted } as Expr;
        if (f === nullStr) return { type: "null_lit" } as Expr;
        return { type: "string_lit", value: f } as Expr;
      });
    } else {
      cells = line.split(delim).map((f) => {
        if (f === nullStr) return { type: "null_lit" } as Expr;
        return { type: "string_lit", value: copyUnescape(f) } as Expr;
      });
    }
    return cells;
  });

  const insert: InsertStmt = {
    type: "insert",
    with: null,
    table: stmt.table,
    alias: null,
    columns: stmt.columns,
    overriding: null,
    source: {
      type: "select",
      with: null,
      body: { type: "values", rows: valueRows },
      orderBy: [],
      limit: null,
      limitWithTies: false,
      offset: null,
      lockingClause: null,
    },
    onConflict: null,
    returning: null,
  };
  const res = executeInsert(env, insert);
  return {
    columns: [],
    rows: [],
    command: `COPY ${res.rowCount}`,
    rowCount: res.rowCount,
  };
}

// re-export for the api layer
export { executeSelectStmt };
