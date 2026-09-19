import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const upsertArb = fc.record({
  key: fc.integer({ min: 1, max: 6 }),
  value: intArb,
  action: fc.constantFrom("nothing", "replace", "add"),
});

describe("upsert differential fuzz", () => {
  test("random conflict actions match SQLite", () => {
    fc.assert(
      fc.property(fc.array(upsertArb, { minLength: 1, maxLength: 12 }), (upserts) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE counters(key INTEGER PRIMARY KEY, value INT)");
          }

          for (const upsert of upserts) {
            const action =
              upsert.action === "nothing"
                ? "DO NOTHING"
                : upsert.action === "replace"
                  ? "DO UPDATE SET value = excluded.value"
                  : "DO UPDATE SET value = counters.value + excluded.value";
            const sql = `INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) ${action}`;
            compareOrReport(
              `upsert-${upsert.action}`,
              sql,
              { upserts, upsert },
              memory.exec(sql, [upsert.key, upsert.value]),
              sqlite.exec(sql, [upsert.key, upsert.value]),
            );
          }

          const select = "SELECT key, value FROM counters ORDER BY key";
          compareOrReport("upsert-final", select, upserts, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(35),
    );
  });

  test("excluded star WITHOUT ROWID and ON CONFLICT(rowid) match SQLite", () => {
    fc.assert(
      fc.property(intArb, intArb, fc.boolean(), (a, b, useRowid) => {
        withDatabases((memory, sqlite) => {
          if (useRowid) {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE wr(a INT PRIMARY KEY) WITHOUT ROWID");
              db.exec("INSERT INTO wr VALUES (1)");
            }
            const sql = "INSERT INTO wr(a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = excluded.a + 1";
            compareOrReport("upsert-without-rowid", sql, { a, b, useRowid }, memory.exec(sql), sqlite.exec(sql));
          } else {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, a INT, b INT)");
              db.exec("INSERT INTO u VALUES (1, 10, 20)");
            }
            const sql =
              "INSERT INTO u(id, a, b) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET a = excluded.a, b = excluded.b";
            compareOrReport("upsert-excluded", sql, { a, b }, memory.exec(sql, [a, b]), sqlite.exec(sql, [a, b]));
            const rowidSql = "INSERT INTO u(id, a, b) VALUES (2, 0, 0) ON CONFLICT(rowid) DO NOTHING";
            compareOrReport("upsert-rowid", rowidSql, { a, b }, memory.exec(rowidSql), sqlite.exec(rowidSql));
          }
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
