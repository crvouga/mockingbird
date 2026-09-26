import alasql from "alasql";
import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

type AlasqlDb = {
  databaseid: string;
  exec: (sql: string, params?: unknown[]) => unknown;
  tables: Record<string, unknown>;
};

type CompiledFn = (params?: unknown[]) => unknown;

let dbSeq = 0;

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result == null) return [];
  return [result as T];
}

function wrapCompiled(fn: CompiledFn): BenchStatement {
  return {
    run: (...params: unknown[]) => {
      const result = fn(params.length ? params : undefined);
      const changes = typeof result === "number" ? result : 0;
      return { changes, lastInsertRowid: 0 };
    },
    all: <T = Record<string, unknown>>(...params: unknown[]) => asRows<T>(fn(params.length ? params : undefined)),
    get: <T = Record<string, unknown>>(...params: unknown[]) => {
      const rows = asRows<T>(fn(params.length ? params : undefined));
      return rows[0];
    },
  };
}

/**
 * AlaSQL adapter for fair JS-SQL comparison benches.
 *
 * Prepared statements use `alasql.compile` after `alasql.use(databaseid)` so
 * compiled functions resolve tables in this Database instance.
 * In-memory transactions are best-effort (BEGIN/COMMIT TRANSACTION).
 * Snapshots are unsupported.
 */
export function createAlasqlEngine(): BenchEngine {
  const id = `sqlite_mem_bench_${++dbSeq}`;
  const db = new alasql.Database(id) as AlasqlDb;
  alasql.use(id);

  const withDb = <T>(fn: () => T): T => {
    alasql.use(id);
    return fn();
  };

  return {
    name: "alasql",
    exec: (sql, params = []) => {
      withDb(() => {
        if (params.length === 0) db.exec(sql);
        else db.exec(sql, params);
      });
    },
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      withDb(() => asRows<T>(params.length === 0 ? db.exec(sql) : db.exec(sql, params))),
    prepare: (sql) =>
      withDb(() => {
        const compiled = alasql.compile(sql) as CompiledFn;
        return wrapCompiled((params) => {
          alasql.use(id);
          return compiled(params);
        });
      }),
    transaction: <T>(fn: () => T): T =>
      withDb(() => {
        try {
          db.exec("BEGIN TRANSACTION");
        } catch {
          // In-memory AlaSQL may not fully support TX; still run fn.
          return fn();
        }
        try {
          const value = fn();
          try {
            db.exec("COMMIT TRANSACTION");
          } catch {
            // ignore
          }
          return value;
        } catch (error) {
          try {
            db.exec("ROLLBACK TRANSACTION");
          } catch {
            // ignore
          }
          throw error;
        }
      }),
    snapshot: () => {
      throw new Error("alasql adapter does not support snapshot()");
    },
    restore: () => {
      throw new Error("alasql adapter does not support restore()");
    },
    close: () => {
      try {
        alasql.use(id);
        for (const name of Object.keys(db.tables ?? {})) {
          try {
            db.exec(`DROP TABLE IF EXISTS ${name}`);
          } catch {
            // ignore
          }
        }
      } finally {
        try {
          delete alasql.databases[id];
        } catch {
          // ignore
        }
        if (alasql.databases.alasql) alasql.use("alasql");
      }
    },
  };
}

export const alasqlFactory: NamedFactory = { name: "alasql", create: createAlasqlEngine };

export async function tryLoadAlasqlFactory(): Promise<NamedFactory | null> {
  try {
    // Re-import validates the package is resolvable in this environment.
    await import("alasql");
    return alasqlFactory;
  } catch {
    return null;
  }
}
