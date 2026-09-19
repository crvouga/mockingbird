import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, realArb, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const candidateArb = fc.record({
  a: intArb,
  b: fc.oneof(nullArb, textArb),
});

describe("constraint differential fuzz", () => {
  test("UNIQUE and CHECK inserts agree on acceptance and error category", () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { minLength: 1, maxLength: 12 }), (candidates) => {
        withDatabases((memory, sqlite) => {
          const create = [
            "CREATE TABLE t(",
            "id INTEGER PRIMARY KEY,",
            "a INT CHECK(a >= -10 AND a <= 10),",
            "b TEXT UNIQUE)",
          ].join(" ");
          memory.exec(create);
          sqlite.exec(create);

          candidates.forEach((candidate, index) => {
            const sql = "INSERT INTO t(id, a, b) VALUES (?, ?, ?)";
            // Avoid candidates that violate CHECK and UNIQUE simultaneously:
            // SQLite does not promise which constraint error is reported first.
            const b = candidate.a >= -10 && candidate.a <= 10 ? candidate.b : `check-failure-${index}`;
            const params = [index + 1, candidate.a, b] as const;
            compareOutcomeOrReport(
              "constraints-insert",
              sql,
              { candidates, index },
              memory.exec(sql, [...params]),
              sqlite.exec(sql, [...params]),
            );
          });

          const select = "SELECT id, a, b FROM t ORDER BY id";
          compareOrReport("constraints-final", select, candidates, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(35),
    );
  });

  test("STRICT INT inserts agree on acceptance and stored typeof", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(intArb, realArb, textArb, nullArb), { minLength: 1, maxLength: 8 }), (values) => {
        withDatabases((memory, sqlite) => {
          const create = "CREATE TABLE t(id INTEGER PRIMARY KEY, x INT) STRICT";
          compareOrReport("strict-create", create, values, memory.exec(create), sqlite.exec(create));
          values.forEach((value, index) => {
            const sql = "INSERT INTO t(id, x) VALUES (?, ?)";
            compareOutcomeOrReport(
              "strict-insert",
              sql,
              { values, index },
              memory.exec(sql, [index + 1, value]),
              sqlite.exec(sql, [index + 1, value]),
            );
          });
          const select = "SELECT id, typeof(x) AS t, x FROM t ORDER BY id";
          compareOrReport("strict-final", select, values, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(25),
    );
  });

  test("deferred FK commit sequences agree", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 0, maxLength: 6 }),
        (childParents, parentIds) => {
          withDatabases((memory, sqlite) => {
            const setup = [
              "PRAGMA foreign_keys=ON",
              "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
              "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
            ];
            for (const sql of setup) {
              compareOrReport("deferred-setup", sql, { childParents, parentIds }, memory.exec(sql), sqlite.exec(sql));
            }
            compareOrReport(
              "deferred-begin",
              "BEGIN",
              { childParents, parentIds },
              memory.exec("BEGIN"),
              sqlite.exec("BEGIN"),
            );
            childParents.forEach((parentId, index) => {
              const sql = "INSERT INTO child(id, parent_id) VALUES (?, ?)";
              compareOutcomeOrReport(
                "deferred-child",
                sql,
                { childParents, parentIds, index },
                memory.exec(sql, [index + 1, parentId]),
                sqlite.exec(sql, [index + 1, parentId]),
              );
            });
            const uniqueParents = [...new Set(parentIds)];
            uniqueParents.forEach((id, index) => {
              const sql = "INSERT OR IGNORE INTO parent(id) VALUES (?)";
              compareOutcomeOrReport(
                "deferred-parent",
                sql,
                { childParents, parentIds, index },
                memory.exec(sql, [id]),
                sqlite.exec(sql, [id]),
              );
            });
            compareOutcomeOrReport(
              "deferred-commit",
              "COMMIT",
              { childParents, parentIds },
              memory.exec("COMMIT"),
              sqlite.exec("COMMIT"),
            );
            const select = "SELECT id, parent_id FROM child ORDER BY id";
            compareOrReport(
              "deferred-final",
              select,
              { childParents, parentIds },
              memory.query(select),
              sqlite.query(select),
            );
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
