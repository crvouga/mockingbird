import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { mixedOpArb, runSequenceOrMinimize, schemaKindArb } from "./dst/index.ts";

const maxSteps = Number(process.env.POSTGRES_MEM_MIXED_STEPS ?? "15");

describe("mixed DDL/DML/txn stateful simulation", () => {
  test("interleaved ops (incl. ADD COLUMN / CREATE INDEX / DROP INDEX) match the oracle", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemaKindArb,
        fc.array(mixedOpArb, { minLength: 5, maxLength: maxSteps }),
        async (schemaKind, ops) => {
          await runSequenceOrMinimize(ops, {
            label: "mixed",
            schemaKind,
            dumpAfterEveryStep: true,
            finalizeCommit: true,
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 60_000);
});
