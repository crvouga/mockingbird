import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { Database } from "../../src/index.ts";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";
import { expectFastFullInsertParity, expectFastFullSelectParity } from "./fast-path-helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: intArb,
  b: textArb.filter((s) => s.length <= 8),
});

describe("fast vs full executor path", () => {
  test("simple SELECT with multi-column WHERE matches full path", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 12 }),
        intArb,
        textArb.filter((s) => s.length <= 8),
        (rows, probeA, probeB) => {
          const db = new Database({ seed: 1 });
          db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
          db.exec("CREATE INDEX idx_a ON t(a)");
          for (const row of rows) {
            db.query("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
          }
          expectFastFullSelectParity(
            db,
            `SELECT id, a, b FROM t WHERE a = ${probeA} AND b = ${sqlLiteral(probeB)} ORDER BY id`,
          );
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("simple INNER JOIN equality matches full path", () => {
    const db = new Database({ seed: 1 });
    db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, k INT, v TEXT)");
    db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, k INT, v TEXT)");
    db.exec("INSERT INTO l VALUES (1,10,'a'),(2,20,'b')");
    db.exec("INSERT INTO r VALUES (1,10,'x'),(2,30,'y')");
    expectFastFullSelectParity(db, "SELECT l.v, r.v FROM l INNER JOIN r ON l.k = r.k ORDER BY l.id, r.id");
  });

  test("unconstrained INSERT matches full path", () => {
    expectFastFullInsertParity(
      ["CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)"],
      "INSERT INTO t VALUES (1, 2, 'x'), (2, 3, 'y')",
    );
  });

  test("fast full and oracle agree on indexed WHERE", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 10 }),
        intArb,
        (rows, probe) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE INDEX idx_a ON t(a)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              }
            }
            const sql = `SELECT id, a, b FROM t WHERE a = ${probe} ORDER BY id`;
            compareOrReport("fast-oracle", sql, { rows, probe }, memory.query(sql), sqlite.query(sql));
          });
          const db = new Database({ seed: 1 });
          db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
          db.exec("CREATE INDEX idx_a ON t(a)");
          for (const row of rows) {
            db.query("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
          }
          const sql = `SELECT id, a, b FROM t WHERE a = ${probe} ORDER BY id`;
          expectFastFullSelectParity(db, sql);
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
