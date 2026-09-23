import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database } from "../../src/api/database.ts";
import { fuzzAssertConfig } from "./config.ts";

/**
 * Biased intersection fuzz: JSON × CTE × window sequences vs bun:sqlite.
 */
describe("combination fuzz", () => {
  test("seeded JSON+window+CTE sequences stay in parity", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 2, maxLength: 6 }), (nums) => {
        const values = nums.map((n) => `(${n},'{"n":${n}}')`).join(",");
        const sql = `
            WITH src(id, payload) AS (VALUES ${values})
            SELECT id,
                   payload ->> '$.n' AS n,
                   row_number() OVER (ORDER BY id) AS rn,
                   ntile(2) OVER (ORDER BY id) AS bucket
            FROM src
            ORDER BY id
          `;
        const memory = new Database();
        const oracle = new BunDatabase(":memory:");
        try {
          const memRows = memory.query(sql);
          const oraRows = oracle.prepare(sql).all();
          expect(memRows).toEqual(oraRows as typeof memRows);
        } finally {
          oracle.close();
          memory.close();
        }
      }),
      fuzzAssertConfig(20),
    );
  });
});
