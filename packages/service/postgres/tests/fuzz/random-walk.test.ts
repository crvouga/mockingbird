import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { buildTraceOnly, decisionVectorArb, runWalkOrMinimize, walkDepth } from "./walk/index.ts";

const depth = walkDepth("POSTGRES_MEM_WALK_STEPS", 30);
const defaultRuns = 5;

describe("random-walk DST dump-after-each", () => {
  test("state-dependent walk matches the PGlite oracle after every step", async () => {
    await fc.assert(
      fc.asyncProperty(decisionVectorArb(depth), async (ints) => {
        await runWalkOrMinimize(ints, { depth, label: "walk" });
      }),
      fuzzAssertConfig(defaultRuns),
    );
  }, 120_000);

  test("same decision vector yields identical SQL traces", () => {
    fc.assert(
      fc.property(decisionVectorArb(Math.min(depth, 24)), (ints) => {
        const a = buildTraceOnly(ints, Math.min(depth, 24));
        const b = buildTraceOnly(ints, Math.min(depth, 24));
        expect(a.map((s) => s.sql)).toEqual(b.map((s) => s.sql));
        expect(a.map((s) => s.kind)).toEqual(b.map((s) => s.kind));
      }),
      fuzzAssertConfig(8),
    );
  });
});
