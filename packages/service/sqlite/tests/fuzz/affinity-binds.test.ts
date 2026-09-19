import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database, SqliteError } from "../../src/index.ts";
import { fuzzAssertConfig, intArb, textArb, valueArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, compareWriteOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

describe("affinity and -0 differential fuzz", () => {
  test("CAST / affinity edges including canonicalized -0", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(0),
          intArb,
          fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((n) => Number.isFinite(n) && !Object.is(n, -0)),
          textArb,
          fc.constant(null),
        ),
        fc.constantFrom("INTEGER", "REAL", "TEXT", "NUMERIC"),
        (value, type) => {
          const sql = `SELECT typeof(CAST(${sqlLiteral(value)} AS ${type})) AS t, CAST(${sqlLiteral(value)} AS ${type}) AS v`;
          withDatabases((memory, sqlite) => {
            compareOrReport("affinity-cast", sql, { value, type }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("IEEE -0 binds and arithmetic canonicalize to +0", () => {
    const db = new Database();
    try {
      expect(db.query("SELECT ? AS v", [-0])).toEqual([{ v: 0 }]);
      expect(Object.is(db.query("SELECT ? AS v", [-0])[0]!.v, -0)).toBe(false);
      expect(db.query("SELECT -0.0 AS v")).toEqual([{ v: 0 }]);
    } finally {
      db.close();
    }
  });
});

describe("bind style differential fuzz", () => {
  test("positional and numbered binds match oracle", () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        withDatabases((memory, sqlite) => {
          const setup = "CREATE TABLE t(x, y)";
          compareOutcomeOrReport("bind-setup", setup, { a, b }, memory.exec(setup), sqlite.exec(setup));
          const sql = "INSERT INTO t VALUES (?2, ?1)";
          compareWriteOrReport("bind-insert", sql, { a, b }, memory.exec(sql, [a, b]), sqlite.exec(sql, [a, b]));
          const select = "SELECT x, y FROM t";
          compareOrReport("bind-select", select, { a, b }, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(20),
    );
  });

  test("named :x and @x binds match oracle", () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        withDatabases((memory, sqlite) => {
          const setup = "CREATE TABLE t(x, y)";
          compareOutcomeOrReport("named-setup", setup, { a, b }, memory.exec(setup), sqlite.exec(setup));
          const sql = "INSERT INTO t VALUES (:x, @y)";
          // Adapters accept positional arrays; named binds via prepare+object when supported.
          // Use literal-equivalent numbered style through prepare run with ordered values matching appearance.
          const memStmt = memory.prepare(sql);
          const sqlStmt = sqlite.prepare(sql);
          compareWriteOrReport("named-insert", sql, { a, b }, memStmt.run(a, b), sqlStmt.run(a, b));
          const select = "SELECT x, y FROM t";
          compareOrReport("named-select", select, { a, b }, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(20),
    );
  });

  test("blob binds round-trip", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 16 }), (bytes) => {
        withDatabases((memory, sqlite) => {
          const setup = "CREATE TABLE t(b BLOB)";
          compareOutcomeOrReport("blob-setup", setup, bytes, memory.exec(setup), sqlite.exec(setup));
          compareWriteOrReport(
            "blob-insert",
            "INSERT INTO t VALUES (?)",
            bytes,
            memory.exec("INSERT INTO t VALUES (?)", [bytes]),
            sqlite.exec("INSERT INTO t VALUES (?)", [bytes]),
          );
          compareOrReport(
            "blob-select",
            "SELECT typeof(b) AS t, length(b) AS n FROM t",
            bytes,
            memory.query("SELECT typeof(b) AS t, length(b) AS n FROM t"),
            sqlite.query("SELECT typeof(b) AS t, length(b) AS n FROM t"),
          );
        });
      }),
      fuzzAssertConfig(15),
    );
  });
});

describe("malformed SQL robustness", () => {
  test("random junk never throws non-SqliteError from prepare/query", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (junk) => {
        const db = new Database();
        try {
          try {
            db.prepare(junk);
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
          try {
            db.query(junk);
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
        } finally {
          db.close();
        }
      }),
      fuzzAssertConfig(25),
    );
  });
});

describe("README determinism property invariants", () => {
  test("snapshot bytes restore tables and seeded random stream", () => {
    const left = new Database({ seed: 99 });
    const right = new Database({ seed: 99 });
    try {
      for (const db of [left, right]) {
        db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)");
        db.exec("INSERT INTO t(v) VALUES (random()), (random())");
      }
      expect(left.query("SELECT id, v FROM t ORDER BY id")).toEqual(right.query("SELECT id, v FROM t ORDER BY id"));
      const snap = left.snapshot();
      left.exec("DELETE FROM t");
      const opened = snap.open();
      expect(opened.query("SELECT id, v FROM t ORDER BY id")).toEqual(right.query("SELECT id, v FROM t ORDER BY id"));
      opened.close();
    } finally {
      left.close();
      right.close();
    }
  });

  test("ROLLBACK rewinds seeded PRNG with data", () => {
    const db = new Database({ seed: 7 });
    try {
      db.exec("CREATE TABLE t(v INT)");
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (random())");
      const mid = db.query("SELECT v FROM t");
      db.exec("ROLLBACK");
      db.exec("INSERT INTO t VALUES (random())");
      expect(db.query("SELECT v FROM t")).toEqual(mid);
    } finally {
      db.close();
    }
  });
});
