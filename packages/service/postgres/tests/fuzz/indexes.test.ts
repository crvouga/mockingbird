import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

describe("index differential fuzz", () => {
  test("indexed equality lookup matches postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ id: fc.integer({ min: 1, max: 30 }), a: intArb }), {
          selector: (r) => r.id,
          minLength: 3,
          maxLength: 12,
        }),
        intArb,
        async (rows, probe) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE t (id int PRIMARY KEY, a int)");
              await db.exec("CREATE INDEX t_a_idx ON t (a)");
              for (const row of rows) await db.exec(`INSERT INTO t VALUES (${row.id}, ${row.a})`);
            }
            const sql = `SELECT id, a FROM t WHERE a = ${probe} ORDER BY id`;
            compareOrReport("index-eq", sql, { rows, probe }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  }, 120_000);
});
