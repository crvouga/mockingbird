import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const eventArb = fc.constantFrom("INSERT", "UPDATE", "DELETE");
const timingArb = fc.constantFrom("BEFORE", "AFTER");

describe("trigger differential fuzz", () => {
  test("AFTER/BEFORE triggers and RAISE match SQLite", () => {
    fc.assert(
      fc.property(timingArb, eventArb, fc.array(intArb, { minLength: 1, maxLength: 5 }), (timing, event, values) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
            db.exec("CREATE TABLE audit(id INTEGER PRIMARY KEY, op TEXT)");
            if (event === "INSERT") {
              db.exec(`CREATE TRIGGER tr ${timing} INSERT ON t BEGIN INSERT INTO audit(op) VALUES ('I'); END`);
            } else if (event === "UPDATE") {
              db.exec(`CREATE TRIGGER tr ${timing} UPDATE ON t BEGIN INSERT INTO audit(op) VALUES ('U'); END`);
            } else {
              db.exec(`CREATE TRIGGER tr ${timing} DELETE ON t BEGIN INSERT INTO audit(op) VALUES ('D'); END`);
            }
          }

          for (const [i, a] of values.entries()) {
            const sql = `INSERT INTO t(id, a) VALUES (${i + 1}, ${a})`;
            compareWriteOrReport("trig-insert", sql, { timing, event }, memory.exec(sql), sqlite.exec(sql));
          }
          if (event === "UPDATE") {
            const sql = "UPDATE t SET a = a + 1";
            compareWriteOrReport("trig-update", sql, { timing, event }, memory.exec(sql), sqlite.exec(sql));
          }
          if (event === "DELETE") {
            const sql = "DELETE FROM t WHERE id = 1";
            compareWriteOrReport("trig-delete", sql, { timing, event }, memory.exec(sql), sqlite.exec(sql));
          }

          const audit = "SELECT op FROM audit ORDER BY id";
          compareOrReport("trig-audit", audit, { timing, event, values }, memory.query(audit), sqlite.query(audit));
        });
      }),
      fuzzAssertConfig(20),
    );
  });

  test("RAISE(ABORT) and RAISE(IGNORE) match SQLite", () => {
    fc.assert(
      fc.property(fc.constantFrom("ABORT", "IGNORE"), textArb, (raise, msg) => {
        withDatabases((memory, sqlite) => {
          const safe = msg.replaceAll("'", "").slice(0, 8) || "x";
          const raiseSql = raise === "IGNORE" ? "RAISE(IGNORE)" : `RAISE(ABORT, '${safe}')`;
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
            db.exec(`CREATE TRIGGER tr BEFORE INSERT ON t BEGIN SELECT ${raiseSql}; END`);
          }
          const sql = "INSERT INTO t(id, a) VALUES (1, 1)";
          compareOutcomeOrReport("trig-raise", sql, { raise, safe }, memory.exec(sql), sqlite.exec(sql));
          const rows = "SELECT count(*) AS n FROM t";
          compareOrReport("trig-raise-rows", rows, { raise }, memory.query(rows), sqlite.query(rows));
        });
      }),
      fuzzAssertConfig(15),
    );
  });
});
