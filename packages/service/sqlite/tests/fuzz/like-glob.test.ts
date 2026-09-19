import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, textArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const haystackArb = textArb.filter((s) => s.length <= 16);
const patternArb = fc.oneof(
  haystackArb,
  fc.constantFrom("%", "_", "%a%", "a%", "%z", "a_b", "*"),
  fc.tuple(haystackArb, fc.constantFrom("%", "_")).map(([s, wild]) => `${wild}${s}${wild}`),
);

describe("LIKE/GLOB differential fuzz", () => {
  test("LIKE patterns match SQLite", () => {
    fc.assert(
      fc.property(haystackArb, patternArb, fc.constantFrom("BINARY", "NOCASE", "RTRIM"), (hay, pat, collate) => {
        const sql = `SELECT ${sqlLiteral(hay)} LIKE ${sqlLiteral(pat)} COLLATE ${collate} AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("like", sql, { hay, pat, collate }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  });

  test("GLOB patterns match SQLite", () => {
    fc.assert(
      fc.property(
        haystackArb,
        fc.oneof(haystackArb, fc.constantFrom("*", "?", "a*", "*z", "a?b", "[a-z]*")),
        (hay, pat) => {
          const sql = `SELECT ${sqlLiteral(hay)} GLOB ${sqlLiteral(pat)} AS v`;
          withDatabases((memory, sqlite) => {
            compareOrReport("glob", sql, { hay, pat }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("LIKE ESCAPE edges match SQLite", () => {
    fc.assert(
      fc.property(
        haystackArb,
        fc.constantFrom("%a%", "a\\%", "\\_", "a%"),
        fc.constantFrom("\\", "/", "x", "\\\\"),
        (hay, pat, esc) => {
          const sql = `SELECT ${sqlLiteral(hay)} LIKE ${sqlLiteral(pat)} ESCAPE ${sqlLiteral(esc)} AS v`;
          withDatabases((memory, sqlite) => {
            compareOrReport("like-escape", sql, { hay, pat, esc }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });
});
