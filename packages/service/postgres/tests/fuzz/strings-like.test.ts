import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

/** ASCII-only text: keeps LIKE/ILIKE/upper/lower away from locale-dependent case folding. */
const asciiChars = "abcxyzABCXYZ012 ".split("");
const asciiTextArb = fc.array(fc.constantFrom(...asciiChars), { maxLength: 12 }).map((chars) => chars.join(""));

/** Pattern segments: literal chars, wildcards, and default-escape (`\`) escaped wildcards. */
const patternSegmentArb = fc.oneof(fc.constantFrom(...asciiChars), fc.constantFrom("%", "_", "\\%", "\\_"));
const patternArb = fc.array(patternSegmentArb, { maxLength: 8 }).map((segments) => segments.join(""));

describe("string/LIKE differential fuzz", () => {
  test("random LIKE/ILIKE patterns with %/_ and escapes", async () => {
    await fc.assert(
      fc.asyncProperty(asciiTextArb, patternArb, async (hay, pat) => {
        const sql =
          `SELECT (${sqlLiteral(hay)} LIKE ${sqlLiteral(pat)}) AS a, ` +
          `(${sqlLiteral(hay)} NOT LIKE ${sqlLiteral(pat)}) AS b, ` +
          `(${sqlLiteral(hay)} ILIKE ${sqlLiteral(pat)}) AS c, ` +
          `(${sqlLiteral(hay)} NOT ILIKE ${sqlLiteral(pat)}) AS d`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("like-ilike", sql, { hay, pat }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(50),
    );
  }, 120_000);

  test("substr/upper/lower/length/replace/strpos compositions", async () => {
    await fc.assert(
      fc.asyncProperty(
        asciiTextArb,
        asciiTextArb.filter((s) => s.length <= 4),
        asciiTextArb.filter((s) => s.length <= 4),
        fc.integer({ min: -3, max: 14 }),
        fc.integer({ min: 0, max: 14 }),
        async (s, needle, repl, start, len) => {
          const lit = sqlLiteral(s);
          const basicsSql =
            `SELECT length(${lit}) AS a, upper(${lit}) AS b, lower(${lit}) AS c, ` +
            `strpos(${lit}, ${sqlLiteral(needle)}) AS d`;
          const substrSql =
            `SELECT substr(${lit}, ${start < 0 ? `(${start})` : start}) AS a, ` +
            `substr(${lit}, ${start < 0 ? `(${start})` : start}, ${len}) AS b, ` +
            `upper(substr(${lit}, 1, ${len})) AS c, length(substr(${lit}, 2)) AS d`;
          const replaceSql =
            `SELECT replace(${lit}, ${sqlLiteral(needle)}, ${sqlLiteral(repl)}) AS a, ` +
            `replace(lower(${lit}), ${sqlLiteral(needle)}, ${sqlLiteral(repl)}) AS b, ` +
            `strpos(replace(${lit}, ${sqlLiteral(needle)}, ${sqlLiteral(repl)}), ${sqlLiteral(repl)}) AS c`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "string-basics",
              basicsSql,
              { s, needle },
              await memory.query(basicsSql),
              await postgres.query(basicsSql),
            );
            compareOrReport(
              "substr",
              substrSql,
              { s, start, len },
              await memory.query(substrSql),
              await postgres.query(substrSql),
            );
            compareOrReport(
              "replace",
              replaceSql,
              { s, needle, repl },
              await memory.query(replaceSql),
              await postgres.query(replaceSql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("string concatenation chains with NULLs", async () => {
    const pieceArb = fc.oneof(
      fc.constant(null),
      asciiTextArb.filter((s) => s.length <= 6),
    );
    await fc.assert(
      fc.asyncProperty(
        asciiTextArb.filter((s) => s.length <= 6),
        fc.array(pieceArb, { minLength: 1, maxLength: 4 }),
        async (head, pieces) => {
          // Head is always a text literal so `||` resolves as text concatenation throughout the chain.
          const chain = [sqlLiteral(head), ...pieces.map((p) => (p === null ? "NULL" : sqlLiteral(p)))].join(" || ");
          const sql = `SELECT (${chain}) AS v, ((${chain}) IS NULL) AS is_null, length(${chain}) AS len`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport("concat-chain", sql, { head, pieces }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
