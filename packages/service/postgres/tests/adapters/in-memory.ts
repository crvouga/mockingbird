import { Database, PostgresError, Snapshot, type Statement } from "../../src/index.ts";
import { categoryFromSqlstate } from "../harness/classify.ts";
import { normalizeErrorMessage } from "../harness/normalize.ts";
import { failResult, okResult } from "../harness/session.ts";
import type { ContractDb, ContractStatement, ErrorPhase, QueryResult, SqlValue } from "../harness/types.ts";

function mapError(error: unknown, db: Database | undefined, phase?: ErrorPhase): QueryResult {
  const inTransaction = db ? db.transactions.inTransaction : false;
  if (error instanceof PostgresError) {
    return failResult(
      {
        category: categoryFromSqlstate(error.sqlState),
        message: normalizeErrorMessage(error.message),
        sqlstate: error.sqlState,
        ...(phase ? { phase } : {}),
      },
      inTransaction,
      phase,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return failResult(
    { category: "other", message: normalizeErrorMessage(message), ...(phase ? { phase } : {}) },
    inTransaction,
    phase,
  );
}

class InMemoryStatement implements ContractStatement {
  constructor(
    private readonly stmt: Statement,
    private readonly db: Database,
  ) {}

  async run(...params: SqlValue[]): Promise<QueryResult> {
    try {
      const result = this.stmt.run(...params);
      return okResult([], [], result.rowCount, result.command, this.db.transactions.inTransaction);
    } catch (error) {
      return mapError(error, this.db, "step");
    }
  }

  async all(...params: SqlValue[]): Promise<QueryResult> {
    try {
      const result = this.stmt.textResult(...params);
      return okResult(
        [...result.columns],
        result.rows,
        result.rowCount,
        result.command,
        this.db.transactions.inTransaction,
      );
    } catch (error) {
      return mapError(error, this.db, "step");
    }
  }

  async get(...params: SqlValue[]): Promise<QueryResult> {
    try {
      const result = this.stmt.textResult(...params);
      return okResult(
        [...result.columns],
        result.rows.slice(0, 1),
        result.rowCount,
        result.command,
        this.db.transactions.inTransaction,
      );
    } catch (error) {
      return mapError(error, this.db, "step");
    }
  }
}

export class InMemoryAdapter implements ContractDb {
  db: Database;
  private readonly options?: ConstructorParameters<typeof Database>[0];
  private closed = false;

  constructor(options?: ConstructorParameters<typeof Database>[0]) {
    this.options = options;
    this.db = new Database(options);
  }

  async exec(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    if (this.closed) return this.closedError();
    try {
      if (params && params.length > 0) {
        const result = this.db.prepare(sql).run(...params);
        return okResult([], [], result.rowCount, result.command, this.db.transactions.inTransaction);
      }
      const stmt = this.prepareScript(sql);
      const result = stmt.run();
      return okResult([], [], result.rowCount, result.command, this.db.transactions.inTransaction);
    } catch (error) {
      const phase: ErrorPhase = this.failsAtPrepare(sql) ? "prepare" : "step";
      return mapError(error, this.db, phase);
    }
  }

  async query(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    if (this.closed) return this.closedError();
    try {
      const result = this.db.prepare(sql).textResult(...(params ?? []));
      return okResult(
        [...result.columns],
        result.rows,
        result.rowCount,
        result.command,
        this.db.transactions.inTransaction,
      );
    } catch (error) {
      const phase: ErrorPhase = this.failsAtPrepare(sql) ? "prepare" : "step";
      return mapError(error, this.db, phase);
    }
  }

  prepare(sql: string): ContractStatement {
    if (this.closed) throw new Error("Database is closed");
    return new InMemoryStatement(this.db.prepare(sql), this.db);
  }

  snapshot(): Uint8Array {
    if (this.closed) throw new Error("Database is closed");
    return this.db.snapshot().encode();
  }

  restore(bytes: Uint8Array): void {
    if (this.closed) throw new Error("Database is closed");
    this.db.close();
    this.db = Snapshot.decode(bytes).open(this.options);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  inTransaction(): boolean {
    return !this.closed && this.db.transactions.inTransaction;
  }

  /** multi-statement script support for exec() */
  private prepareScript(sql: string): { run: () => { rowCount: number; command: string } } {
    const db = this.db;
    return {
      run() {
        db.exec(sql);
        return { rowCount: db.changes, command: "" };
      },
    };
  }

  private failsAtPrepare(sql: string): boolean {
    try {
      this.db.prepare(sql);
      return false;
    } catch {
      return true;
    }
  }

  private closedError(): QueryResult {
    return failResult({ category: "misuse", message: "Database is closed", sqlstate: "XX000", phase: "step" });
  }
}
