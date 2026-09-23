import { expect } from "bun:test";
import { type CompareOptions, deepCompareResults, normalizeError } from "./normalize.ts";
import type { QueryResult, RowidJsKind, SqlValue } from "./types.ts";

export function expectParity(a: QueryResult, b: QueryResult, options?: CompareOptions): void {
  const queryShaped = (a.columns?.length ?? 0) > 0 || (b.columns?.length ?? 0) > 0;
  const bothFailed = a.ok === false && b.ok === false;
  const comparison = deepCompareResults(a, b, {
    // SELECT leftovers: sqlite-mem `query()` reports db.changes from the last DML; bun:sqlite often reports 0.
    ignoreWriteCounters: queryShaped,
    // Oracle often fails at prepare; sqlite-mem at step. Category + message remain the contract.
    ignoreErrorPhase: bothFailed,
    // bun:sqlite SQLITE_MISUSE / SQLITE_CONSTRAINT_* vs engine SQLITE_ERROR for the same category.
    ignoreSqliteCode: bothFailed,
    ...options,
  });
  if (!comparison.equal) {
    expect(comparison.reason ?? "results differ").toBe(undefined);
  }
}

/** FTS bm25/rank: order-sensitive compare with ULP-scale real tolerance (1e-15). */
export function expectFtsRankParity(a: QueryResult, b: QueryResult): void {
  expectParity(a, b, { realEpsilon: 1e-15, ignoreWriteCounters: true });
}

function errorFromUnknown(error: unknown): QueryResult {
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    const err = error as {
      category?: QueryResult["error"] extends infer E ? (E extends { category: infer C } ? C : never) : never;
      message: string;
    };
    return {
      ok: false,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      lastInsertRowidKind: "number",
      totalChanges: 0,
      inTransaction: false,
      error: normalizeError(
        err.message,
        err.category as QueryResult["error"] extends { category: infer C } ? C : never,
      ),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    columns: [],
    rows: [],
    changes: 0,
    lastInsertRowid: 0,
    lastInsertRowidKind: "number",
    totalChanges: 0,
    inTransaction: false,
    error: normalizeError(message),
  };
}

export function runCatching(fn: () => QueryResult | undefined): QueryResult {
  try {
    const result = fn();
    if (result && typeof result === "object" && "ok" in result) {
      return result;
    }
    return {
      ok: true,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      lastInsertRowidKind: "number",
      totalChanges: 0,
      inTransaction: false,
    };
  } catch (error) {
    return errorFromUnknown(error);
  }
}

export function rowidKind(value: number | bigint): RowidJsKind {
  return typeof value === "bigint" ? "bigint" : "number";
}

export function okResult(
  columns: string[],
  rows: Record<string, SqlValue>[],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
  values?: SqlValue[][],
  extras?: Pick<QueryResult, "totalChanges" | "inTransaction">,
): QueryResult {
  return {
    ok: true,
    columns,
    rows,
    changes,
    lastInsertRowid,
    lastInsertRowidKind: rowidKind(lastInsertRowid),
    totalChanges: extras?.totalChanges ?? 0,
    inTransaction: extras?.inTransaction ?? false,
    ...(values ? { values } : {}),
  };
}
