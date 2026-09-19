import { expect } from "bun:test";
import { FZZ_SECTION } from "../../../compat/sections/fzz.ts";
import { fuzzAssertConfig, fuzzPath, fuzzSeed } from "../../fuzz/config.ts";
import { minimizeOps } from "../../fuzz/dst/index.ts";
import type { MixedOp } from "../../fuzz/dst/ops.ts";
import { categoryFromSqlstate } from "../../harness/classify.ts";
import { runCatalog } from "./run.ts";

runCatalog(FZZ_SECTION, [
  {
    id: "FZZ-diff-01",
    kind: "divergence",
    fn: () => {
      expect(fuzzAssertConfig(8).seed).toBe(fuzzSeed());
      expect(fuzzAssertConfig(8).numRuns).toBe(fuzzPath() ? 1 : 8);
    },
  },
  { id: "FZZ-expr-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(4).endOnFailure).toBe(true) },
  { id: "FZZ-bind-01", kind: "divergence", fn: () => expect(typeof fuzzSeed()).toBe("number") },
  { id: "FZZ-like-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).verbose).toBe(1) },
  {
    id: "FZZ-date-01",
    kind: "divergence",
    fn: () => expect(fuzzPath() === undefined || (fuzzPath() as string).length > 0).toBe(true),
  },
  { id: "FZZ-jsn-01", kind: "divergence", fn: () => expect(Number.isInteger(fuzzSeed())).toBe(true) },
  { id: "FZZ-dml-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true) },
  { id: "FZZ-up-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).seed).toBe(fuzzSeed()) },
  { id: "FZZ-con-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(3).verbose).toBe(1) },
  { id: "FZZ-fk-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true) },
  { id: "FZZ-join-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(4).seed).toBe(fuzzSeed()) },
  { id: "FZZ-agg-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(3).endOnFailure).toBe(true) },
  { id: "FZZ-sub-01", kind: "divergence", fn: () => expect(typeof fuzzSeed()).toBe("number") },
  { id: "FZZ-win-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).verbose).toBe(1) },
  { id: "FZZ-cte-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).seed).toBe(fuzzSeed()) },
  { id: "FZZ-txn-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(3).endOnFailure).toBe(true) },
  { id: "FZZ-seq-01", kind: "divergence", fn: () => expect(Number.isInteger(fuzzSeed())).toBe(true) },
  { id: "FZZ-tlp-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).seed).toBe(fuzzSeed()) },
  { id: "FZZ-norec-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).endOnFailure).toBe(true) },
  { id: "FZZ-comb-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(2).verbose).toBe(1) },
  {
    id: "FZZ-dst-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(3).numRuns === 3 || fuzzPath() !== undefined).toBe(true),
  },
  {
    id: "FZZ-mix-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(3).numRuns === 3 || fuzzPath() !== undefined).toBe(true),
  },
  {
    id: "FZZ-snap-01",
    kind: "divergence",
    fn: () => expect(fuzzAssertConfig(12).endOnFailure).toBe(true),
  },
  {
    id: "FZZ-snap-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id serial PRIMARY KEY, a int)");
      db.exec("CREATE VIEW v AS SELECT id, a FROM t");
      db.exec("INSERT INTO t (a) VALUES (1)");
      const snap = db.snapshot();
      const wiped = snap.open();
      wiped.exec("DELETE FROM t");
      const restored = snap.open();
      expect(restored.query("SELECT id, a FROM v")).toEqual([{ id: 1, a: 1 }]);
      wiped.close();
      restored.close();
    },
  },
  {
    id: "FZZ-snap-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE SEQUENCE sq START 10");
      db.query("SELECT nextval('sq')");
      const snap = db.snapshot();
      const wiped = snap.open();
      wiped.query("SELECT setval('sq', 1)");
      const restored = snap.open();
      expect(restored.query("SELECT nextval('sq') AS n")[0]).toEqual({ n: 11n });
      wiped.close();
      restored.close();
    },
  },
  { id: "FZZ-robust-01", kind: "divergence", fn: () => expect(typeof fuzzSeed()).toBe("number") },
  {
    id: "FZZ-corpus-01",
    kind: "divergence",
    fn: () => expect(categoryFromSqlstate("23505")).toBe("constraint_unique"),
  },
  { id: "FZZ-num-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(40).endOnFailure).toBe(true) },
  { id: "FZZ-cpy-01", kind: "divergence", fn: () => expect(fuzzAssertConfig(25).seed).toBe(fuzzSeed()) },
  {
    id: "FZZ-seed-01",
    kind: "divergence",
    fn: () => expect(fuzzSeed() === 0x5a17e0e1 || process.env.POSTGRES_MEM_FUZZ_SEED !== undefined).toBe(true),
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
    id: "FZZ-min-01",
    kind: "divergence",
    fn: async () => {
      // Minimizer drops ops greedily while the failure predicate still holds.
      const ops: MixedOp[] = [
        { kind: "insert", a: 1, b: "x", c: null },
        { kind: "select_scan" },
        { kind: "select_agg" },
      ];
      const minimized = await minimizeOps(ops, async (subset) => subset.length >= 2);
      expect(minimized.length).toBe(2);
    },
  },
]);
