import { Database, Snapshot, type Statement } from "../../src/index.ts";
import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

type BindValue = Parameters<Statement["run"]>[number];

function wrapStatement(stmt: Statement): BenchStatement {
  return {
    run: async (...params: unknown[]) => stmt.run(...(params as BindValue[])),
    all: async <T = Record<string, unknown>>(...params: unknown[]) => stmt.all<T>(...(params as BindValue[])),
    get: async <T = Record<string, unknown>>(...params: unknown[]) => stmt.get<T>(...(params as BindValue[])),
  };
}

export function createMemEngine(): BenchEngine {
  let db = new Database();
  return {
    name: "postgres-mem",
    exec: async (sql, params = []) => {
      if (params.length > 0) db.prepare(sql).run(...(params as BindValue[]));
      else db.exec(sql);
    },
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.query<T>(sql, params as BindValue[]),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    transaction: async <T>(fn: () => Promise<T>) => {
      db.exec("BEGIN");
      try {
        const value = await fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    snapshot: async () => db.snapshot().encode(),
    restore: async (bytes) => {
      db.close();
      db = Snapshot.decode(bytes).open();
    },
    close: async () => db.close(),
  };
}

export const memFactory: NamedFactory = { name: "postgres-mem", create: createMemEngine };
