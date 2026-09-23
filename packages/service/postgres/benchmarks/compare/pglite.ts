import { PGlite } from "@electric-sql/pglite";
import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

/**
 * PGlite comparison engine (real Postgres compiled to WASM, in-process).
 *
 * A single PGlite instance is shared across the whole benchmark run because
 * booting one is expensive (hundreds of ms); each engine "creation" resets the
 * public schema to a pristine state instead. `close()` only rolls back any
 * open transaction so isolateIterations specs stay cheap.
 */

let shared: Promise<PGlite> | null = null;

async function getShared(): Promise<PGlite> {
  if (!shared) {
    shared = (async () => {
      const db = new PGlite();
      await db.waitReady;
      // PGlite's WASM boot leaks process.exitCode = 99 (electric-sql/pglite#975).
      process.exitCode = 0;
      return db;
    })();
  }
  return shared;
}

async function reset(db: PGlite): Promise<void> {
  try {
    await db.query("ROLLBACK");
  } catch {
    // not in a transaction
  }
  await db.exec("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

export async function createPgliteEngine(): Promise<BenchEngine> {
  const db = await getShared();
  await reset(db);
  const prepare = (sql: string): BenchStatement => ({
    run: async (...params: unknown[]) => {
      const res = await db.query(sql, params);
      return { rowCount: res.affectedRows ?? 0 };
    },
    all: async <T = Record<string, unknown>>(...params: unknown[]) => (await db.query<T>(sql, params)).rows,
    get: async <T = Record<string, unknown>>(...params: unknown[]) => (await db.query<T>(sql, params)).rows[0],
  });
  return {
    name: "pglite",
    exec: async (sql, params = []) => {
      if (params.length > 0) await db.query(sql, params);
      else await db.exec(sql);
    },
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await db.query<T>(sql, params)).rows,
    prepare,
    transaction: async <T>(fn: () => Promise<T>) => {
      await db.exec("BEGIN");
      try {
        const value = await fn();
        await db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {
          // already aborted
        }
        throw error;
      }
    },
    snapshot: async () => {
      throw new Error("pglite engine does not support snapshot()");
    },
    restore: async () => {
      throw new Error("pglite engine does not support restore()");
    },
    close: async () => {
      try {
        await db.query("ROLLBACK");
      } catch {
        // not in a transaction
      }
    },
  };
}

export const pgliteFactory: NamedFactory = { name: "pglite", create: createPgliteEngine };
