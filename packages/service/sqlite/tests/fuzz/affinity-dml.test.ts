import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, realArb, textArb } from "./config.ts";
import { compareOrReport, compareWriteOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const affinityArb = fc.constantFrom("INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", "");
const valueArb = fc.oneof(nullArb, intArb, realArb, textArb, fc.constantFrom("42", "3.25", "not-a-number", ""));

describe("affinity DML differential fuzz", () => {
  test("INSERT and typeof agree across declared affinities", () => {
    fc.assert(
      fc.property(affinityArb, fc.array(valueArb, { minLength: 1, maxLength: 6 }), (affinity, values) => {
        withDatabases((memory, sqlite) => {
          const decl = affinity === "" ? "v" : `v ${affinity}`;
          const ddl = `CREATE TABLE t(${decl})`;
          for (const db of [memory, sqlite]) db.exec(ddl);

          for (const [index, value] of values.entries()) {
            const lit = sqlLiteral(value);
            const sql = `INSERT INTO t VALUES (${lit})`;
            compareWriteOrReport(
              "affinity-dml-insert",
              sql,
              { affinity, value, index },
              memory.exec(sql),
              sqlite.exec(sql),
            );
          }

          const select = "SELECT v, typeof(v) AS t FROM t ORDER BY rowid";
          compareOrReport(
            "affinity-dml-select",
            select,
            { affinity, values },
            memory.query(select),
            sqlite.query(select),
          );
        });
      }),
      fuzzAssertConfig(25),
    );
  });

  test("INSERT SELECT applies destination affinity", () => {
    fc.assert(
      fc.property(affinityArb, fc.array(valueArb, { minLength: 1, maxLength: 5 }), (affinity, values) => {
        withDatabases((memory, sqlite) => {
          const decl = affinity === "" ? "v" : `v ${affinity}`;
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE src(v)");
            db.exec(`CREATE TABLE dst(${decl})`);
            for (const value of values) {
              db.exec(`INSERT INTO src VALUES (${sqlLiteral(value)})`);
            }
          }
          const insert = "INSERT INTO dst SELECT v FROM src";
          compareWriteOrReport(
            "affinity-insert-select",
            insert,
            { affinity, values },
            memory.exec(insert),
            sqlite.exec(insert),
          );
          const select = "SELECT v, typeof(v) AS t FROM dst ORDER BY rowid";
          compareOrReport(
            "affinity-insert-select-out",
            select,
            { affinity, values },
            memory.query(select),
            sqlite.query(select),
          );
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
