import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const keyArb = fc.constantFrom("a", "b", "c", "n");
const jsonDocArb = fc.dictionary(keyArb, fc.oneof(fc.integer({ min: -5, max: 5 }), fc.constantFrom("x", "y")), {
  minKeys: 1,
  maxKeys: 3,
});

describe("jsonpath differential fuzz", () => {
  test("jsonb path queries match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(jsonDocArb, keyArb, async (doc, key) => {
        const lit = sqlLiteral(JSON.stringify(doc));
        const path = `$."${key}"`;
        const sql = `SELECT ${lit}::jsonb #>> '{${key}}' AS v, jsonb_path_exists(${lit}::jsonb, '${path}') AS ex`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("jsonpath", sql, { doc, key }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 120_000);
});
