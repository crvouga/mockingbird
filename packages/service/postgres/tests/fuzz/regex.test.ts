import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const asciiArb = fc.array(fc.constantFrom(..."abcxyz012 ".split("")), { maxLength: 10 }).map((c) => c.join(""));

const patternArb = fc.constantFrom("a", "b", "[0-9]", "x+", "^a", "z$", "a|b");

describe("regex differential fuzz", () => {
  test("~ and ~* operators match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(asciiArb, patternArb, async (text, pat) => {
        const sql =
          `SELECT (${sqlLiteral(text)} ~ ${sqlLiteral(pat)}) AS m, ` +
          `(${sqlLiteral(text)} ~* ${sqlLiteral(pat)}) AS ci, ` +
          `(${sqlLiteral(text)} !~ ${sqlLiteral(pat)}) AS nm`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("regex-op", sql, { text, pat }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
