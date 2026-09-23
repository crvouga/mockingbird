import { describe, expect, test } from "bun:test";
import { deepCompareResults, normalizeValue, valuesEqual } from "./normalize.ts";
import type { QueryResult } from "./types.ts";

function ok(partial: {
  columns: string[];
  values: unknown[][];
  changes?: number;
  lastInsertRowid?: number;
}): QueryResult {
  return {
    ok: true,
    columns: partial.columns,
    rows: partial.values.map((row) => Object.fromEntries(partial.columns.map((c, i) => [c, row[i] ?? null]))),
    values: partial.values as never,
    changes: partial.changes ?? 0,
    lastInsertRowid: partial.lastInsertRowid ?? 0,
  };
}

describe("comparator integrity", () => {
  test("distinguishes INTEGER vs REAL normalized kinds", () => {
    expect(normalizeValue(1).kind).toBe("integer");
    expect(normalizeValue(1.5).kind).toBe("real");
  });

  test("BLOB compares by bytes, not string", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(valuesEqual(a, b)).toBe(true);
    expect(valuesEqual(a, c)).toBe(false);
    expect(valuesEqual(a, "1,2,3")).toBe(false);
  });

  test("NULL is only equal to NULL", () => {
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, 0)).toBe(false);
    expect(valuesEqual(null, "")).toBe(false);
  });

  test("deepCompareResults catches row value divergence", () => {
    const result = deepCompareResults(ok({ columns: ["x"], values: [[1]] }), ok({ columns: ["x"], values: [[2]] }));
    expect(result.equal).toBe(false);
  });

  test("deepCompareResults catches positional value swap", () => {
    expect(
      deepCompareResults(ok({ columns: ["a", "b"], values: [[1, 2]] }), ok({ columns: ["a", "b"], values: [[2, 1]] }))
        .equal,
    ).toBe(false);
  });

  test("does not treat bigint and float as equal", () => {
    expect(valuesEqual(1n, 1.5)).toBe(false);
  });
});
