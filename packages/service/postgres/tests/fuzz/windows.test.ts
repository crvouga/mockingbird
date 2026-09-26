import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

/** Small value range so ties are common. */
const rowsArb = fc.array(fc.record({ grp: fc.integer({ min: 0, max: 2 }), v: fc.integer({ min: 0, max: 4 }) }), {
  minLength: 1,
  maxLength: 12,
});

const frameArb = fc.oneof(
  fc.constant("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"),
  fc.integer({ min: 0, max: 3 }).map((k) => `ROWS BETWEEN UNBOUNDED PRECEDING AND ${k} FOLLOWING`),
  fc.integer({ min: 0, max: 3 }).map((k) => `ROWS BETWEEN ${k} PRECEDING AND CURRENT ROW`),
  fc
    .tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }))
    .map(([a, b]) => `ROWS BETWEEN ${a} PRECEDING AND ${b} FOLLOWING`),
  fc.constant("ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING"),
  fc.integer({ min: 0, max: 3 }).map((k) => `ROWS BETWEEN CURRENT ROW AND ${k} FOLLOWING`),
);

const specArb = fc.record({
  fn: fc.constantFrom("row_number", "rank", "dense_rank", "lag", "lead", "sum"),
  partitioned: fc.boolean(),
  desc: fc.boolean(),
  offset: fc.integer({ min: 1, max: 2 }),
  frame: frameArb,
});

type Spec = typeof specArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * The window ORDER BY is tiebroken by the unique id for row_number/lag/lead/sum
 * so results are deterministic despite ties in v; rank/dense_rank rank by v
 * alone (their output is deterministic under ties).
 */
function windowExpr(spec: Spec): string {
  const partition = spec.partitioned ? "PARTITION BY grp " : "";
  const dir = spec.desc ? "DESC" : "ASC";
  const rankedOrder = `ORDER BY v ${dir}`;
  const uniqueOrder = `ORDER BY v ${dir}, id`;
  switch (spec.fn) {
    case "row_number":
      return `row_number() OVER (${partition}${uniqueOrder})`;
    case "rank":
      return `rank() OVER (${partition}${rankedOrder})`;
    case "dense_rank":
      return `dense_rank() OVER (${partition}${rankedOrder})`;
    case "lag":
      return `lag(v, ${spec.offset}, (-1)) OVER (${partition}${uniqueOrder})`;
    case "lead":
      return `lead(v, ${spec.offset}, (-1)) OVER (${partition}${uniqueOrder})`;
    default:
      return `sum(v) OVER (${partition}${uniqueOrder} ${spec.frame})`;
  }
}

describe("window differential fuzz", () => {
  test("random window functions, partitions, and ROWS frames match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(rowsArb, specArb, specArb, async (rows, specA, specB) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE w (id int PRIMARY KEY, grp int, v int)");
            for (const [index, row] of rows.entries()) {
              await db.exec(`INSERT INTO w (id, grp, v) VALUES (${index + 1}, ${row.grp}, ${row.v})`);
            }
          }

          const sql = [
            `SELECT id, grp, v, ${windowExpr(specA)} AS fa, ${windowExpr(specB)} AS fb`,
            "FROM w ORDER BY id, grp, v",
          ].join(" ");
          compareOrReport("windows", sql, { rows, specA, specB }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 240_000);
});
