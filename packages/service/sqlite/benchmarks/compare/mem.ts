import { Database, Snapshot } from "../../src/index.ts";
import type { NamedFactory } from "../harness/types.ts";
import type { BenchEngine, BenchStatement } from "../harness/types.ts";

function wrapStatement(stmt: ReturnType<Database["prepare"]>): BenchStatement {
  return {
    run: (...params: unknown[]) => stmt.run(...params),
    all: <T = Record<string, unknown>>(...params: unknown[]) => stmt.all<T>(...params),
    get: <T = Record<string, unknown>>(...params: unknown[]) => stmt.get<T>(...params),
  };
}

export function createMemEngine(): BenchEngine {
  let db = new Database();
  return {
    name: "sqlite-mem",
    exec: (sql, params = []) => {
      if (params.length > 0) db.prepare(sql).run(...params);
      else db.exec(sql);
    },
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    transaction: (fn) => db.transaction(fn),
    snapshot: () => db.snapshot().encode(),
    restore: (bytes) => {
      db.close();
      db = Snapshot.decode(bytes).open();
    },
    close: () => db.close(),
  };
}

export const memFactory: NamedFactory = { name: "sqlite-mem", create: createMemEngine };
