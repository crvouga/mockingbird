import { describe, expect, test } from "bun:test";
import { categoryFromSqlstate, knownDivergenceIds, loadDivergences } from "./classify.ts";

describe("SQLSTATE classification", () => {
  test("specific codes map to their categories", () => {
    expect(categoryFromSqlstate("42601")).toBe("syntax");
    expect(categoryFromSqlstate("42P01")).toBe("undefined_table");
    expect(categoryFromSqlstate("42703")).toBe("undefined_column");
    expect(categoryFromSqlstate("42883")).toBe("undefined_function");
    expect(categoryFromSqlstate("23505")).toBe("constraint_unique");
    expect(categoryFromSqlstate("23502")).toBe("constraint_notnull");
    expect(categoryFromSqlstate("23514")).toBe("constraint_check");
    expect(categoryFromSqlstate("23503")).toBe("constraint_foreign");
    expect(categoryFromSqlstate("22012")).toBe("division_by_zero");
    expect(categoryFromSqlstate("0A000")).toBe("unsupported");
    expect(categoryFromSqlstate("21000")).toBe("cardinality");
  });

  test("class fallbacks cover unknown members", () => {
    expect(categoryFromSqlstate("22999")).toBe("data_exception");
    expect(categoryFromSqlstate("23999")).toBe("constraint");
    expect(categoryFromSqlstate("25P02")).toBe("transaction");
    expect(categoryFromSqlstate("42999")).toBe("syntax");
  });

  test("missing or malformed codes are other", () => {
    expect(categoryFromSqlstate(undefined)).toBe("other");
    expect(categoryFromSqlstate("")).toBe("other");
    expect(categoryFromSqlstate("4")).toBe("other");
    expect(categoryFromSqlstate("ZZ998")).toBe("other");
  });
});

describe("divergence register", () => {
  test("register loads with unique non-empty entries", () => {
    const file = loadDivergences();
    expect(file.version).toBe(1);
    expect(file.entries.length).toBeGreaterThan(0);
    const ids = knownDivergenceIds();
    expect(ids.size).toBe(file.entries.length);
    for (const entry of file.entries) {
      expect(entry.pinnedBy.length).toBeGreaterThan(0);
      expect(entry.predicate.length).toBeGreaterThan(0);
      expect(entry.specifiedBehavior.length).toBeGreaterThan(0);
    }
  });
});
