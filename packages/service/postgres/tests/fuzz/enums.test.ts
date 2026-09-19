import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const enumLabelArb = fc.constantFrom("red", "green", "blue", "yellow");

describe("enum differential fuzz", () => {
  test("enum comparisons and ordering match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(enumLabelArb, enumLabelArb, async (a, b) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TYPE color AS ENUM ('red', 'green', 'blue', 'yellow')");
            await db.exec("CREATE TABLE t (c color)");
            await db.exec(`INSERT INTO t VALUES (${sqlLiteral(a)}::color), (${sqlLiteral(b)}::color)`);
          }
          const sql = `SELECT c FROM t WHERE c = ${sqlLiteral(a)}::color ORDER BY c`;
          compareOrReport("enum-eq", sql, { a, b }, await memory.query(sql), await postgres.query(sql));
          const cmpSql = `SELECT (${sqlLiteral(a)}::color = ${sqlLiteral(b)}::color) AS eq, (${sqlLiteral(a)}::color < ${sqlLiteral(b)}::color) AS lt`;
          compareOrReport("enum-cmp", cmpSql, { a, b }, await memory.query(cmpSql), await postgres.query(cmpSql));
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 120_000);
});
