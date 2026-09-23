import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const textArb = fc.array(fc.constantFrom(..."abcABCxyz ".split("")), { maxLength: 8 }).map((c) => c.join(""));

describe("collation differential fuzz", () => {
  test("C collation ordering matches postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          textArb.filter((s) => s.length > 0),
          { minLength: 2, maxLength: 6 },
        ),
        async (values) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec('CREATE TABLE t (v text COLLATE "C")');
              for (const v of values) await db.exec(`INSERT INTO t VALUES (${sqlLiteral(v)})`);
            }
            const sql = 'SELECT v FROM t ORDER BY v COLLATE "C"';
            compareOrReport("collate-order", sql, { values }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  }, 120_000);
});
