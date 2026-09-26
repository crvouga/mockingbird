import { expect, test } from "bun:test";
import { Database } from "../../src/index.ts";
import { expectParity } from "../harness/assert.ts";
import { matrixBoth } from "../harness/matrix.ts";
import type { CompareOptions } from "../harness/normalize.ts";
import { expectStateParity } from "../harness/state-dump.ts";
import type { ContractDb, ErrorCategory, SqlValue } from "../harness/types.ts";

export function setupBoth(memory: ContractDb, sqlite: ContractDb, statements: string[]): void {
  for (const sql of statements) {
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok, `memory setup failed: ${sql}: ${a.error?.message}`).toBe(true);
    expect(b.ok, `sqlite setup failed: ${sql}: ${b.error?.message}`).toBe(true);
  }
}

export function parity(
  name: string,
  setup: string[],
  sql: string,
  params?: SqlValue[],
  options?: CompareOptions,
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    expectParity(memory.query(sql, params), sqlite.query(sql, params), {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      ...options,
    });
  });
}

/** Like parity, but allows 1e-15 absolute epsilon on REAL (FTS bm25/rank ULP noise). */
export function ftsRankParity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    expectParity(memory.query(sql, params), sqlite.query(sql, params), {
      realEpsilon: 1e-15,
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
    });
  });
}

export function execParity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    expectParity(memory.exec(sql, params), sqlite.exec(sql, params), {
      ignoreSession: true,
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
    });
  });
}

/** Statements where write counters are not meaningfully comparable across drivers. */
const COUNTER_NEUTRAL_SQL =
  /^\s*(CREATE|DROP|ALTER|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ANALYZE|REINDEX|VACUUM|ATTACH|DETACH)\b/i;

function shouldNeutralizeCounters(sql: string): boolean {
  return COUNTER_NEUTRAL_SQL.test(sql);
}

export function sequenceParity(
  name: string,
  setup: string[],
  steps: Array<{ sql: string; query?: boolean; params?: SqlValue[]; neutralizeCounters?: boolean }>,
  options?: { compareFinalState?: boolean; neutralizeAllWrites?: boolean },
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    for (const step of steps) {
      const a = step.query ? memory.query(step.sql, step.params) : memory.exec(step.sql, step.params);
      const b = step.query ? sqlite.query(step.sql, step.params) : sqlite.exec(step.sql, step.params);
      const neutralize =
        step.neutralizeCounters ||
        options?.neutralizeAllWrites ||
        (!step.query && a.ok && b.ok && shouldNeutralizeCounters(step.sql));
      if (neutralize && !step.query && a.ok && b.ok) {
        // DDL / transaction / pragma counters are not consistently defined across drivers.
        expectParity(
          { ...a, changes: 0, lastInsertRowid: 0, totalChanges: 0 },
          { ...b, changes: 0, lastInsertRowid: 0, totalChanges: 0 },
          { ignoreWriteCounters: true, ignoreSession: true },
        );
      } else {
        // DML compares live changes/lastInsertRowid; SELECTs still ignore counters via expectParity.
        expectParity(a, b, {
          ignoreSession: true,
          ignoreErrorPhase: true,
        });
      }
    }
    if (options?.compareFinalState) {
      expectStateParity(memory, sqlite);
    }
  });
}

export function errorParity(
  name: string,
  setup: string[],
  sql: string,
  category?: ErrorCategory,
  options?: CompareOptions,
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expectParity(a, b, {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      ignoreSqliteCode: true,
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
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.query(sql);
    const b = sqlite.query(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expectParity(a, b, {
      ignoreWriteCounters: true,
      ignoreErrorPhase: true,
      ignoreSqliteCode: true,
      messageTier: "B",
      ...options,
    });
    if (category) expect(a.error?.category).toBe(category);
  });
}

/** Differential query plus typeof() of each result column. */
export function parityTyped(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const inner = sql.replace(/;\s*$/, "");
    expectParity(memory.query(inner, params), sqlite.query(inner, params), { ignoreWriteCounters: true });
    const sample = memory.query(inner, params);
    if (!sample.ok || sample.columns.length === 0) return;
    const typeSelect = sample.columns.map((column, index) => `typeof(${quoteIdent(column)}) AS t${index}`).join(", ");
    const typedSql = `SELECT ${typeSelect} FROM (${inner})`;
    expectParity(memory.query(typedSql, params), sqlite.query(typedSql, params), { ignoreWriteCounters: true });
  });
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Documented divergence: assert sqlite-mem behavior, not oracle equality. */
export function divergence(id: string, title: string, fn: (db: Database) => void): void {
  test(`${id}: ${title}`, () => {
    const db = new Database();
    try {
      fn(db);
    } finally {
      db.close();
    }
  });
}
