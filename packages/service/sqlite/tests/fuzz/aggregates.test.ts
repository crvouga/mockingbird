import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const groupedRowsArb = fc.array(
  fc.record({
    g: fc.integer({ min: -3, max: 3 }),
    a: fc.oneof(nullArb, intArb),
  }),
  { minLength: 1, maxLength: 12 },
);

describe("aggregate differential fuzz", () => {
  test("random grouped SUM, COUNT, and AVG match SQLite", () => {
    fc.assert(
      fc.property(groupedRowsArb, (rows) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(g INT, a INT)");
            for (const row of rows) db.exec("INSERT INTO t(g, a) VALUES (?, ?)", [row.g, row.a]);
          }

          const sql = [
            "SELECT g, SUM(a) AS total, COUNT(a) AS counted, AVG(a) AS average",
            "FROM t GROUP BY g ORDER BY g",
          ].join(" ");
          compareOrReport("aggregates", sql, rows, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  });
});
