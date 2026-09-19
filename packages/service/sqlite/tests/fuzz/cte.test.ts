import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const cteRowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 20 }),
    a: intArb,
    label: textArb,
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 8 },
);

describe("CTE differential fuzz", () => {
  test("random non-recursive CTE projections match SQLite", () => {
    fc.assert(
      fc.property(cteRowsArb, intArb, (rows, threshold) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, label TEXT)");
            for (const row of rows) {
              db.exec("INSERT INTO t(id, a, label) VALUES (?, ?, ?)", [row.id, row.a, row.label]);
            }
          }

          const sql = [
            "WITH cte AS (SELECT id, a, label FROM t WHERE a >= ?)",
            "SELECT id, a, label FROM cte ORDER BY id",
          ].join(" ");
          compareOrReport(
            "cte",
            sql,
            { rows, threshold },
            memory.query(sql, [threshold]),
            sqlite.query(sql, [threshold]),
          );
        });
      }),
      fuzzAssertConfig(30),
    );
  });

  test("random recursive counters match SQLite", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (limit) => {
        const sql = [
          "WITH RECURSIVE cnt(x) AS (",
          `SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ${limit}`,
          ") SELECT x FROM cnt ORDER BY x",
        ].join(" ");
        withDatabases((memory, sqlite) => {
          compareOrReport("recursive-cte", sql, { limit }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  });

  test("random CTE-driven INSERT UPDATE and DELETE match SQLite", () => {
    fc.assert(
      fc.property(cteRowsArb, intArb, fc.constantFrom("insert", "update", "delete"), (rows, threshold, operation) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, label TEXT)");
            for (const row of rows) {
              db.exec("INSERT INTO t(id, a, label) VALUES (?, ?, ?)", [row.id, row.a, row.label]);
            }
          }

          const sql =
            operation === "insert"
              ? "WITH c(x) AS (VALUES(?)) INSERT INTO t(id, a, label) SELECT 100, x, 'cte' FROM c"
              : operation === "update"
                ? "WITH c(id) AS (SELECT id FROM t WHERE a >= ?) UPDATE t SET label='updated' WHERE id IN (SELECT id FROM c)"
                : "WITH c(id) AS (SELECT id FROM t WHERE a < ?) DELETE FROM t WHERE id IN (SELECT id FROM c)";
          compareOrReport(
            "cte-dml-write",
            sql,
            { rows, threshold, operation },
            memory.exec(sql, [threshold]),
            sqlite.exec(sql, [threshold]),
          );

          const stateSql = "SELECT id, a, label FROM t ORDER BY id";
          compareOrReport(
            "cte-dml-state",
            stateSql,
            { rows, threshold, operation },
            memory.query(stateSql),
            sqlite.query(stateSql),
          );
        });
      }),
      fuzzAssertConfig(30),
    );
  });
});
