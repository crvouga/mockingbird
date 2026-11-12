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
import { validateStorageSetting } from "../storage/guc.ts";
import {
  allSettings,
  assertGucSettable,
  gucDef,
  gucDefaultDisplay,
  normalizeGucValue,
  registerConfigurationSetter,
  TRANSACTION_GUCS,
} from "../storage/guc-catalog.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { Prng } from "../runtime/prng.ts";
import { DatabaseState } from "../storage/database-state.ts";
import { TransactionManager } from "../transactions/manager.ts";
import { beforeStatement } from "../transactions/read-only.ts";
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
      if (!tx.inTransaction) {
        tx.begin();
        if (stmt.modes?.length) applyTransactionModes(env.ctx.state, stmt.modes, false);
      }
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

/** The value `RESET` restores: the session's own default when it has one, else the built-in. */
function resetValue(state: DatabaseState, name: string): string | undefined {
  return state.settingDefaults?.get(name) ?? getDefaultSettings().get(name);
}

function canonicalGucName(name: string): string {
  const n = name.toLowerCase();
  if (n === "time zone" || n === "timezone") return "timezone";
  return n;
}

/** The name PostgreSQL reports a parameter by (`TimeZone`, `DateStyle`, `work_mem`). */
function displayGucName(guc: string): string {
  return gucDef(guc)?.name ?? guc;
}

function isKnownGuc(state: DatabaseState, name: string): boolean {
  return gucDef(name) !== undefined || getDefaultSettings().has(name) || state.settings.has(name) || name.includes(".");
}

const activeTransaction = (message: string) => pgError("transaction_state", message, "25001");

/** check_transaction_read_only / _isolation / _deferrable: what may change once the transaction runs. */
function checkTransactionChange(state: DatabaseState, tx: TransactionManager, name: string, value: string): void {
  const current = state.getSetting(name);
  if (name === "transaction_read_only") {
    if (value === "off" && current === "on") {
      if (tx.inSubtransaction)
        throw activeTransaction("cannot set transaction read-write mode inside a read-only transaction");
      if (tx.snapshotTaken) throw activeTransaction("transaction read-write mode must be set before any query");
    }
  } else if (name === "transaction_isolation") {
    if (value !== current) {
      if (tx.snapshotTaken) throw activeTransaction("SET TRANSACTION ISOLATION LEVEL must be called before any query");
      if (tx.inSubtransaction)
        throw activeTransaction("SET TRANSACTION ISOLATION LEVEL must not be called in a subtransaction");
    }
  } else if (name === "transaction_deferrable") {
    if (tx.inSubtransaction)
      throw activeTransaction("SET TRANSACTION [NOT] DEFERRABLE cannot be called within a subtransaction");
    if (tx.snapshotTaken) throw activeTransaction("SET TRANSACTION [NOT] DEFERRABLE must be called before any query");
  }
}

/**
 * `SET`, `SET LOCAL`, `RESET` (value `null`) and `set_config()`: check the parameter and the value
 * the way PostgreSQL does, then store the value `SHOW` prints. Returns that value.
 */
export function applySetting(state: DatabaseState, rawName: string, value: string | null, local: boolean): string {
  const name = canonicalGucName(rawName);
  if (!isKnownGuc(state, name)) {
    throw pgError("undefined_object", `unrecognized configuration parameter "${rawName}"`, "42704");
  }
  const def = gucDef(name);
  const tx = txManagerFor(state);
  const sessionDefault = TRANSACTION_GUCS.get(name);
  let shown: string | undefined;
  if (value === null) {
    shown = sessionDefault !== undefined ? state.getSetting(sessionDefault) : resetValue(state, name);
  } else {
    if (def) {
      assertGucSettable(def);
      shown = normalizeGucValue(def, value);
    } else shown = value;
    validateStorageSetting(name, shown);
  }
  if (sessionDefault !== undefined) {
    // a transaction's characteristics: outside a transaction block there is nothing to change
    if (!tx.inTransaction || shown === undefined) return shown ?? "";
    checkTransactionChange(state, tx, name, shown);
    state.localSettings.set(name, shown);
    return shown;
  }
  if (local) {
    // SET LOCAL outside a transaction is a no-op (PostgreSQL warns)
    if (tx.inTransaction) {
      state.localSettings.set(name, shown ?? (def ? gucDefaultDisplay(def) : ""));
    }
    return state.getSetting(name) ?? "";
  }
  if (shown === undefined) state.settings.delete(name);
  else state.settings.set(name, shown);
  state.localSettings.delete(name);
  return state.getSetting(name) ?? "";
}

/** `SET TRANSACTION <modes>` / `BEGIN <modes>` (or the session's defaults for SET SESSION CHARACTERISTICS). */
export function applyTransactionModes(state: DatabaseState, modes: readonly string[], session: boolean): void {
  for (const mode of modes) {
    let name: string;
    let value: string;
    if (mode.startsWith("isolation level ")) {
      name = "transaction_isolation";
      value = mode.slice("isolation level ".length);
    } else if (mode === "read only" || mode === "read write") {
      name = "transaction_read_only";
      value = mode === "read only" ? "on" : "off";
    } else {
      name = "transaction_deferrable";
      value = mode === "deferrable" ? "on" : "off";
    }
    applySetting(state, session ? `default_${name}` : name, value, !session);
  }
}

registerConfigurationSetter(applySetting);

export function executeSet(env: ExecEnv, stmt: SetStmt): ExecResult {
  const state = env.ctx.state;
  if (stmt.transactionModes) {
    // SET TRANSACTION outside a transaction block is a no-op (PostgreSQL warns)
    if (stmt.name === "transaction" && !txManagerFor(state).inTransaction) return commandResult("SET", 0);
    applyTransactionModes(state, stmt.transactionModes, stmt.name !== "transaction");
    return commandResult("SET", 0);
  }
  applySetting(state, stmt.name, stmt.value, stmt.local);
  return commandResult("SET", 0);
}

export function executeShow(env: ExecEnv, stmt: ShowStmt): ExecResult {
  const state = env.ctx.state;
  const name = canonicalGucName(stmt.name);
  if (name === "all") {
    const rows: Datum[][] = allSettings(state).map(({ key, name, value }) => [
      name,
      value,
      gucDef(key)?.shortDesc ?? "",
    ]);
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
    columns: [{ name: displayGucName(name), type: "text" }],
    rows: [[value]],
    command: "SHOW",
    rowCount: 1,
  };
}

export function executeReset(env: ExecEnv, stmt: ResetStmt): ExecResult {
  const state = env.ctx.state;
  const name = canonicalGucName(stmt.name);
  if (name === "all") {
    state.settings = new Map([...getDefaultSettings(), ...(state.settingDefaults ?? [])]);
    // RESET ALL leaves the transaction's own characteristics alone
    for (const key of [...state.localSettings.keys()]) {
      if (!TRANSACTION_GUCS.has(key)) state.localSettings.delete(key);
    }
    return commandResult("RESET", 0);
  }
  applySetting(state, stmt.name, null, false);
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

function splitCsvRecords(data: string, quote: string): string[] {
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (char === quote) {
      if (quoted && data[i + 1] === quote) i++;
      else quoted = !quoted;
      continue;
    }
    if (char === "\n" && !quoted) {
      const end = i > start && data[i - 1] === "\r" ? i - 1 : i;
      records.push(data.slice(start, end));
      start = i + 1;
    }
  }
  if (quoted) throw pgError("invalid_text_representation", "unterminated CSV quoted field", "22P04");
  if (start < data.length) records.push(data.slice(start));
  return records;
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
  beforeStatement(env.ctx.state, txManagerFor(env.ctx.state), stmt);
  const delim = String(stmt.options.delimiter ?? (format === "csv" ? "," : "\t"));
  const nullStr = String(stmt.options.null ?? (format === "csv" ? "" : "\\N"));
  const quote = String(stmt.options.quote ?? '"');
  const header = stmt.options.header === true || String(stmt.options.header ?? "").toLowerCase() === "true";

  let lines = format === "csv" ? splitCsvRecords(data, quote) : data.split(/\r?\n/);
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
