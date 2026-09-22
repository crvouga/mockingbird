import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const modeArb = fc.constantFrom("OR ABORT", "OR FAIL", "OR IGNORE", "OR REPLACE", "OR ROLLBACK");
const constraintArb = fc.constantFrom("UNIQUE", "CHECK");

describe("conflict OR-mode differential fuzz", () => {
  test("INSERT OR-mode outcomes match SQLite for UNIQUE and CHECK", () => {
    fc.assert(
      fc.property(
        modeArb,
        constraintArb,
        fc.array(intArb, { minLength: 2, maxLength: 8 }),
        (mode, constraint, values) => {
          withDatabases((memory, sqlite) => {
            const ddl =
              constraint === "UNIQUE"
                ? "CREATE TABLE t(v INTEGER UNIQUE)"
                : "CREATE TABLE t(v INTEGER CHECK(v >= -5 AND v <= 5))";
            for (const db of [memory, sqlite]) db.exec(ddl);

            for (const [index, value] of values.entries()) {
              // Keep UNIQUE and CHECK failures disjoint so error category is stable.
              const v =
                constraint === "CHECK" && (value < -5 || value > 5)
                  ? value
                  : constraint === "UNIQUE"
                    ? value
                    : ((value % 11) + 11) % 11; // -5..5 for CHECK path when in range
              const sql = `INSERT ${mode} INTO t VALUES (${constraint === "CHECK" && value >= -5 && value <= 5 ? v : value})`;
              compareOutcomeOrReport(
                "conflict-insert",
                sql,
                { mode, constraint, values, index },
                memory.exec(sql),
                sqlite.exec(sql),
              );
            }

            const select = "SELECT v FROM t ORDER BY rowid";
            compareOrReport(
              "conflict-select",
              select,
              { mode, constraint, values },
              memory.query(select),
              sqlite.query(select),
            );
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("UPDATE OR-mode UNIQUE mid-table matches SQLite", () => {
    fc.assert(
      fc.property(modeArb, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 10, max: 40 }), (mode, id, newV) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)");
            db.exec("INSERT INTO t VALUES (1,10),(2,20),(3,30),(4,40)");
          }
          const sql = `UPDATE ${mode} t SET v = ${newV} WHERE id = ${id}`;
          compareOutcomeOrReport("conflict-update", sql, { mode, id, newV }, memory.exec(sql), sqlite.exec(sql));
          const select = "SELECT id, v FROM t ORDER BY id";
          compareOrReport(
            "conflict-update-select",
            select,
            { mode, id, newV },
            memory.query(select),
            sqlite.query(select),
          );
        });
      }),
      fuzzAssertConfig(25),
    );
  });
});
