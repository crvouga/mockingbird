import { Database } from "../../src/index.ts";
import { ExecutionEnv } from "../../src/executor/env.ts";
import { executeStatement } from "../../src/executor/execute.ts";
import type { ResultSet } from "../../src/executor/result.ts";
import { defaultFunctionRegistry } from "../../src/functions/registry.ts";
import { parseUnits } from "../../src/parser/index.ts";
import { deepCompareResults } from "../harness/normalize.ts";
import { expect } from "bun:test";

function envFor(
  db: Database,
  params: readonly unknown[] = [],
  flags?: { forceFullSelect?: boolean; forceFullInsert?: boolean },
): ExecutionEnv {
  const hooks = {
    now: () => db.now(),
    random: () => db.prng.next(),
    randomU64: () => db.prng.nextU64(),
  };
  const env = new ExecutionEnv(db.state, db.transactions, params, defaultFunctionRegistry, hooks);
  if (flags?.forceFullSelect) env.forceFullSelect = true;
  if (flags?.forceFullInsert) env.forceFullInsert = true;
  return env;
}

export function runInternal(
  db: Database,
  sql: string,
  flags?: { forceFullSelect?: boolean; forceFullInsert?: boolean },
): ResultSet {
  const stmt = parseUnits(sql)[0]?.statement;
  if (!stmt) throw new Error("empty sql");
  return executeStatement(stmt, envFor(db, [], flags));
}

export function expectFastFullSelectParity(db: Database, sql: string): void {
  const fast = runInternal(db, sql, { forceFullSelect: false });
  const full = runInternal(db, sql, { forceFullSelect: true });
  const comparison = deepCompareResults(
    {
      ok: true,
      columns: fast.columns,
      rows: fast.rows,
      changes: fast.changes,
      lastInsertRowid: fast.lastInsertRowid,
      totalChanges: fast.totalChanges,
    },
    {
      ok: true,
      columns: full.columns,
      rows: full.rows,
      changes: full.changes,
      lastInsertRowid: full.lastInsertRowid,
      totalChanges: full.totalChanges,
    },
    { ignoreWriteCounters: true },
  );
  expect(comparison.equal, comparison.reason ?? "fast vs full select differ").toBe(true);
}

export function expectFastFullInsertParity(
  setupSql: string[],
  insertSql: string,
  probeSql = "SELECT id, a, b FROM t ORDER BY id",
): void {
  const seed = new Database({ seed: 1 });
  for (const sql of setupSql) seed.exec(sql);
  const fastDb = seed.snapshot().open();
  const fullDb = seed.snapshot().open();
  runInternal(fastDb, insertSql, { forceFullInsert: false });
  runInternal(fullDb, insertSql, { forceFullInsert: true });
  expect(fastDb.query(probeSql)).toEqual(fullDb.query(probeSql));
  expect(fastDb.totalChanges).toBe(fullDb.totalChanges);
}
