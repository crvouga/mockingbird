import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { dmlOpArb, runBoundDmlSequence } from "./dst/index.ts";

const ciSteps = Number(process.env.SQLITE_MEM_STATEFUL_STEPS ?? "24");

describe("O3 stateful dump-after-each", () => {
  test("interleaved DML/SELECT match B + Dump after every step", () => {
    fc.assert(
      fc.property(fc.array(dmlOpArb, { minLength: 6, maxLength: ciSteps }), (ops) => {
        runBoundDmlSequence(ops, { label: "stateful" });
      }),
      fuzzAssertConfig(8),
    );
  });
});
