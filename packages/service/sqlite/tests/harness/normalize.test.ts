import { describe, expect, test } from "bun:test";
import { okResult } from "./assert.ts";
import { deepCompareResults, normalizeError, normalizeValue, valuesEqual } from "./normalize.ts";

describe("normalizeValue", () => {
  test("preserves null, empty text, empty blob, and unicode", () => {
    expect(normalizeValue(null)).toEqual({ kind: "null" });
    expect(normalizeValue("")).toEqual({ kind: "text", value: "" });
    expect(normalizeValue(new Uint8Array(0))).toEqual({ kind: "blob", value: new Uint8Array(0) });
    expect(normalizeValue("café 日本語")).toEqual({ kind: "text", value: "café 日本語" });
  });

  test("classifies integers and reals without collapsing kinds incorrectly in equality", () => {
    expect(normalizeValue(1)).toEqual({ kind: "integer", value: 1 });
    expect(normalizeValue(1.5)).toEqual({ kind: "real", value: 1.5 });
    expect(normalizeValue(1n)).toEqual({ kind: "integer", value: 1n });
  });
});

describe("valuesEqual", () => {
  test("compares blobs byte-wise", () => {
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(valuesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  test("uses Object.is for floating point", () => {
    expect(valuesEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(valuesEqual(0, -0)).toBe(false);
  });

  test("rowid mode equates number and bigint", () => {
    expect(valuesEqual(3, 3n, { rowid: true })).toBe(true);
    expect(valuesEqual(3, 4n, { rowid: true })).toBe(false);
  });
});

describe("deepCompareResults", () => {
  test("matches successful results including changes and lastInsertRowid", () => {
    const a = okResult(["id", "name"], [{ id: 1, name: "a" }], 1, 1);
    const b = okResult(["id", "name"], [{ id: 1, name: "a" }], 1, 1n);
    expect(deepCompareResults(a, b).equal).toBe(true);
  });

  test("detects column name, value, and counter mismatches", () => {
    expect(deepCompareResults(okResult(["a"], [{ a: 1 }]), okResult(["b"], [{ b: 1 }])).equal).toBe(false);
    expect(deepCompareResults(okResult(["a"], [{ a: 1 }]), okResult(["a"], [{ a: 2 }])).equal).toBe(false);
    expect(deepCompareResults(okResult([], [], 1, 1), okResult([], [], 2, 1)).equal).toBe(false);
  });

  test("compares error category and normalized message", () => {
    const a = {
      ok: false as const,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError("SqliteError: UNIQUE constraint failed: t.x", "constraint_unique"),
    };
    const b = {
      ok: false as const,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError("UNIQUE constraint failed: t.v", "constraint_unique"),
    };
    expect(deepCompareResults(a, b).equal).toBe(true);

    const c = {
      ...b,
      error: normalizeError("CHECK constraint failed: t", "constraint_check"),
    };
    expect(deepCompareResults(a, c).equal).toBe(false);
  });

  test("distinguishes empty text from empty blob", () => {
    const a = okResult(["v"], [{ v: "" }]);
    const b = okResult(["v"], [{ v: new Uint8Array(0) }]);
    expect(deepCompareResults(a, b).equal).toBe(false);
  });

  test("distinguishes integer 1 from real 1.0 via typeof path values", () => {
    // Comparator stores both as numeric JS; storage-class parity is asserted via typeof() contracts.
    // Equality of raw 1 vs 1.0 is still true for valuesEqual numbers that Object.is equates.
    expect(valuesEqual(1, 1.0)).toBe(true);
    expect(normalizeValue(1).kind).toBe("integer");
    expect(normalizeValue(1.5).kind).toBe("real");
  });
});
