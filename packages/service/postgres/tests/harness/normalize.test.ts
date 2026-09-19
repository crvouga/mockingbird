import { describe, expect, test } from "bun:test";
import { deepCompareResults, normalizeErrorMessage, normalizeErrorMessageForCompare } from "./normalize.ts";
import type { QueryResult } from "./types.ts";

function ok(columns: string[], values: (string | null)[][], changes = 0): QueryResult {
  return { ok: true, columns, values, rows: [], changes, inTransaction: false };
}

describe("error message normalization", () => {
  test("strips engine prefixes and collapses whitespace", () => {
    expect(normalizeErrorMessage('PostgresError: relation "t" does not exist')).toBe('relation "t" does not exist');
    expect(normalizeErrorMessage("error:   syntax   error")).toBe("syntax error");
    expect(normalizeErrorMessage("first line\nDETAIL: second")).toBe("first line");
  });

  test("tier-B compare strips positions and constraint names", () => {
    expect(normalizeErrorMessageForCompare('syntax error at or near "frmo" at character 10')).toBe(
      'syntax error at or near "?"',
    );
    expect(normalizeErrorMessageForCompare('duplicate key value violates unique constraint "t_a_key"')).toBe(
      'duplicate key value violates unique constraint "?"',
    );
  });
});

describe("deepCompareResults", () => {
  test("equal results compare equal", () => {
    const a = ok(["v"], [["1"]]);
    expect(deepCompareResults(a, ok(["v"], [["1"]])).equal).toBe(true);
  });

  test("value mismatch is reported with position", () => {
    const r = deepCompareResults(ok(["v"], [["1"]]), ok(["v"], [["2"]]));
    expect(r.equal).toBe(false);
    expect(r.reason).toContain("value mismatch at row 0");
  });

  test("column name mismatch is caught unless ignored", () => {
    const a = ok(["x"], [["1"]]);
    const b = ok(["y"], [["1"]]);
    expect(deepCompareResults(a, b).equal).toBe(false);
    expect(deepCompareResults(a, b, { ignoreColumnNames: true }).equal).toBe(true);
  });

  test("unordered compare sorts both row sets", () => {
    const a = ok(["v"], [["1"], ["2"]]);
    const b = ok(["v"], [["2"], ["1"]]);
    expect(deepCompareResults(a, b).equal).toBe(false);
    expect(deepCompareResults(a, b, { unordered: true }).equal).toBe(true);
  });

  test("null and empty string are distinct", () => {
    const r = deepCompareResults(ok(["v"], [[null]]), ok(["v"], [[""]]));
    expect(r.equal).toBe(false);
  });

  test("realEpsilon tolerates float noise only within bound", () => {
    const a = ok(["v"], [["0.30000000000000004"]]);
    const b = ok(["v"], [["0.3"]]);
    expect(deepCompareResults(a, b).equal).toBe(false);
    expect(deepCompareResults(a, b, { realEpsilon: 1e-9 }).equal).toBe(true);
  });

  test("write counters compare unless ignored", () => {
    const a = ok(["v"], [], 1);
    const b = ok(["v"], [], 2);
    expect(deepCompareResults(a, b).equal).toBe(false);
    expect(deepCompareResults(a, b, { ignoreWriteCounters: true }).equal).toBe(true);
  });

  test("error results compare by category, sqlstate, and message tier", () => {
    const err = (message: string, sqlstate: string): QueryResult => ({
      ok: false,
      columns: [],
      values: [],
      rows: [],
      changes: 0,
      inTransaction: false,
      error: { category: "syntax", message, sqlstate },
    });
    const a = err('syntax error at or near "x" at character 3', "42601");
    const b = err('syntax error at or near "y" at character 9', "42601");
    expect(deepCompareResults(a, b).equal).toBe(true);
    expect(deepCompareResults(a, b, { messageTier: "A" }).equal).toBe(false);
  });
});
