import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, withDatabases } from "./helpers.ts";

const rowsArb = fc.uniqueArray(fc.record({ id: fc.integer({ min: 1, max: 20 }), a: intArb }), {
  selector: (row) => row.id,
  minLength: 0,
  maxLength: 8,
});

type Row = { id: number; a: number };

async function seed(db: { exec(sql: string): Promise<unknown> }, rows: Row[]): Promise<void> {
  await db.exec("CREATE TABLE t (id int PRIMARY KEY, a int)");
  for (const row of rows) {
    await db.exec(`INSERT INTO t (id, a) VALUES (${row.id}, (${row.a}))`);
  }
}

describe("CTE differential fuzz", () => {
  test("random WITH chains referencing each other match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(rowsArb, fc.integer({ min: 1, max: 3 }), intArb, intArb, async (rows, depth, k1, k2) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await seed(db, rows);
          }

          const c1 = `c1 AS (SELECT id, a FROM t WHERE a >= (${k1}))`;
          const c2 = `c2 AS (SELECT id, a + (${k2}) AS a FROM c1 WHERE id <= 15)`;
          const c3 = "c3 AS (SELECT c2.id, c2.a, c1.a AS orig FROM c2 JOIN c1 ON c1.id = c2.id)";
          const sql =
            depth === 1
              ? `WITH ${c1} SELECT id, a FROM c1 ORDER BY id`
              : depth === 2
                ? `WITH ${c1}, ${c2} SELECT id, a FROM c2 ORDER BY id`
                : `WITH ${c1}, ${c2}, ${c3} SELECT id, a, orig FROM c3 ORDER BY id`;
          compareOrReport(
            "cte-chain",
            sql,
            { rows, depth, k1, k2 },
            await memory.query(sql),
            await postgres.query(sql),
          );
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 240_000);

  test("random recursive counters match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -5, max: 5 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 12 }),
        async (start, inc, steps) => {
          const limit = start + inc * steps;
          const sql = [
            `WITH RECURSIVE cnt(n) AS (SELECT (${start}) UNION ALL SELECT n + (${inc}) FROM cnt WHERE n < (${limit}))`,
            "SELECT n FROM cnt ORDER BY n",
          ].join(" ");
          const agg = [
            `WITH RECURSIVE cnt(n) AS (SELECT (${start}) UNION ALL SELECT n + (${inc}) FROM cnt WHERE n < (${limit}))`,
            "SELECT count(*) AS c, sum(n) AS s, min(n) AS mn, max(n) AS mx FROM cnt",
          ].join(" ");
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "cte-recursive",
              sql,
              { start, inc, steps },
              await memory.query(sql),
              await postgres.query(sql),
            );
            compareOrReport(
              "cte-recursive-agg",
              agg,
              { start, inc, steps },
              await memory.query(agg),
              await postgres.query(agg),
            );
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 240_000);

  test("data-modifying CTEs read in the same statement match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb,
        intArb,
        fc.integer({ min: 100, max: 110 }),
        fc.constantFrom("insert", "update", "delete"),
        async (rows, k, freshId, kind) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await seed(db, rows);
            }

            // The outer query reads only from the CTE's RETURNING output:
            // reading the modified table in the same statement is a recorded
            // snapshot divergence (tests/contract/_reports/query-surface.md).
            const sql =
              kind === "insert"
                ? `WITH ins AS (INSERT INTO t (id, a) VALUES (${freshId}, (${k})) RETURNING id, a) SELECT id, a FROM ins ORDER BY id`
                : kind === "update"
                  ? `WITH upd AS (UPDATE t SET a = a + (${k}) RETURNING id, a) SELECT id, a FROM upd ORDER BY id`
                  : `WITH del AS (DELETE FROM t WHERE a < (${k}) RETURNING id, a) SELECT id, a FROM del ORDER BY id`;
            compareOrReport(
              "cte-dml",
              sql,
              { rows, k, freshId, kind },
              await memory.query(sql),
              await postgres.query(sql),
            );

            const state = "SELECT id, a FROM t ORDER BY id";
            compareOrReport(
              "cte-dml-final",
              state,
              { rows, k, freshId, kind },
              await memory.query(state),
              await postgres.query(state),
            );
            await compareStateOrReport("cte-dml-state", { rows, k, freshId, kind }, memory, postgres);
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
