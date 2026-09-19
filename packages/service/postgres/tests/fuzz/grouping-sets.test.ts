import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

describe("grouping sets differential fuzz", () => {
  test("ROLLUP and CUBE aggregates match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            g: fc.integer({ min: 0, max: 2 }),
            c: fc.integer({ min: 0, max: 2 }),
            v: intArb,
          }),
          { minLength: 2, maxLength: 10 },
        ),
        fc.constantFrom("ROLLUP", "CUBE") as fc.Arbitrary<"ROLLUP" | "CUBE">,
        async (rows, kind) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE o (g int, c int, v int)");
              for (const row of rows) {
                await db.exec(`INSERT INTO o VALUES (${row.g}, ${row.c}, ${row.v})`);
              }
            }
            const sql = `SELECT g, c, sum(v) AS s, count(*) AS n FROM o GROUP BY ${kind} (g, c) ORDER BY g NULLS LAST, c NULLS LAST, s`;
            compareOrReport(
              `grouping-${kind}`,
              sql,
              { rows, kind },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);
});
