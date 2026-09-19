import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

describe("index differential fuzz", () => {
  test("partial and expression indexes agree on lookups", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 12 }), v: intArb, flag: fc.integer({ min: 0, max: 1 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: -20, max: 20 }),
        (rows, probe) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, flag INT)");
              db.exec("CREATE INDEX idx_partial ON t(v) WHERE flag = 1");
              db.exec("CREATE INDEX idx_expr ON t(v + 1)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.v, row.flag]);
              }
            }
            const partial = `SELECT id, v, flag FROM t WHERE flag = 1 AND v = ${probe} ORDER BY id`;
            compareOrReport("index-partial", partial, { rows, probe }, memory.query(partial), sqlite.query(partial));
            const expr = `SELECT id, v FROM t WHERE v + 1 = ${probe + 1} ORDER BY id`;
            compareOrReport("index-expr", expr, { rows, probe }, memory.query(expr), sqlite.query(expr));
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("unique index conflict outcomes match SQLite", () => {
    fc.assert(
      fc.property(fc.array(textArb, { minLength: 2, maxLength: 8 }), (values) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
            db.exec("CREATE UNIQUE INDEX idx_name ON t(name)");
          }
          for (const [index, name] of values.entries()) {
            const sql = "INSERT INTO t(id, name) VALUES (?, ?)";
            const params = [index + 1, name];
            compareOutcomeOrReport(
              "index-unique-ins",
              sql,
              { values, index },
              memory.exec(sql, params),
              sqlite.exec(sql, params),
            );
          }
          const select = "SELECT id, name FROM t ORDER BY id";
          compareOrReport("index-unique-sel", select, { values }, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
