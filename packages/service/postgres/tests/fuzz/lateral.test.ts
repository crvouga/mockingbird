import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

describe("LATERAL differential fuzz", () => {
  test("LATERAL subquery expands per parent row", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ id: fc.integer({ min: 1, max: 15 }), a: intArb }), {
          selector: (r) => r.id,
          minLength: 1,
          maxLength: 8,
        }),
        intArb,
        async (rows, k) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE t (id int PRIMARY KEY, a int)");
              for (const row of rows) {
                await db.exec(`INSERT INTO t VALUES (${row.id}, ${row.a})`);
              }
            }
            const sql = `SELECT t.id, lat.c FROM t, LATERAL (SELECT count(*) AS c FROM t t2 WHERE t2.a <= t.a AND t2.a > (${k})) lat ORDER BY t.id`;
            compareOrReport("lateral", sql, { rows, k }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  }, 120_000);
});
