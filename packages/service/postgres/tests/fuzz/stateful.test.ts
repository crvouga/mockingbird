import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { runSequenceOrMinimize, schemaKindArb, statefulOpArb } from "./dst/index.ts";

const maxSteps = Number(process.env.POSTGRES_MEM_STATEFUL_STEPS ?? "15");

describe("stateful DST dump-after-each", () => {
  test("random op sequences match the PGlite oracle after every step", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemaKindArb,
        fc.array(statefulOpArb, { minLength: 3, maxLength: maxSteps }),
        async (schemaKind, ops) => {
          await runSequenceOrMinimize(ops, { label: "stateful", schemaKind, dumpAfterEveryStep: true });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 60_000);
});
