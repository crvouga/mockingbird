import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, nullArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  g1: fc.integer({ min: 0, max: 2 }),
  g2: fc.integer({ min: 0, max: 1 }),
  v: fc.oneof(nullArb, fc.integer({ min: -20, max: 20 })),
});

const havingArb = fc.record({
  kind: fc.constantFrom("none", "count", "sum", "min_not_null"),
  n: fc.integer({ min: 0, max: 4 }),
  k: fc.integer({ min: -30, max: 30 }),
});

type Having = typeof havingArb extends fc.Arbitrary<infer T> ? T : never;

function havingClause(having: Having): string {
  switch (having.kind) {
    case "none":
      return "";
    case "count":
      return ` HAVING count(*) > ${having.n}`;
    case "sum":
      return ` HAVING sum(v) > (${having.k})`;
    default:
      return " HAVING min(v) IS NOT NULL";
  }
}

describe("aggregate differential fuzz", () => {
  test("random GROUP BY, HAVING, FILTER, and DISTINCT aggregates match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArb, { minLength: 0, maxLength: 16 }),
        fc.integer({ min: 0, max: 2 }),
        havingArb,
        fc.integer({ min: -15, max: 15 }),
        async (rows, groupCount, having, threshold) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE t (g1 int, g2 int, v int)");
              for (const row of rows) {
                const v = row.v === null ? "NULL" : `(${row.v})`;
                await db.exec(`INSERT INTO t (g1, g2, v) VALUES (${row.g1}, ${row.g2}, ${v})`);
              }
            }

            const aggs = [
              "count(*) AS c_all",
              "count(v) AS c_v",
              "sum(v) AS s_v",
              "min(v) AS mn",
              "max(v) AS mx",
              "avg(v)::numeric AS av",
              "count(DISTINCT v) AS c_d",
              "sum(DISTINCT v) AS s_d",
              `count(v) FILTER (WHERE v > (${threshold})) AS f_gt`,
              `count(*) FILTER (WHERE v <= (${threshold})) AS c_f`,
              `sum(v) FILTER (WHERE v > (${threshold})) AS s_f`,
              `min(v) FILTER (WHERE v > (${threshold})) AS mn_f`,
              `max(v) FILTER (WHERE v > (${threshold})) AS mx_f`,
            ].join(", ");
            const keys = groupCount === 0 ? [] : groupCount === 1 ? ["g1"] : ["g1", "g2"];
            const groupBy = keys.length > 0 ? ` GROUP BY ${keys.join(", ")}` : "";
            const orderBy = keys.length > 0 ? ` ORDER BY ${keys.join(", ")}` : "";
            const select = keys.length > 0 ? `${keys.join(", ")}, ${aggs}` : aggs;
            const sql = `SELECT ${select} FROM t${groupBy}${havingClause(having)}${orderBy}`;
            compareOrReport(
              "aggregates",
              sql,
              { rows, groupCount, having, threshold },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 240_000);
});
