import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

describe("generated column differential fuzz", () => {
  test("STORED generated column reflects source updates", async () => {
    await fc.assert(
      fc.asyncProperty(intArb, intArb, async (a, b) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec(
              "CREATE TABLE t (id int PRIMARY KEY, a int, b int, s int GENERATED ALWAYS AS (a + b) STORED)",
            );
            await db.exec(`INSERT INTO t (id, a, b) VALUES (1, ${a}, ${b})`);
          }
          const sel = "SELECT a, b, s FROM t ORDER BY id";
          compareOrReport("gen-select", sel, { a, b }, await memory.query(sel), await postgres.query(sel));
          const upd = `UPDATE t SET a = a + 1 WHERE id = 1`;
          compareOrReport("gen-update", upd, { a, b }, await memory.query(upd), await postgres.query(upd));
          compareOrReport("gen-after", sel, { a, b }, await memory.query(sel), await postgres.query(sel));
        });
      }),
      fuzzAssertConfig(15),
    );
  }, 120_000);
});
