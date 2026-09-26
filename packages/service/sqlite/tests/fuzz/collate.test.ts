import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const collatedTextArb = fc
  .array(fc.constantFrom("a", "A", "b", "B", "aa", "AA", "x", "x ", "x  "), {
    minLength: 1,
    maxLength: 8,
  })
  .map((values) => values.map((value, index) => ({ id: index + 1, value })));

describe("collation differential fuzz", () => {
  test("random ORDER GROUP and JOIN collation mixes match SQLite", () => {
    fc.assert(
      fc.property(
        collatedTextArb,
        fc.constantFrom("NOCASE", "RTRIM", "BINARY"),
        fc.constantFrom("order", "group", "join"),
        (rows, collation, operation) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE left_values(id INTEGER PRIMARY KEY, value TEXT)");
              db.exec("CREATE TABLE right_values(id INTEGER PRIMARY KEY, value TEXT)");
              for (const row of rows) {
                db.exec("INSERT INTO left_values VALUES (?, ?)", [row.id, row.value]);
                db.exec("INSERT INTO right_values VALUES (?, ?)", [row.id, row.value]);
              }
            }

            const sql =
              operation === "order"
                ? `SELECT id, value FROM left_values ORDER BY value COLLATE ${collation}, id`
                : operation === "group"
                  ? `SELECT value COLLATE ${collation} AS key, count(*) AS n FROM left_values GROUP BY key ORDER BY key, min(id)`
                  : `SELECT l.id, r.id FROM left_values l JOIN right_values r ON l.value COLLATE ${collation} = r.value ORDER BY l.id, r.id`;

            compareOrReport("collation-mix", sql, { rows, collation, operation }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(40),
    );
  });
});
