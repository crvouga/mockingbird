import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const rowsArb = fc.array(fc.record({ id: fc.integer({ min: 1, max: 20 }), a: intArb, b: textArb }), {
  minLength: 1,
  maxLength: 8,
});

describe("subquery differential fuzz", () => {
  test("scalar IN EXISTS and correlated subqueries match SQLite", () => {
    fc.assert(
      fc.property(rowsArb, intArb, (rows, threshold) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
            for (const row of rows) {
              db.exec("INSERT OR IGNORE INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
          }

          const cases = [
            `SELECT id, (SELECT max(a) FROM t) AS m FROM t ORDER BY id`,
            `SELECT id, a FROM t WHERE a IN (SELECT a FROM t WHERE a > ${threshold}) ORDER BY id`,
            `SELECT id FROM t WHERE EXISTS (SELECT 1 FROM t t2 WHERE t2.a = t.a AND t2.id <> t.id) ORDER BY id`,
            `SELECT id, a FROM t WHERE a = (SELECT a FROM t t2 WHERE t2.id = t.id) ORDER BY id`,
          ];

          for (const sql of cases) {
            compareOrReport("subquery", sql, { rows, threshold }, memory.query(sql), sqlite.query(sql));
          }
        });
      }),
      fuzzAssertConfig(25),
    );
  });

  test("compound SELECT set ops match SQLite", () => {
    fc.assert(
      fc.property(
        rowsArb,
        rowsArb,
        fc.constantFrom("UNION", "UNION ALL", "INTERSECT", "EXCEPT"),
        (left, right, setOp) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(a INT)");
              db.exec("CREATE TABLE r(a INT)");
              for (const row of left) db.exec("INSERT INTO l VALUES (?)", [row.a]);
              for (const row of right) db.exec("INSERT INTO r VALUES (?)", [row.a]);
            }
            const sql = `SELECT a FROM l ${setOp} SELECT a FROM r ORDER BY 1`;
            compareOrReport("compound", sql, { left, right, setOp }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("NOT IN / IN with NULL rows and empty subqueries match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(intArb, { nil: null }), { minLength: 0, maxLength: 6 }),
        fc.option(intArb, { nil: null }),
        (haystack, needle) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(a INT)");
              for (const value of haystack) {
                db.exec("INSERT INTO t VALUES (?)", [value]);
              }
            }
            const lit = needle === null ? "NULL" : String(needle);
            for (const sql of [
              `SELECT ${lit} IN (SELECT a FROM t) AS v`,
              `SELECT ${lit} NOT IN (SELECT a FROM t) AS v`,
              `SELECT ${lit} IN (SELECT a FROM t WHERE 0) AS v`,
              `SELECT ${lit} NOT IN (SELECT a FROM t WHERE 0) AS v`,
            ]) {
              compareOrReport("notin-null", sql, { haystack, needle }, memory.query(sql), sqlite.query(sql));
            }
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("scalar subquery cardinality errors match SQLite", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (n) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
            for (let i = 1; i <= n; i++) db.exec("INSERT INTO t VALUES (?, ?)", [i, i]);
          }
          const sql = "SELECT (SELECT a FROM t) AS v";
          compareOutcomeOrReport("scalar-card", sql, { n }, memory.query(sql), sqlite.query(sql));
          if (n <= 1) {
            compareOrReport("scalar-card-ok", sql, { n }, memory.query(sql), sqlite.query(sql));
          }
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
