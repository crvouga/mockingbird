import type { Statement as AstStatement } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { ExecutionEnv } from "../executor/env.ts";
import { executeStatement } from "../executor/execute.ts";
import { emptyResult, type ResultSet } from "../executor/result.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parseUnits } from "../parser/index.ts";
import type { BindValue, QueryRow } from "../types/value.ts";
import type { Database } from "./database.ts";

/** Mutation counters returned by {@link Statement.run}. */
export interface RunResult {
  /** Rows changed by this execution (SQLite `changes()`). */
  changes: number;
  /** Rowid of the most recent INSERT in this execution. */
  lastInsertRowid: number | bigint;
}

/**
 * Prepared SQL statement bound to a {@link Database}.
 *
 * Create with {@link Database.prepare}. Pass bind values as rest arguments to
 * {@link run}, {@link all}, {@link get}, or {@link result} on each call
 * (stateless — there is no sticky `bind()`).
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
 * const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
 * insert.run("Ada");
 * const row = db.prepare("SELECT id, name FROM t WHERE id = ?").get<{ id: number; name: string }>(1);
 * ```
 */
export class Statement {
  private namedPlan: ReturnType<typeof planNamedParameters> | null = null;
  private env: ExecutionEnv | null = null;
  private statements: AstStatement[];
  private statementSqls: string[];
  private schemaVersion: number;

  private constructor(
    private readonly database: Database,
    private readonly sql: string,
    statements: AstStatement[],
    statementSqls: string[],
  ) {
    this.statements = statements;
    this.statementSqls = statementSqls;
    this.schemaVersion = database.state.schemaVersion;
  }

  /**
   * Construct a {@link Statement} for {@link Database.prepare} / {@link Database.exec}.
   * @internal
   */
  static create(database: Database, sql: string, statements: AstStatement[], statementSqls?: string[]): Statement {
    return new Statement(database, sql, statements, statementSqls ?? statements.map(() => sql));
  }

  /** @internal Build from {@link parseUnits}. */
  static createFromSql(database: Database, sql: string): Statement {
    const units = parseUnits(sql);
    return new Statement(
      database,
      sql,
      units.map((u) => u.statement),
      units.map((u) => u.sql),
    );
  }

  /**
   * Execute for side effects (INSERT / UPDATE / DELETE / DDL).
   *
   * @param params - Bind values for this call only.
   * @returns Mutation counters for this execution.
   * @throws {SqliteError} If the database is closed, the statement is empty, or execution fails.
   */
  run(...params: BindValue[]): RunResult {
    const result = this.execute(params, { named: false });
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  /**
   * Execute and return every result row as an object keyed by column name.
   *
   * @typeParam T - Row shape. Defaults to {@link QueryRow}.
   * @param params - Bind values for this call only.
   * @throws {SqliteError} If the database is closed, the statement is empty, or execution fails.
   */
  all<T = QueryRow>(...params: BindValue[]): T[] {
    return this.execute(params, { named: true }).rows as T[];
  }

  /**
   * Execute and return the full {@link ResultSet}, including column names.
   *
   * Use this when you need metadata for an empty result (column names with zero rows).
   * {@link all} only returns row objects.
   *
   * @param params - Bind values for this call only.
   * @throws {SqliteError} If the database is closed, the statement is empty, or execution fails.
   */
  result(...params: BindValue[]): ResultSet {
    return this.execute(params, { named: true });
  }

  /**
   * Execute and return the first row, or `undefined` if there are no rows.
   *
   * @typeParam T - Row shape. Defaults to {@link QueryRow}.
   * @param params - Bind values for this call only.
   * @throws {SqliteError} If the database is closed, the statement is empty, or execution fails.
   */
  get<T = QueryRow>(...params: BindValue[]): T | undefined {
    return this.execute(params, { named: true, maxRows: 1 }).rows[0] as T | undefined;
  }

  private execute(params: readonly BindValue[], options?: { named?: boolean; maxRows?: number }): ResultSet {
    this.database.assertOpen();
    this.reprepareIfSchemaChanged();
    if (this.statements.length === 0) {
      if (options?.named) throw new SqliteError("empty statement", "misuse");
      return emptyResult(this.database.state.changes, this.database.state.lastInsertRowid);
    }
    this.namedPlan ??= planNamedParameters(this.sql);
    const expected = this.namedPlan.expectedCount;
    if (params.length > 0 && params.length !== expected) {
      throw new SqliteError(`SQLite query expected ${expected} values, received ${params.length}`, "misuse");
    }
    const env = this.obtainEnv(params);
    env.maxRows = options?.maxRows ?? Number.POSITIVE_INFINITY;
    env.includeNamedRows = options?.named !== false;
    env.includeValues = true;
    this.bindNamed(env, params);
    let result: ResultSet | undefined;
    for (let i = 0; i < this.statements.length; i++) {
      env.statementSql = this.statementSqls[i] ?? this.sql;
      result = executeStatement(this.statements[i]!, env);
    }
    env.statementSql = null;
    return result!;
  }

  private obtainEnv(params: readonly BindValue[]): ExecutionEnv {
    if (this.env) {
      this.env.reset(params);
      this.env.hooks.now = this.database.now;
      this.env.hooks.random = () => this.database.prng.nextSqliteRandom();
      this.env.hooks.randomU64 = () => this.database.prng.nextU64();
      return this.env;
    }
    this.env = new ExecutionEnv(this.database.state, this.database.transactions, params, undefined, {
      now: this.database.now,
      random: () => this.database.prng.nextSqliteRandom(),
      randomU64: () => this.database.prng.nextU64(),
    });
    return this.env;
  }

  private reprepareIfSchemaChanged(): void {
    if (this.schemaVersion === this.database.state.schemaVersion) return;
    const units = parseUnits(this.sql);
    this.statements = units.map((u) => u.statement);
    this.statementSqls = units.map((u) => u.sql);
    this.env = null;
    this.namedPlan = null;
    this.schemaVersion = this.database.state.schemaVersion;
  }

  private bindNamed(env: ExecutionEnv, params: readonly BindValue[]): void {
    this.namedPlan ??= planNamedParameters(this.sql);
    for (const item of this.namedPlan.named) {
      if (item.slot <= params.length) env.setNamed(item.name, params[item.slot - 1]);
    }
  }
}

interface NamedPlan {
  named: { name: string; slot: number }[];
  /** Highest bind slot index (SQLite parameter count). */
  expectedCount: number;
}

function planNamedParameters(sql: string): NamedPlan {
  const tokens = tokenize(sql);
  let nextSlot = 1;
  const namedSlots = new Map<string, number>();
  const named: { name: string; slot: number }[] = [];
  for (const token of tokens) {
    if (token.kind === "PARAM_POS") {
      if (token.index !== undefined) nextSlot = Math.max(nextSlot, token.index + 1);
      else nextSlot++;
    } else if (token.kind === "PARAM_NAMED") {
      const name = token.value.toLowerCase();
      let slot = namedSlots.get(name);
      if (slot === undefined) {
        slot = nextSlot++;
        namedSlots.set(name, slot);
        named.push({ name, slot });
      }
    }
  }
  return { named, expectedCount: nextSlot - 1 };
}

/**
 * Bind named placeholders into an execution environment.
 * @internal
 */
export function bindNamedParameters(env: ExecutionEnv, sql: string, params: readonly BindValue[]): void {
  const plan = planNamedParameters(sql);
  for (const item of plan.named) {
    if (item.slot <= params.length) env.setNamed(item.name, params[item.slot - 1]);
  }
}
