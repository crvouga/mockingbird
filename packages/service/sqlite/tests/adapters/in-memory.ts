import { Database, Snapshot, SqliteError, type Statement } from "../../src/index.ts";
import { normalizeError } from "../harness/normalize.ts";
import { failResult, okWithSession } from "../harness/session.ts";
import type { ContractDb, ContractStatement, ErrorPhase, QueryResult, SqlValue } from "../harness/types.ts";

function mapSqliteError(error: unknown, db: Database | undefined, phase?: ErrorPhase): QueryResult {
  const inTransaction = db ? db.transactions.inTransaction : false;
  const totalChanges = db ? db.totalChanges : 0;
  if (error instanceof SqliteError) {
    return failResult(
      normalizeError(error.message, error.category, { sqliteCode: error.sqliteCode, phase }),
      totalChanges,
      inTransaction,
      phase,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return failResult(normalizeError(message, undefined, { phase }), totalChanges, inTransaction, phase);
}

class InMemoryStatement implements ContractStatement {
  constructor(
    private readonly stmt: Statement,
    private readonly db: Database,
  ) {}

  run(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.run(...params);
      return okWithSession(
        [],
        [],
        result.changes,
        result.lastInsertRowid,
        this.db.totalChanges,
        this.db.transactions.inTransaction,
      );
    } catch (error) {
      return mapSqliteError(error, this.db, "step");
    }
  }

  all(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.result(...params);
      return okWithSession(
        [...result.columns],
        result.rows as Record<string, SqlValue>[],
        this.db.changes,
        this.db.lastInsertRowid,
        this.db.totalChanges,
        this.db.transactions.inTransaction,
        result.values.map((row) => [...row]),
      );
    } catch (error) {
      return mapSqliteError(error, this.db, "step");
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.result(...params);
      if (result.rows.length === 0) {
        return okWithSession(
          [...result.columns],
          [],
          this.db.changes,
          this.db.lastInsertRowid,
          this.db.totalChanges,
          this.db.transactions.inTransaction,
          [],
        );
      }
      return okWithSession(
        [...result.columns],
        [result.rows[0] as Record<string, SqlValue>],
        this.db.changes,
        this.db.lastInsertRowid,
        this.db.totalChanges,
        this.db.transactions.inTransaction,
        result.values.length > 0 ? [[...result.values[0]!]] : [],
      );
    } catch (error) {
      return mapSqliteError(error, this.db, "step");
    }
  }
}

export function safeExec(db: Database, sql: string, params?: SqlValue[]): QueryResult {
  try {
    if (params && params.length > 0) {
      const result = db.prepare(sql).run(...params);
      return okWithSession(
        [],
        [],
        result.changes,
        result.lastInsertRowid,
        db.totalChanges,
        db.transactions.inTransaction,
      );
    }
    db.exec(sql);
    return okWithSession([], [], db.changes, db.lastInsertRowid, db.totalChanges, db.transactions.inTransaction);
  } catch (error) {
    const phase: ErrorPhase =
      error instanceof SqliteError && /syntax|empty statement|single statement/i.test(error.message)
        ? "prepare"
        : "step";
    try {
      db.prepare(sql);
    } catch {
      return mapSqliteError(error, db, "prepare");
    }
    return mapSqliteError(error, db, phase);
  }
}

export class InMemoryAdapter implements ContractDb {
  private db: Database;
  private readonly options?: ConstructorParameters<typeof Database>[0];
  private closed = false;

  constructor(options?: ConstructorParameters<typeof Database>[0]) {
    this.options = options;
    this.db = new Database(options);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  exec(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    return safeExec(this.db, sql, params);
  }

  query(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const prepared = this.db.prepare(sql);
      const result = prepared.result(...(params ?? []));
      return okWithSession(
        [...result.columns],
        result.rows as Record<string, SqlValue>[],
        this.db.changes,
        this.db.lastInsertRowid,
        this.db.totalChanges,
        this.db.transactions.inTransaction,
        result.values.map((row) => [...row]),
      );
    } catch (error) {
      try {
        this.db.prepare(sql);
      } catch (prepareError) {
        return mapSqliteError(prepareError, this.db, "prepare");
      }
      return mapSqliteError(error, this.db, "step");
    }
  }

  prepare(sql: string): ContractStatement {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    try {
      return new InMemoryStatement(this.db.prepare(sql), this.db);
    } catch (error) {
      const mapped = mapSqliteError(error, this.db, "prepare");
      throw new Error(mapped.error?.message ?? "prepare failed", { cause: error });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.transaction(fn);
  }

  snapshot(): Uint8Array {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.snapshot().encode();
  }

  restore(bytes: Uint8Array): void {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    this.db.close();
    this.db = Snapshot.decode(bytes).open(this.options);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  inTransaction(): boolean {
    return !this.closed && this.db.transactions.inTransaction;
  }

  totalChanges(): number {
    return this.closed ? 0 : this.db.totalChanges;
  }

  private closedError(): QueryResult {
    return failResult(normalizeError("Database is closed", "misuse", { sqliteCode: "SQLITE_MISUSE", phase: "step" }));
  }
}
