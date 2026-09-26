import { Database as BunDatabase, SQLiteError } from "bun:sqlite";
import { okResult } from "../harness/assert.ts";
import {
  categorizeErrorMessage,
  normalizeError,
  numericSqliteCodeToName,
  sqliteCodeFromMessage,
} from "../harness/normalize.ts";
import { applyTxnSql, failResult, okWithSession } from "../harness/session.ts";
import type {
  ContractDb,
  ContractStatement,
  ErrorCategory,
  ErrorPhase,
  QueryResult,
  SqlValue,
} from "../harness/types.ts";

function bunSqliteCode(error: SQLiteError): string {
  const extended = error as SQLiteError & { code?: string | number; errno?: number };
  if (typeof extended.code === "string" && extended.code.startsWith("SQLITE_")) return extended.code;
  if (typeof extended.code === "number") return numericSqliteCodeToName(extended.code);
  if (typeof extended.errno === "number") return numericSqliteCodeToName(extended.errno);
  return sqliteCodeFromMessage(error.message);
}

function mapSqliteError(
  error: unknown,
  extras: { totalChanges: number; inTransaction: boolean; phase?: ErrorPhase },
): QueryResult {
  if (error instanceof SQLiteError) {
    const category = categorizeErrorMessage(error.message);
    return failResult(
      normalizeError(error.message, category, { sqliteCode: bunSqliteCode(error), phase: extras.phase }),
      extras.totalChanges,
      extras.inTransaction,
      extras.phase,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return failResult(
    normalizeError(message, undefined, { phase: extras.phase }),
    extras.totalChanges,
    extras.inTransaction,
    extras.phase,
  );
}

function columnNamesFromStatement(stmt: { columnNames?: string[] }): string[] {
  return Array.isArray(stmt.columnNames) ? [...stmt.columnNames] : [];
}

function isMultiStatement(sql: string): boolean {
  const parts = sql
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1;
}

class RealSqliteStatement implements ContractStatement {
  constructor(
    private readonly stmt: ReturnType<BunDatabase["prepare"]>,
    private readonly adapter: RealSqliteAdapter,
  ) {}

  run(...params: SqlValue[]): QueryResult {
    try {
      const result = params.length > 0 ? this.stmt.run(...(params as never[])) : this.stmt.run();
      this.adapter.recordRun(result.changes, result.lastInsertRowid);
      return this.adapter.okWrite(result.changes, result.lastInsertRowid);
    } catch (error) {
      return this.adapter.mapStep(error);
    }
  }

  all(...params: SqlValue[]): QueryResult {
    try {
      return this.adapter.shapeStatementResult(this.stmt, params);
    } catch (error) {
      return this.adapter.mapStep(error);
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const shaped = this.adapter.shapeStatementResult(this.stmt, params);
      if (shaped.rows.length === 0) {
        return okResult(shaped.columns, [], shaped.changes, shaped.lastInsertRowid, [], {
          totalChanges: shaped.totalChanges,
          inTransaction: shaped.inTransaction,
        });
      }
      return okResult(
        shaped.columns,
        [shaped.rows[0]!],
        shaped.changes,
        shaped.lastInsertRowid,
        shaped.values ? [shaped.values[0]!] : undefined,
        { totalChanges: shaped.totalChanges, inTransaction: shaped.inTransaction },
      );
    } catch (error) {
      return this.adapter.mapStep(error);
    }
  }
}

export class RealSqliteAdapter implements ContractDb {
  private db: BunDatabase;
  private lastChanges = 0;
  private lastInsertRowid: number | bigint = 0;
  private closed = false;
  private txnOpen = false;

  constructor() {
    this.db = new BunDatabase(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  recordRun(changes: number, lastInsertRowid: number | bigint): void {
    this.lastChanges = changes;
    this.lastInsertRowid = lastInsertRowid;
  }

  okWrite(changes: number, lastInsertRowid: number | bigint): QueryResult {
    return okWithSession([], [], changes, lastInsertRowid, this.readTotalChanges(), this.txnOpen);
  }

  mapStep(error: unknown): QueryResult {
    return mapSqliteError(error, {
      totalChanges: this.readTotalChanges(),
      inTransaction: this.txnOpen,
      phase: "step",
    });
  }

  shapeStatementResult(stmt: ReturnType<BunDatabase["prepare"]>, params?: SqlValue[]): QueryResult {
    const columns = columnNamesFromStatement(stmt);
    let typeWidth = 0;
    try {
      typeWidth = Array.isArray(stmt.columnTypes) ? stmt.columnTypes.length : 0;
    } catch {
      typeWidth = 0;
    }

    const rawValues = params && params.length > 0 ? stmt.values(...(params as never[])) : stmt.values();
    const valueRows = (rawValues ? [...rawValues] : []) as SqlValue[][];

    const width = Math.max(typeWidth, valueRows[0]?.length ?? 0, columns.length);
    const resolvedColumns = columns.length > 0 ? columns : Array.from({ length: width }, (_, i) => `column${i}`);
    const rows = valueRows.map((values) => {
      const object: Record<string, SqlValue> = {};
      for (let i = 0; i < width; i++) {
        const name = resolvedColumns[i] ?? `column${i}`;
        if (!(name in object)) object[name] = values[i] ?? null;
      }
      return object;
    });
    return okWithSession(
      resolvedColumns,
      rows,
      this.lastChanges,
      this.lastInsertRowid,
      this.readTotalChanges(),
      this.txnOpen,
      valueRows,
    );
  }

  exec(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      if (params && params.length > 0) {
        let stmt: ReturnType<BunDatabase["prepare"]>;
        try {
          stmt = this.db.prepare(sql);
        } catch (error) {
          return mapSqliteError(error, {
            totalChanges: this.readTotalChanges(),
            inTransaction: this.txnOpen,
            phase: "prepare",
          });
        }
        const result = stmt.run(...(params as never[]));
        this.recordRun(result.changes, result.lastInsertRowid);
        this.txnOpen = applyTxnSql(sql, this.txnOpen);
        return this.okWrite(this.lastChanges, this.lastInsertRowid);
      }

      if (isMultiStatement(sql)) {
        this.db.exec(sql);
        this.refreshCountersFromSqlite();
        this.txnOpen = applyTxnSql(sql, this.txnOpen);
        for (const part of sql.split(";")) this.txnOpen = applyTxnSql(part, this.txnOpen);
        return this.okWrite(this.lastChanges, this.lastInsertRowid);
      }

      let stmt: ReturnType<BunDatabase["prepare"]>;
      try {
        stmt = this.db.prepare(sql);
      } catch {
        try {
          this.db.exec(sql);
          this.refreshCountersFromSqlite();
          this.txnOpen = applyTxnSql(sql, this.txnOpen);
          return this.okWrite(this.lastChanges, this.lastInsertRowid);
        } catch (error) {
          return mapSqliteError(error, {
            totalChanges: this.readTotalChanges(),
            inTransaction: this.txnOpen,
            phase: "prepare",
          });
        }
      }
      try {
        const result = stmt.run();
        this.recordRun(result.changes, result.lastInsertRowid);
        this.txnOpen = applyTxnSql(sql, this.txnOpen);
        return this.okWrite(this.lastChanges, this.lastInsertRowid);
      } catch (error) {
        return mapSqliteError(error, {
          totalChanges: this.readTotalChanges(),
          inTransaction: this.txnOpen,
          phase: "step",
        });
      }
    } catch (error) {
      return mapSqliteError(error, {
        totalChanges: this.readTotalChanges(),
        inTransaction: this.txnOpen,
        phase: "step",
      });
    }
  }

  private refreshCountersFromSqlite(): void {
    const changesRow = this.db.query("SELECT changes() AS c").get() as { c: number } | null;
    const rowidRow = this.db.query("SELECT last_insert_rowid() AS r").get() as {
      r: number | bigint;
    } | null;
    this.lastChanges = changesRow?.c ?? 0;
    this.lastInsertRowid = rowidRow?.r ?? 0;
  }

  private readTotalChanges(): number {
    try {
      const row = this.db.query("SELECT total_changes() AS c").get() as { c: number } | null;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  query(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const q = this.db.prepare(sql);
      return this.shapeStatementResult(q, params);
    } catch (error) {
      try {
        this.db.prepare(sql);
      } catch (prepareError) {
        return mapSqliteError(prepareError, {
          totalChanges: this.readTotalChanges(),
          inTransaction: this.txnOpen,
          phase: "prepare",
        });
      }
      return mapSqliteError(error, {
        totalChanges: this.readTotalChanges(),
        inTransaction: this.txnOpen,
        phase: "step",
      });
    }
  }

  prepare(sql: string): ContractStatement {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    try {
      const stmt = this.db.prepare(sql);
      return new RealSqliteStatement(stmt, this);
    } catch (error) {
      const mapped = mapSqliteError(error, {
        totalChanges: this.readTotalChanges(),
        inTransaction: this.txnOpen,
        phase: "prepare",
      });
      throw new Error(mapped.error?.message ?? "prepare failed", {
        cause: { category: mapped.error?.category satisfies ErrorCategory | undefined },
      });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.transaction(fn)();
  }

  snapshot(): Uint8Array {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.serialize();
  }

  restore(bytes: Uint8Array): void {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    this.db.close();
    this.db = BunDatabase.deserialize(bytes);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.lastChanges = 0;
    this.lastInsertRowid = 0;
    this.txnOpen = false;
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  inTransaction(): boolean {
    return !this.closed && this.txnOpen;
  }

  totalChanges(): number {
    return this.closed ? 0 : this.readTotalChanges();
  }

  private closedError(): QueryResult {
    return failResult(normalizeError("Database is closed", "misuse", { sqliteCode: "SQLITE_MISUSE", phase: "step" }));
  }
}
