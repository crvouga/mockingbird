import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, realArb, valueArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const numericArb = fc.oneof(nullArb, intArb, realArb);
const expressionArb = fc.oneof(
  fc.record({
    a: numericArb,
    b: numericArb,
    op: fc.constantFrom("+", "-", "*", "%", "&", "|"),
  }),
  fc.record({
    a: valueArb,
    b: valueArb,
    op: fc.constantFrom("=", "!=", "<", "<=", ">", ">="),
  }),
);

describe("expression differential fuzz", () => {
  test("random binary expressions match SQLite", () => {
    fc.assert(
      fc.property(expressionArb, ({ a, b, op }) => {
        const sql = `SELECT (${sqlLiteral(a)} ${op} ${sqlLiteral(b)}) AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("expression", sql, { a, b, op }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  });

  test("CASE BETWEEN and CAST edges match SQLite", () => {
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, intArb, (a, b, c, n) => {
        withDatabases((memory, sqlite) => {
          const caseSql = `SELECT CASE WHEN ${sqlLiteral(a)} IS NULL THEN ${sqlLiteral(b)} ELSE ${sqlLiteral(c)} END AS v`;
          compareOrReport("case", caseSql, { a, b, c }, memory.query(caseSql), sqlite.query(caseSql));

          const betweenSql = `SELECT ${sqlLiteral(n)} BETWEEN ${sqlLiteral(n - 5)} AND ${sqlLiteral(n + 5)} AS v`;
          compareOrReport("between", betweenSql, { n }, memory.query(betweenSql), sqlite.query(betweenSql));

          const castSql = `SELECT typeof(CAST(${sqlLiteral(a)} AS INTEGER)) AS t, CAST(${sqlLiteral(a)} AS TEXT) AS v`;
          compareOrReport("cast-edge", castSql, { a }, memory.query(castSql), sqlite.query(castSql));
        });
      }),
      fuzzAssertConfig(30),
    );
  });

  test("integer overflow edges near i64 match SQLite", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "9223372036854775807 + 1",
          "9223372036854775807 + 9223372036854775807",
          "-9223372036854775808 - 1",
          "3037000500 * 3037000500",
        ),
        (expr) => {
          const sql = `SELECT (${expr}) AS v, typeof((${expr})) AS t`;
          withDatabases((memory, sqlite) => {
            compareOrReport("i64-overflow", sql, { expr }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
