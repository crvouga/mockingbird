import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOutcomeOrReport, compareStateOrReport, withDatabases } from "./helpers.ts";

/**
 * Single-row inserts only: multi-row INSERT statement atomicity is a known
 * divergence (memory leaves earlier rows behind on a mid-statement failure;
 * see tests/contract/_reports/dml-ddl.md), so multi-row DML is never generated.
 * Each candidate targets at most one constraint so the error category is
 * unambiguous (postgres does not promise which violation is reported first).
 */
const candidateArb = fc.record({
  violation: fc.constantFrom("none", "dup_pk", "null_a", "check_b", "dup_u"),
  a: intArb,
  b: fc.integer({ min: -50, max: 50 }),
  badB: fc.oneof(fc.integer({ min: 51, max: 200 }), fc.integer({ min: -200, max: -51 })),
});

const compositeArb = fc.record({
  x: fc.integer({ min: 1, max: 3 }),
  y: fc.integer({ min: 1, max: 3 }),
  v: intArb,
});

describe("constraint differential fuzz", () => {
  test("NOT NULL, CHECK, UNIQUE, and PK inserts agree on outcome", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(candidateArb, { minLength: 1, maxLength: 10 }), async (candidates) => {
        await withDatabases(async (memory, postgres) => {
          const create =
            "CREATE TABLE t (id int PRIMARY KEY, a int NOT NULL, b int CHECK (b BETWEEN -50 AND 50), u text UNIQUE)";
          for (const db of [memory, postgres]) {
            await db.exec(create);
          }

          const insertedIds: number[] = [];
          const insertedUs: string[] = [];
          for (const [index, candidate] of candidates.entries()) {
            const freshId = index + 100;
            const freshU = `u${index}`;
            let id = freshId;
            let a: string = String(candidate.a);
            let b = candidate.b;
            let u = freshU;
            if (candidate.violation === "dup_pk" && insertedIds.length > 0) id = insertedIds[0]!;
            if (candidate.violation === "null_a") a = "NULL";
            if (candidate.violation === "check_b") b = candidate.badB;
            if (candidate.violation === "dup_u" && insertedUs.length > 0) u = insertedUs[0]!;
            const sql = `INSERT INTO t (id, a, b, u) VALUES (${id}, ${a}, (${b}), '${u}')`;
            const memResult = await memory.exec(sql);
            compareOutcomeOrReport(
              "constraints-insert",
              sql,
              { candidates, index },
              memResult,
              await postgres.exec(sql),
            );
            if (memResult.ok) {
              insertedIds.push(id);
              insertedUs.push(u);
            }
          }

          await compareStateOrReport("constraints-state", candidates, memory, postgres);
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 240_000);

  test("composite primary key inserts agree on outcome", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(compositeArb, { minLength: 1, maxLength: 10 }), async (rows) => {
        await withDatabases(async (memory, postgres) => {
          const create = "CREATE TABLE p (x int, y int, v int, PRIMARY KEY (x, y))";
          for (const db of [memory, postgres]) {
            await db.exec(create);
          }

          for (const [index, row] of rows.entries()) {
            const sql = `INSERT INTO p (x, y, v) VALUES (${row.x}, ${row.y}, (${row.v}))`;
            compareOutcomeOrReport(
              "composite-pk-insert",
              sql,
              { rows, index },
              await memory.exec(sql),
              await postgres.exec(sql),
            );
          }

          await compareStateOrReport("composite-pk-state", rows, memory, postgres);
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
