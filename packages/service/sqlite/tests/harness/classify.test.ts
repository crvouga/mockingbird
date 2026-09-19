import { describe, expect, test } from "bun:test";
import { classifyDiff, knownDivergenceIds, loadDivergences } from "./classify.ts";

describe("divergence classifier", () => {
  test("loads a finite 𝔇 inventory", () => {
    const file = loadDivergences();
    expect(file.entries.length).toBeGreaterThan(5);
    expect(knownDivergenceIds().has("negzero-canonicalization")).toBe(true);
  });

  test("equal when no reason", () => {
    expect(classifyDiff(undefined)).toEqual({ kind: "equal" });
  });

  test("unexplained diffs are FAILURE", () => {
    expect(classifyDiff("value mismatch at row 0")).toEqual({
      kind: "failure",
      reason: "value mismatch at row 0",
    });
  });

  test("allowed 𝔇 ids classify as known-divergence", () => {
    expect(classifyDiff("changes mismatch: 2 vs 3", ["fts-shadow-counters"])).toEqual({
      kind: "known-divergence",
      id: "fts-shadow-counters",
    });
  });

  test("synthetic diffs never stay unexplained when classified", () => {
    const samples = ["ok mismatch: true vs false", "error category mismatch: syntax vs other", "column count mismatch"];
    for (const reason of samples) {
      const classified = classifyDiff(reason);
      expect(classified.kind === "failure" || classified.kind === "known-divergence").toBe(true);
      if (classified.kind === "failure") expect(classified.reason).toBe(reason);
    }
  });
});
