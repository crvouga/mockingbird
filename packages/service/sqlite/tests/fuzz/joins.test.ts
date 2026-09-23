import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, textArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 8 }),
    value: textArb,
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 5 },
);

describe("join differential fuzz", () => {
  test("random inner and left joins match SQLite", () => {
    fc.assert(
      fc.property(
        rowsArb,
        rowsArb,
        fc.constantFrom("INNER", "LEFT"),
        fc.constantFrom("=", "<", "<=", ">", ">="),
        (leftRows, rightRows, joinType, predicate) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, value TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, value TEXT)");
              for (const row of leftRows) db.exec("INSERT INTO l VALUES (?, ?)", [row.id, row.value]);
              for (const row of rightRows) db.exec("INSERT INTO r VALUES (?, ?)", [row.id, row.value]);
            }

            const sql = [
              "SELECT l.id AS lid, l.value AS lv, r.id AS rid, r.value AS rv",
              `FROM l ${joinType} JOIN r ON l.id ${predicate} r.id`,
              "ORDER BY l.id, r.id",
            ].join(" ");
            compareOrReport(
              "join",
              sql,
              { leftRows, rightRows, joinType, predicate },
              memory.query(sql),
              sqlite.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("RIGHT FULL CROSS NATURAL and USING joins match SQLite", () => {
    fc.assert(
      fc.property(
        rowsArb,
        rowsArb,
        fc.constantFrom(
          "RIGHT JOIN r ON l.id = r.id",
          "FULL JOIN r ON l.id = r.id",
          "CROSS JOIN r",
          "NATURAL JOIN r",
          "JOIN r USING (id)",
        ),
        (leftRows, rightRows, joinClause) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, value TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, value TEXT)");
              for (const row of leftRows) db.exec("INSERT INTO l VALUES (?, ?)", [row.id, row.value]);
              for (const row of rightRows) db.exec("INSERT INTO r VALUES (?, ?)", [row.id, row.value]);
            }

            // NATURAL/USING yield fewer columns than ON joins — order by names, not ordinals.
            const sql = `SELECT * FROM l ${joinClause} ORDER BY id, value`;
            compareOrReport(
              "join-extended",
              sql,
              { leftRows, rightRows, joinClause },
              memory.query(sql),
              sqlite.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("multi-column USING NATURAL FULL and 3-table joins match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ a: fc.integer({ min: 1, max: 4 }), b: fc.integer({ min: 1, max: 4 }) }), {
          minLength: 0,
          maxLength: 4,
        }),
        fc.array(fc.record({ a: fc.integer({ min: 1, max: 4 }), b: fc.integer({ min: 1, max: 4 }) }), {
          minLength: 0,
          maxLength: 4,
        }),
        fc.array(fc.record({ a: fc.integer({ min: 1, max: 4 }), c: fc.integer({ min: 1, max: 4 }) }), {
          minLength: 0,
          maxLength: 4,
        }),
        fc.constantFrom("JOIN r USING (a, b)", "NATURAL FULL OUTER JOIN r", "JOIN m ON l.a = m.a JOIN r ON r.a = m.a"),
        (left, right, mid, joinClause) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(a INT, b INT)");
              db.exec("CREATE TABLE r(a INT, b INT)");
              db.exec("CREATE TABLE m(a INT, c INT)");
              for (const row of left) db.exec(`INSERT INTO l VALUES (${row.a}, ${row.b})`);
              for (const row of right) db.exec(`INSERT INTO r VALUES (${row.a}, ${row.b})`);
              for (const row of mid) db.exec(`INSERT INTO m VALUES (${row.a}, ${row.c})`);
            }
            // Alias every column and fully order — SELECT * + ORDER BY a,b is unstable with duplicate names.
            const sql =
              joinClause === "JOIN m ON l.a = m.a JOIN r ON r.a = m.a"
                ? [
                    "SELECT l.a AS la, l.b AS lb, m.a AS ma, m.c AS mc, r.a AS ra, r.b AS rb",
                    `FROM l ${joinClause}`,
                    "ORDER BY la, lb, ma, mc, ra, rb",
                  ].join(" ")
                : `SELECT * FROM l ${joinClause} ORDER BY a, b`;
            compareOrReport("join-multi", sql, { left, right, mid, joinClause }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
