import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, textArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

/**
 * High-value combination fuzz: NULL + JOIN + GROUP BY and UPSERT + UNIQUE + txn.
 */
describe("combination differential fuzz", () => {
  test("NULL join group-by combinations match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 8 }), g: fc.oneof(nullArb, intArb) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 8 }), v: fc.oneof(nullArb, textArb) }), {
          minLength: 0,
          maxLength: 8,
        }),
        (left, right) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER, g INT)");
              db.exec("CREATE TABLE r(id INTEGER, v TEXT)");
            }
            for (const row of left) {
              compareWriteOrReport(
                "combo-left",
                "INSERT INTO l VALUES (?, ?)",
                row,
                memory.exec("INSERT INTO l VALUES (?, ?)", [row.id, row.g]),
                sqlite.exec("INSERT INTO l VALUES (?, ?)", [row.id, row.g]),
              );
            }
            for (const row of right) {
              compareWriteOrReport(
                "combo-right",
                "INSERT INTO r VALUES (?, ?)",
                row,
                memory.exec("INSERT INTO r VALUES (?, ?)", [row.id, row.v]),
                sqlite.exec("INSERT INTO r VALUES (?, ?)", [row.id, row.v]),
              );
            }
            const sql =
              "SELECT l.g, count(r.v) AS c FROM l LEFT JOIN r ON l.id = r.id GROUP BY l.g ORDER BY l.g IS NULL, l.g, c";
            compareOrReport("combo-join-group", sql, { left, right }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("UPSERT unique transaction combinations match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 6 }),
            name: textArb,
            useTxn: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (ops) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
            }
            for (const op of ops) {
              const sql = "INSERT INTO t(id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name";
              const run = (db: typeof memory) => {
                if (!op.useTxn) return db.exec(sql, [op.id, op.name]);
                try {
                  db.exec("BEGIN");
                  const result = db.exec(sql, [op.id, op.name]);
                  if (!result.ok) {
                    db.exec("ROLLBACK");
                    return result;
                  }
                  db.exec("COMMIT");
                  return result;
                } catch (error) {
                  db.exec("ROLLBACK");
                  throw error;
                }
              };
              compareWriteOrReport("combo-upsert-txn", sql, op, run(memory), run(sqlite));
            }
            compareOrReport(
              "combo-upsert-final",
              "SELECT id, name FROM t ORDER BY id",
              ops,
              memory.query("SELECT id, name FROM t ORDER BY id"),
              sqlite.query("SELECT id, name FROM t ORDER BY id"),
            );
            compareStateOrReport("combo-upsert-state", ops, memory, sqlite);
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });
});
