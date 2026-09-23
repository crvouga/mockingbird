import { Database as BunDatabase } from "bun:sqlite";
import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

function wrapStatement(stmt: ReturnType<BunDatabase["prepare"]>): BenchStatement {
  return {
    run: (...params: unknown[]) => {
      const result = stmt.run(...(params as never[]));
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    all: <T = Record<string, unknown>>(...params: unknown[]) => stmt.all(...(params as never[])) as T[],
    get: <T = Record<string, unknown>>(...params: unknown[]) => stmt.get(...(params as never[])) as T | undefined,
  };
}

export function createSqliteEngine(): BenchEngine {
  let db = new BunDatabase(":memory:");
  return {
    name: "bun-sqlite",
    exec: (sql, params = []) => {
      if (params.length === 0) db.exec(sql);
      else db.prepare(sql).run(...(params as never[]));
    },
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      return (params.length > 0 ? stmt.all(...(params as never[])) : stmt.all()) as T[];
    },
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    transaction: (fn) => db.transaction(fn)(),
    snapshot: () => new Uint8Array(db.serialize()),
    restore: (bytes) => {
      const next = BunDatabase.deserialize(bytes);
      db.close();
      db = next;
    },
    close: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

export const sqliteFactory: NamedFactory = { name: "bun-sqlite", create: createSqliteEngine };
