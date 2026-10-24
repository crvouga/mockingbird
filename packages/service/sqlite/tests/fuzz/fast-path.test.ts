import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database } from "../../src/index.ts";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { expectFastFullInsertParity, expectFastFullSelectParity, runInternal } from "./fast-path-helpers.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: intArb,
  b: textArb.filter((s) => s.length <= 8),
});

describe("fast vs full executor path", () => {
  test("bounded numeric index candidates preserve residual filtering in both SELECT paths", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT); CREATE INDEX t_a ON t(a)");
    for (let i = 0; i < 100; i++) db.prepare("INSERT INTO t VALUES (?, ?, ?)").run(i, i % 20, String(i));
    try {
      for (const [lower, upper] of [
        [-1, 10],
        [5, 5],
        [10, 5],
        [0, 20],
      ])
        for (const op of [">", ">="])
          expectFastFullSelectParity(
            db,
            `SELECT id,a,b FROM t WHERE a ${op} ${lower} AND a < ${upper} AND id <> 3 ORDER BY id DESC LIMIT 7 OFFSET 1`,
          );
    } finally {
      db.close();
    }
  });
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

test("rowid and NOT NULL inserts keep fast/full rows, errors and counters identical", () => {
  for (const schema of [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT NOT NULL, b TEXT NOT NULL)",
    "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, a INT NOT NULL, b TEXT DEFAULT 'default')",
    "CREATE TABLE t(id INT, a INT NOT NULL, b TEXT)",
  ]) {
    const fast = new Database();
    const full = new Database();
    fast.exec(schema);
    full.exec(schema);
    for (const sql of [
      "INSERT INTO t VALUES (1, 2, 'a')",
      "INSERT INTO t VALUES (2, 3, 'b')",
      "INSERT INTO t VALUES (2, 4, 'duplicate')",
      "INSERT INTO t VALUES (NULL, 5, 'allocated')",
      "INSERT INTO t VALUES (4, NULL, 'not-null')",
      "INSERT INTO t VALUES (5, 6, NULL)",
      "INSERT INTO t(id, a) VALUES (7, 8)",
      "INSERT INTO t VALUES ('invalid', 9, 'type')",
      "INSERT INTO t(missing, a) VALUES (10, 11)",
    ]) {
      const execute = (db: Database, forceFullInsert: boolean) => {
        try {
          return { result: runInternal(db, sql, { forceFullInsert }) };
        } catch (error) {
          const e = error as Error & { category: string; code: string };
          return { error: [e.message, e.category, e.code] };
        }
      };
      expect(execute(fast, false)).toEqual(execute(full, true));
      expect(fast.query("SELECT * FROM t ORDER BY rowid")).toEqual(full.query("SELECT * FROM t ORDER BY rowid"));
      expect([fast.changes, fast.totalChanges, fast.lastInsertRowid]).toEqual([
        full.changes,
        full.totalChanges,
        full.lastInsertRowid,
      ]);
    }
  }
});
