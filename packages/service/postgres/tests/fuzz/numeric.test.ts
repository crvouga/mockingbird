import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const coefArb = fc.bigInt({ min: -999999999999999n, max: 999999999999999n });
const scaleArb = fc.integer({ min: 0, max: 12 });

describe("numeric differential fuzz", () => {
  test("add/mul/sub/div match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        coefArb,
        scaleArb,
        coefArb,
        scaleArb,
        fc.constantFrom("+", "-", "*", "/"),
        async (a, as, b, bs, op) => {
          const sql =
            `SELECT ((${a}::numeric / power(10::numeric, ${as})) ${op} ` +
            `(${b}::numeric / power(10::numeric, ${bs})))::text AS v`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "numeric-op",
              sql,
              { a, as, b, bs, op },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(40),
    );
  }, 120_000);

  test("numeric comparison matches postgres", async () => {
    await fc.assert(
      fc.asyncProperty(intArb, intArb, fc.constantFrom("<", "<=", "=", ">=", ">"), async (a, b, op) => {
        const sql = `SELECT (${a}::numeric ${op} ${b}::numeric) AS v`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("numeric-cmp", sql, { a, b, op }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  }, 120_000);
});
