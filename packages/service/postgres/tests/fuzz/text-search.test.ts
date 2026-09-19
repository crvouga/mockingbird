import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const docArb = fc
  .array(fc.constantFrom("quick", "brown", "fox", "lazy", "dog", "jump", "cat"), { minLength: 1, maxLength: 5 })
  .map((words) => words.join(" "));

const termArb = fc.constantFrom("fox", "dog", "cat", "quick", "brown", "jump");

describe("text search differential fuzz", () => {
  test("to_tsvector @@ to_tsquery matches postgres", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, termArb, async (doc, term) => {
        const sql = `SELECT to_tsvector('english', ${sqlLiteral(doc)}) @@ to_tsquery('english', ${sqlLiteral(term)}) AS m`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("ts-match", sql, { doc, term }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 120_000);

  test("plainto_tsquery and ts_rank", async () => {
    await fc.assert(
      fc.asyncProperty(docArb, docArb, async (doc, query) => {
        const sql =
          `SELECT ts_rank(to_tsvector('english', ${sqlLiteral(doc)}), plainto_tsquery('english', ${sqlLiteral(query)})) AS r, ` +
          `(to_tsvector('english', ${sqlLiteral(doc)}) @@ plainto_tsquery('english', ${sqlLiteral(query)})) AS m`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("ts-rank", sql, { doc, query }, await memory.query(sql), await postgres.query(sql), {
            realEpsilon: 1e-6,
          });
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 120_000);
});
