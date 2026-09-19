import type { SelectStmt } from "../ast/nodes.ts";
import { SqliteError, TriggerRaiseError } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { defaultFunctionRegistry, type FunctionRegistry } from "../functions/registry.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { Rowid } from "../storage/row.ts";
import type { TransactionManager } from "../transactions/manager.ts";
import {
  type Affinity,
  canonicalizeNumber,
  SqlJsonText,
  SqlReal,
  type SqlValue,
  storageClassOf,
} from "../types/value.ts";
import type { ResultSet } from "./result.ts";

export interface Cell {
  table: string | null;
  tableLower?: string | null;
  name: string;
  nameLower?: string;
  value: SqlValue;
  affinity?: Affinity;
  collate?: string | null;
  /** Right-hand duplicate of a column merged by JOIN ... USING. */
  hiddenByUsing?: boolean;
}

export function makeCell(
  table: string | null,
  name: string,
  value: SqlValue,
  extra?: Omit<Partial<Cell>, "table" | "name" | "value" | "tableLower" | "nameLower">,
): Cell {
  return {
    table,
    tableLower: table?.toLowerCase() ?? null,
    name,
    nameLower: name.toLowerCase(),
    value,
    ...extra,
  };
}

export interface ScopeRow {
  cells: Cell[];
  rowid?: Rowid;
  /** Output name of the rowid pseudo-column (INTEGER PRIMARY KEY alias when present). */
  rowidName?: string;
  sourceTable?: string;
  /** Set when WHERE MATCH succeeds for this row. */
  ftsMatch?: import("../vtable/fts5.ts").FtsMatchCursor | null;
}

export type SelectRunner = (stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext) => ResultSet;

export interface ExecutionHooks {
  now?: () => Date;
  random?: () => bigint;
  /** Raw xorshift64* output for `randomblob`. */
  randomU64?: () => bigint;
}

export class ExecutionEnv {
  readonly state: DatabaseState;
  readonly transactions: TransactionManager;
  readonly functions: FunctionRegistry;
  readonly positional: SqlValue[];
  readonly named: Map<string, SqlValue>;
  readonly ctes = new Map<string, ResultSet>();
  readonly hooks: ExecutionHooks;
  selectRunner?: SelectRunner;

  /** Nesting depth while executing trigger programs. */
  triggerDepth = 0;
  /** OLD/NEW column scope for the active trigger program. */
  triggerScope: ScopeRow | null = null;

  /** Cap SELECT output rows (used by Statement.get). */
  maxRows = Number.POSITIVE_INFINITY;
  /** When true, skip simple-select / simple-join fast paths (tests only). */
  forceFullSelect = false;
  /** When true, skip tryFastInsert (tests only). */
  forceFullInsert = false;
  includeNamedRows = true;
  includeValues = true;
  /** Source text of the statement currently executing (for sqlite_master.sql). */
  statementSql: string | null = null;

  constructor(
    state: DatabaseState,
    transactions: TransactionManager,
    params: readonly unknown[] = [],
    functions: FunctionRegistry = defaultFunctionRegistry,
    hooks: ExecutionHooks = {},
  ) {
    this.state = state;
    this.transactions = transactions;
    this.functions = functions;
    this.hooks = hooks;
    this.positional = params.map(toSqlValue);
    this.named = new Map();
  }

  reset(params: readonly unknown[]): void {
    this.positional.length = 0;
    for (const value of params) this.positional.push(toSqlValue(value));
    this.named.clear();
    this.ctes.clear();
    this.triggerDepth = 0;
    this.triggerScope = null;
    this.maxRows = Number.POSITIVE_INFINITY;
    this.forceFullSelect = false;
    this.forceFullInsert = false;
    this.includeNamedRows = true;
    this.includeValues = true;
    this.statementSql = null;
  }

  getBoundParameter(name: string | number): SqlValue {
    if (typeof name === "number") {
      if (name < 1 || name > this.positional.length) return null;
      return this.positional[name - 1]!;
    }
    const key = name.toLowerCase();
    if (!this.named.has(key)) {
      // Unnamed positional fallback is handled by the evaluator for PARAM_POS;
      // named placeholders that were never bound are NULL (SQLite).
      return null;
    }
    return this.named.get(key) ?? null;
  }

  setNamed(name: string, value: unknown): void {
    this.named.set(name.toLowerCase(), toSqlValue(value));
  }

  createEvalContext(row: ScopeRow | null = null, parent?: EvalContext): EvalContext {
    const scope = row ?? this.triggerScope;
    const cells = scope?.cells ?? [];
    const inheritedParent =
      parent ??
      (row !== null && this.triggerScope !== null && row !== this.triggerScope
        ? this.createEvalContext(this.triggerScope)
        : undefined);
    const context: EvalContext = {
      parent: inheritedParent,
      ftsMatch: scope?.ftsMatch ?? null,
      functions: this.functions,
      functionContext: {
        changes: () => this.state.changes,
        totalChanges: () => this.state.totalChanges,
        lastInsertRowid: () => this.state.lastInsertRowid,
        now: this.hooks.now,
        random: this.hooks.random,
        randomU64: this.hooks.randomU64,
        caseSensitiveLike: this.state.caseSensitiveLike,
        ftsMatch: scope?.ftsMatch ?? null,
        ftsRowid: scope?.rowid,
        ftsSourceTable: scope?.sourceTable,
        getFtsTable: (name: string) => {
          if (!this.state.isFtsTable(name)) return null;
          return this.state.getVirtualTable(name);
        },
      },
      raise: this.triggerScope
        ? (action, message) => {
            throw new TriggerRaiseError(action, message);
          }
        : undefined,
      resolveColumn: (table, name) => {
        const key = name.toLowerCase();
        const tableKey = table?.toLowerCase();
        const tableMatches =
          table === null || cells.some((cell) => (cell.tableLower ?? cell.table?.toLowerCase()) === tableKey);
        if (tableMatches && (key === "rowid" || key === "_rowid_" || key === "oid") && scope?.rowid !== undefined) {
          return scope.rowid;
        }
        if (key === "rank" && scope?.sourceTable && this.state.isFtsTable(scope.sourceTable)) {
          const fts = this.state.getVirtualTable(scope.sourceTable);
          if (scope.ftsMatch) return fts.bm25(scope.ftsMatch);
          return null;
        }
        // FTS table-name reference used by aux functions (bm25(docs), …)
        if (
          scope?.sourceTable &&
          key === scope.sourceTable.toLowerCase() &&
          this.state.isFtsTable(scope.sourceTable) &&
          !cells.some((cell) => (cell.nameLower ?? cell.name.toLowerCase()) === key)
        ) {
          return scope.sourceTable;
        }
        const matches = cells.filter((cell) => {
          if ((cell.nameLower ?? cell.name.toLowerCase()) !== key) return false;
          if (table === null) return !cell.hiddenByUsing;
          return (cell.tableLower ?? cell.table?.toLowerCase()) === tableKey;
        });
        if (matches.length === 0) {
          // SQLite: bare TRUE/FALSE are integer 1/0 unless a same-named column is in scope.
          if (table === null) {
            if (key === "true") return 1;
            if (key === "false") return 0;
          }
          throw new SqliteError(`no such column: ${table ? `${table}.` : ""}${name}`, "no_such_column");
        }
        if (matches.length > 1 && table === null) throw new SqliteError(`ambiguous column name: ${name}`, "other");
        return matches[0]!.value;
      },
      resolveStorageClass: (table, name) => {
        const key = name.toLowerCase();
        if (key === "rank") return "real";
        const tableKey = table?.toLowerCase();
        const matches = cells.filter((cell) => {
          if ((cell.nameLower ?? cell.name.toLowerCase()) !== key) return false;
          if (table === null) return !cell.hiddenByUsing;
          return (cell.tableLower ?? cell.table?.toLowerCase()) === tableKey;
        });
        if (matches.length === 0) {
          if (table === null && (key === "true" || key === "false")) return "integer";
          throw new SqliteError(`no such column: ${table ? `${table}.` : ""}${name}`, "no_such_column");
        }
        if (matches.length > 1 && table === null) throw new SqliteError(`ambiguous column name: ${name}`, "other");
        const cell = matches[0]!;
        return cell.affinity === "REAL" && typeof cell.value === "number" ? "real" : storageClassOf(cell.value);
      },
      resolveAffinity: (table, name) => {
        const key = name.toLowerCase();
        const tableKey = table?.toLowerCase();
        const matches = cells.filter((cell) => {
          if ((cell.nameLower ?? cell.name.toLowerCase()) !== key) return false;
          if (table === null) return !cell.hiddenByUsing;
          return (cell.tableLower ?? cell.table?.toLowerCase()) === tableKey;
        });
        if (matches.length !== 1) return null;
        return matches[0]!.affinity ?? null;
      },
      resolveCollation: (table, name) => {
        const key = name.toLowerCase();
        const tableKey = table?.toLowerCase();
        const matches = cells.filter((cell) => {
          if ((cell.nameLower ?? cell.name.toLowerCase()) !== key) return false;
          if (table === null) return !cell.hiddenByUsing;
          return (cell.tableLower ?? cell.table?.toLowerCase()) === tableKey;
        });
        if (matches.length === 0) return null;
        if (matches.length > 1 && table === null) return null;
        return matches[0]!.collate ?? null;
      },
      getParameter: (name) => this.getBoundParameter(name),
      executeSelect: (select) => {
        if (!this.selectRunner) throw new SqliteError("select executor is not configured", "misuse");
        const result = this.selectRunner(select, this, context);
        return {
          columns: result.columns,
          rows:
            result.values.length > 0
              ? result.values.map((row) => [...row])
              : result.rows.map((record) => result.columns.map((column) => record[column] ?? null)),
        };
      },
      matchFts: (table, column, query) => {
        if (row?.rowid === undefined || !row.sourceTable) {
          throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
        }
        if (!this.state.isFtsTable(row.sourceTable)) {
          throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
        }
        const fts = this.state.getVirtualTable(row.sourceTable);
        const cursor = fts.matchCursor(row.rowid, table, column, query);
        if (cursor) row.ftsMatch = cursor;
        else row.ftsMatch = null;
        return cursor !== null;
      },
    };
    return context;
  }
}

export function toSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SqliteError("only finite numbers can be bound", "datatype_mismatch");
    return canonicalizeNumber(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof SqlReal || value instanceof SqlJsonText) return value;
  if (value instanceof Uint8Array) {
    if (isSharedArrayBufferView(value)) {
      throw new SqliteError("cannot bind SharedArrayBuffer-backed buffers; copy into a Uint8Array first", "misuse");
    }
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    throw new SqliteError("cannot bind SharedArrayBuffer; copy into an ArrayBuffer or Uint8Array first", "misuse");
  }
  if (ArrayBuffer.isView(value)) {
    const kind = Object.prototype.toString.call(value).slice(8, -1);
    throw new SqliteError(`cannot bind ${kind}; only Uint8Array and ArrayBuffer are accepted as BLOB values`, "misuse");
  }
  throw new SqliteError(`unsupported bind value: ${typeof value}`, "datatype_mismatch");
}

function isSharedArrayBufferView(view: ArrayBufferView): boolean {
  return typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer;
}
