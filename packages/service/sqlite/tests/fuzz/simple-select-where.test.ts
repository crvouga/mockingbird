import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 30 }),
  a: fc.integer({ min: 0, max: 5 }),
  b: fc.integer({ min: 0, max: 5 }),
});

describe("simple-select partial index WHERE fuzz", () => {
  test("multi-equality WHERE with single-column index matches oracle", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 12 }),
        intArb,
        intArb,
        (rows, probeA, probeB) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b INT)");
              db.exec("CREATE INDEX idx_a ON t(a)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              }
            }
            const sql = `SELECT id, a, b FROM t WHERE a = ${probeA} AND b = ${probeB} ORDER BY id`;
            compareOrReport("simple-where-prefix", sql, { rows, probeA, probeB }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });
});
