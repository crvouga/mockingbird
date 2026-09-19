import { expect, test } from "bun:test";
import { Database } from "../../src/index.ts";
import { expectParity } from "../harness/assert.ts";
import { matrixBoth } from "../harness/matrix.ts";
import type { CompareOptions } from "../harness/normalize.ts";
import { expectStateParity } from "../harness/state-dump.ts";
import type { ContractDb, ErrorCategory, SqlValue } from "../harness/types.ts";

export async function setupBoth(memory: ContractDb, postgres: ContractDb, statements: string[]): Promise<void> {
  for (const sql of statements) {
    const a = await memory.exec(sql);
    const b = await postgres.exec(sql);
    expect(a.ok, `memory setup failed: ${sql}: ${a.error?.message}`).toBe(true);
    expect(b.ok, `postgres setup failed: ${sql}: ${b.error?.message}`).toBe(true);
  }
}

/** Differential query: run against both backends and require identical results. */
export function parity(
  name: string,
  setup: string[],
  sql: string,
  params?: SqlValue[],
  options?: CompareOptions,
): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    expectParity(await memory.query(sql, params), await postgres.query(sql, params), {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      ...options,
    });
  });
}

/** Like parity, but allows a tiny epsilon on float cells (ts_rank noise). */
export function rankParity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  parity(name, setup, sql, params, { realEpsilon: 1e-12 });
}

/** Differential write: compare affected-row counts and command tags too. */
export function execParity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    expectParity(await memory.exec(sql, params), await postgres.exec(sql, params), {
      ignoreSession: true,
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
    });
  });
}

/** Statements where write counters are not meaningfully comparable across drivers. */
const COUNTER_NEUTRAL_SQL =
  /^\s*(CREATE|DROP|ALTER|BEGIN|START|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|SHOW|TRUNCATE|GRANT|REVOKE|COMMENT|VACUUM|ANALYZE|PREPARE|DEALLOCATE|REFRESH)\b/i;

export function sequenceParity(
  name: string,
  setup: string[],
  steps: Array<{ sql: string; query?: boolean; params?: SqlValue[]; neutralizeCounters?: boolean }>,
  options?: { compareFinalState?: boolean; neutralizeAllWrites?: boolean },
): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    for (const step of steps) {
      const a = step.query ? await memory.query(step.sql, step.params) : await memory.exec(step.sql, step.params);
      const b = step.query ? await postgres.query(step.sql, step.params) : await postgres.exec(step.sql, step.params);
      const neutralize =
        step.neutralizeCounters ||
        options?.neutralizeAllWrites ||
        (!step.query && a.ok && b.ok && COUNTER_NEUTRAL_SQL.test(step.sql));
      expectParity(a, b, {
        ignoreSession: true,
        ignoreErrorPhase: true,
        ...(neutralize ? { ignoreWriteCounters: true } : {}),
      });
    }
    if (options?.compareFinalState) {
      await expectStateParity(memory, postgres);
    }
  });
}

/** Both backends must fail with the same SQLSTATE-derived category. */
export function errorParity(
  name: string,
  setup: string[],
  sql: string,
  category?: ErrorCategory,
  options?: CompareOptions,
): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    const a = await memory.exec(sql);
    const b = await postgres.exec(sql);
    expect(a.ok, `memory unexpectedly succeeded: ${sql}`).toBe(false);
    expect(b.ok, `postgres unexpectedly succeeded: ${sql}`).toBe(false);
    expectParity(a, b, {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      messageTier: "B",
      ...options,
    });
    if (category) {
      expect(a.error?.category).toBe(category);
      expect(b.error?.category).toBe(category);
    }
  });
}

export function queryErrorParity(
  name: string,
  setup: string[],
  sql: string,
  category?: ErrorCategory,
  options?: CompareOptions,
): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    const a = await memory.query(sql);
    const b = await postgres.query(sql);
    expect(a.ok, `memory unexpectedly succeeded: ${sql}`).toBe(false);
    expect(b.ok, `postgres unexpectedly succeeded: ${sql}`).toBe(false);
    expectParity(a, b, {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      messageTier: "B",
      ...options,
    });
    if (category) expect(a.error?.category).toBe(category);
  });
}

/** Differential query plus pg_typeof() of each result column. */
export function parityTyped(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    const inner = sql.replace(/;\s*$/, "");
    expectParity(await memory.query(inner, params), await postgres.query(inner, params), {
      ignoreWriteCounters: true,
    });
    const sample = await memory.query(inner, params);
    if (!sample.ok || sample.columns.length === 0) return;
    const typeSelect = sample.columns
      .map((column, index) => `pg_typeof(${quoteIdent(column)})::text AS t${index}`)
      .join(", ");
    const typedSql = `SELECT ${typeSelect} FROM (${inner}) AS _q`;
    expectParity(await memory.query(typedSql, params), await postgres.query(typedSql, params), {
      ignoreWriteCounters: true,
    });
  });
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Documented divergence: assert postgres-mem behavior, not oracle equality. */
export function divergence(id: string, title: string, fn: (db: Database) => void | Promise<void>): void {
  test(`${id}: ${title}`, async () => {
    const db = new Database();
    try {
      await fn(db);
    } finally {
      db.close();
    }
  });
}
