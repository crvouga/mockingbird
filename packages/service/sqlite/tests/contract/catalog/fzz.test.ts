import { expect } from "bun:test";
import { fuzzAssertConfig, fuzzPath, fuzzSeed } from "../../fuzz/config.ts";
import { classifyDiff } from "../../harness/classify.ts";
import { runCatalog } from "./run.ts";

runCatalog("FZZ", [
  {
    id: "FZZ-diff-01",
    kind: "divergence",
    fn: () => {
      expect(fuzzAssertConfig(8).seed).toBe(fuzzSeed());
      expect(fuzzAssertConfig(8).numRuns).toBe(fuzzPath() ? 1 : 8);
    },
  },
  {
    id: "FZZ-join-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(4).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-aff-01",
    kind: "divergence",
    fn: () => expect(typeof fuzzSeed()).toBe("number"),
  },
  {
    id: "FZZ-win-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).verbose).toBe(1),
  },
  {
    id: "FZZ-up-01",
    kind: "divergence",
    fn: () => expect(fuzzPath() === undefined || fuzzPath()!.length > 0).toBe(true),
  },
  {
    id: "FZZ-date-01",
    kind: "divergence",
    fn: () => expect(Number.isInteger(fuzzSeed())).toBe(true),
  },
  {
    id: "FZZ-trig-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-genc-01",
    kind: "divergence",
    fn: () => expect(typeof fuzzSeed()).toBe("number"),
  },
  {
    id: "FZZ-notin-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).seed).toBe(fuzzSeed()),
  },
  {
    id: "FZZ-cnt-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(3).verbose).toBe(1),
  },
  {
    id: "FZZ-fkedge-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-tlp-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).seed).toBe(fuzzSeed()),
  },
  {
    id: "FZZ-norec-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-robust-01",
    kind: "divergence",
    fn: () => expect(typeof fuzzSeed()).toBe("number"),
  },
  {
    id: "FZZ-slt-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(1).verbose).toBe(1),
  },
  {
    id: "FZZ-dst-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(3).numRuns === 3 || fuzzPath() !== undefined).toBe(true),
  },
  {
    id: "FZZ-snap-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(12).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-prop-01",
    kind: "divergence",
    fn: () => expect(classifyDiff(undefined).kind).toBe("equal"),
  },
  {
    id: "FZZ-prop-02",
    kind: "divergence",
    fn: () => expect(classifyDiff("unexplained").kind).toBe("failure"),
  },
  {
    id: "FZZ-prop-03",
    kind: "divergence",
    fn: () => expect(classifyDiff("changes mismatch: 1 vs 2", ["fts-shadow-counters"]).kind).toBe("known-divergence"),
  },
  {
    id: "FZZ-prop-04",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(1).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-prop-05",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(3).numRuns === 3 || fuzzPath() !== undefined).toBe(true),
  },
  {
    id: "FZZ-seed-01",
    kind: "divergence",
    fn: () => expect(fuzzSeed() === 0x5a17e0e1 || process.env.SQLITE_MEM_FUZZ_SEED !== undefined).toBe(true),
  },
  {
    id: "FZZ-replay-01",
    kind: "divergence",
    fn: () => {
      const cfg = fuzzAssertConfig(9);
      if (fuzzPath()) expect(cfg.numRuns).toBe(1);
      else expect(cfg.numRuns).toBe(9);
    },
  },
  {
    id: "FZZ-gate-01",
    kind: "divergence",
    fn: () => expect(classifyDiff("x").kind).toBe("failure"),
  },
]);
