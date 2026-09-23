import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

describe("change counter differential fuzz", () => {
  test("changes total_changes last_insert_rowid across txn match SQLite", () => {
    fc.assert(
      fc.property(fc.array(intArb, { minLength: 1, maxLength: 6 }), fc.boolean(), (values, useTxn) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
          }
          if (useTxn) {
            compareOutcomeOrReport("cnt-begin", "BEGIN", {}, memory.exec("BEGIN"), sqlite.exec("BEGIN"));
          }
          for (const [i, a] of values.entries()) {
            const sql = `INSERT INTO t(id, a) VALUES (${i + 1}, ${a})`;
            compareOrReport("cnt-ins", sql, { a }, memory.exec(sql), sqlite.exec(sql));
          }
          if (useTxn) {
            compareOutcomeOrReport("cnt-rb", "ROLLBACK", {}, memory.exec("ROLLBACK"), sqlite.exec("ROLLBACK"));
            const after = "SELECT total_changes() AS t, last_insert_rowid() AS r";
            compareOrReport("cnt-after-rb", after, { values }, memory.query(after), sqlite.query(after));
            for (const [i, a] of values.entries()) {
              const sql = `INSERT INTO t(id, a) VALUES (${i + 1}, ${a})`;
              compareOrReport("cnt-reins", sql, { a }, memory.exec(sql), sqlite.exec(sql));
            }
          }
          const multi = values.map((_, i) => `INSERT INTO t(id, a) VALUES (${100 + i}, ${values[i]})`).join(";");
          if (multi.length > 0) {
            compareOutcomeOrReport("cnt-multi", multi, { values }, memory.exec(multi), sqlite.exec(multi));
          }
          const final = "SELECT changes() AS c, total_changes() AS t, last_insert_rowid() AS r, count(*) AS n FROM t";
          compareOrReport("cnt-final", final, { values, useTxn }, memory.query(final), sqlite.query(final));
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
