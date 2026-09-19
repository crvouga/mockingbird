import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 20 }),
  a: intArb,
  b: textArb,
});

const operationArb = fc.record({
  kind: fc.constantFrom("insert", "update", "delete"),
  id: fc.integer({ min: 1, max: 30 }),
  a: intArb,
  b: textArb,
});

describe("DML differential fuzz", () => {
  test("random insert, update, and delete sequences match SQLite", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (row) => row.id, minLength: 0, maxLength: 8 }),
        fc.array(operationArb, { minLength: 1, maxLength: 12 }),
        (initialRows, operations) => {
          withDatabases((memory, sqlite) => {
            const create = "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)";
            compareOrReport("dml-create", create, initialRows, memory.exec(create), sqlite.exec(create));

            for (const row of initialRows) {
              const sql = "INSERT INTO t(id, a, b) VALUES (?, ?, ?)";
              compareWriteOrReport(
                "dml-seed",
                sql,
                row,
                memory.exec(sql, [row.id, row.a, row.b]),
                sqlite.exec(sql, [row.id, row.a, row.b]),
              );
            }

            for (const operation of operations) {
              const [sql, params] =
                operation.kind === "insert"
                  ? ["INSERT INTO t(id, a, b) VALUES (?, ?, ?)", [operation.id, operation.a, operation.b]]
                  : operation.kind === "update"
                    ? ["UPDATE t SET a = ?, b = ? WHERE id = ?", [operation.a, operation.b, operation.id]]
                    : ["DELETE FROM t WHERE id = ?", [operation.id]];
              compareWriteOrReport(
                `dml-${operation.kind}`,
                sql,
                { initialRows, operations, operation },
                memory.exec(sql, params),
                sqlite.exec(sql, params),
              );
            }

            const select = "SELECT id, a, b FROM t ORDER BY id";
            compareOrReport(
              "dml-final",
              select,
              { initialRows, operations },
              memory.query(select),
              sqlite.query(select),
            );
            compareStateOrReport("dml-state", { initialRows, operations }, memory, sqlite);
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });
});
