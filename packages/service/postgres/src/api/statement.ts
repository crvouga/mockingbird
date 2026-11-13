import type { Statement as AstStatement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { executeStatement } from "../executor/execute.ts";
import { withStatementTimeout } from "../runtime/statement-timeout.ts";
import { refusedInTransactionBlock } from "../executor/maintenance.ts";
import { runOnCommitActions } from "../executor/on-commit.ts";
import type { ExecEnv, ExecResult } from "../executor/relation.ts";
import { EngineCtx } from "../expressions/context.ts";
import { parse } from "../parser/index.ts";
import type { TypedValue, TypeMod } from "../types/value.ts";
import { datumText, UNKNOWN } from "../types/value.ts";
import { type BindValue, bindValueToTyped, datumToJs, type QueryRow } from "./bind.ts";
import type { Database } from "./database.ts";

/** Row-count summary returned by {@link Statement.run}. */
export interface RunResult {
  /** Rows affected by the last statement (PostgreSQL command tag count). */
  rowCount: number;
  /** Command tag of the last statement, e.g. `"INSERT"`. */
  command: string;
}

/** {@link Statement.textResult}: rows as canonical PostgreSQL text. */
export interface TextResultSet {
  columns: string[];
  columnTypes: string[];
  /** type modifier per column (`varchar(32)`, `numeric(10,2)`), null where there is none; absent when unknown */
  columnMods?: (TypeMod | null)[];
  rows: (string | null)[][];
  rowCount: number;
  command: string;
}

/** Full result including column metadata (useful for zero-row results). */
export interface ResultSet {
  columns: string[];
  /** canonical type names per column (PG internal names, e.g. "int4") */
  columnTypes: string[];
  rows: QueryRow[];
  rowCount: number;
  command: string;
}

/**
 * Prepared SQL statement bound to a {@link Database}. Parameters are
 * positional PostgreSQL placeholders `$1..$n`, passed per call (stateless).
 */
export class Statement {
  private statements: AstStatement[];

  /** The source SQL this statement was prepared from. */
  readonly sql: string;

  private constructor(
    private readonly database: Database,
    sql: string,
    statements: AstStatement[],
  ) {
    this.sql = sql;
    this.statements = statements;
    const observer = database.durabilityObserver;
    if (observer) {
      const execute = this.execute;
      this.execute = (params) => {
        observer.assertWritable();
        // bytea parameters/results retain borrowed buffers under the existing API.
        if (params.some((value) => value instanceof Uint8Array)) observer.exposed();
        try {
          const result = execute.call(this, params);
          if (
            result.columns.some(
              (column, index) =>
                column.type === "bytea" && result.rows.some((row) => row[index] !== null && row[index] !== undefined),
            )
          )
            observer.exposed();
          return result;
        } finally {
          observer.changed();
        }
      };
    }
  }

  /** @internal */
  static create(database: Database, sql: string, statements: AstStatement[]): Statement {
    return new Statement(database, sql, statements);
  }

  /** @internal */
  static createFromSql(database: Database, sql: string): Statement {
    return new Statement(database, sql, parse(sql));
  }

  /** Execute for side effects; returns the affected row count. */
  run(...params: BindValue[]): RunResult {
    const res = this.execute(params);
    return { rowCount: res.rowCount, command: res.command };
  }

  /** Execute and return all rows as objects keyed by column name. */
  all<T = QueryRow>(...params: BindValue[]): T[] {
    return this.toRows(this.execute(params)) as T[];
  }

  /** Execute and return the first row, or `undefined`. */
  get<T = QueryRow>(...params: BindValue[]): T | undefined {
    return (this.toRows(this.execute(params)) as T[])[0];
  }

  /**
   * Execute and return rows rendered as canonical PostgreSQL text (psql-style),
   * plus column metadata. NULLs stay `null`.
   */
  textResult(...params: BindValue[]): TextResultSet {
    const res = this.execute(params);
    const ctx = new EngineCtx(this.database.engineState);
    return {
      columns: res.columns.map((c) => c.name),
      columnTypes: res.columns.map((c) => (c.type === UNKNOWN ? "text" : c.type)),
      columnMods: res.columns.map((c) => c.mod ?? null),
      rows: res.rows.map((row) =>
        res.columns.map((c, i) => {
          const v = row[i] ?? null;
          return v === null ? null : datumText(c.type === UNKNOWN ? "text" : c.type, v, ctx);
        }),
      ),
      rowCount: res.rowCount,
      command: res.command,
    };
  }

  /** Execute and return the full {@link ResultSet} with column metadata. */
  result(...params: BindValue[]): ResultSet {
    const res = this.execute(params);
    return {
      columns: res.columns.map((c) => c.name),
      columnTypes: res.columns.map((c) => (c.type === UNKNOWN ? "text" : c.type)),
      rows: this.toRows(res),
      rowCount: res.rowCount,
      command: res.command,
    };
  }

  private execute(params: readonly BindValue[]): ExecResult {
    this.database.assertOpen();
    if (this.statements.length === 0) {
      throw pgError("misuse", "empty statement", "XX000");
    }
    const typed: TypedValue[] = params.map((p, i) => bindValueToTyped(p, i));
    let last: ExecResult | null = null;
    const state = this.database.engineState;
    // the statements of one script outside a block share one implicit transaction, and so one now()
    let implicitStart: bigint | undefined;
    // current_query(): the text the client sent, for every statement of it (a host function's nested query restores it)
    const outerQuery = state.currentQuery;
    state.currentQuery = this.sql;
    try {
      for (const stmt of this.statements) {
        const inBlock = this.database.transactions.inTransaction;
        const refused = inBlock ? refusedInTransactionBlock(stmt) : null;
        if (refused) throw pgError("misuse", `${refused} cannot run inside a transaction block`, "25001");
        const env: ExecEnv = {
          ctx: new EngineCtx(state, implicitStart),
          params: typed,
          ctes: new Map(),
          outer: null,
        };
        // statement_timeout applies to each statement of a script separately (PostgreSQL 13+)
        try {
          last = withStatementTimeout(state, () => executeStatement(env, stmt));
        } finally {
          // outside a transaction block the statement is its own transaction: what
          // `set_config(..., true)` set lasts until the statement ends
          if (!inBlock && !this.database.transactions.inTransaction) state.localSettings.clear();
        }
        const blockStatement = inBlock || this.database.transactions.inTransaction;
        implicitStart = blockStatement ? undefined : (implicitStart ?? env.ctx.txNow);
        // an autocommit statement commits as it ends
        if (!this.database.transactions.inTransaction) runOnCommitActions(this.database.engineState);
      }
    } finally {
      state.currentQuery = outerQuery;
    }
    return last!;
  }

  private toRows(res: ExecResult): QueryRow[] {
    const ctx = new EngineCtx(this.database.engineState);
    return res.rows.map((row) => {
      const obj: QueryRow = {};
      for (let i = 0; i < res.columns.length; i++) {
        const c = res.columns[i]!;
        const value = datumToJs(c.type, row[i] ?? null, ctx, this.database.int8Mode);
        obj[c.name] = value;
      }
      return obj;
    });
  }
}
