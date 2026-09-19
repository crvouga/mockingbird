import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

describe("PREPARE/EXECUTE differential fuzz", () => {
  test("prepared parameterized SELECT matches postgres", async () => {
    await fc.assert(
      fc.asyncProperty(intArb, intArb, async (threshold, limit) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE t (id int PRIMARY KEY, a int)");
            await db.exec("INSERT INTO t SELECT i, i * 2 FROM generate_series(1, 10) AS g(i)");
            await db.exec("PREPARE p AS SELECT id, a FROM t WHERE a > $1 ORDER BY id LIMIT $2");
          }
          const sql = `EXECUTE p (${threshold}, ${limit})`;
          compareOrReport(
            "prepare-exec",
            sql,
            { threshold, limit },
            await memory.query(sql),
            await postgres.query(sql),
          );
        });
      }),
      fuzzAssertConfig(15),
    );
  }, 120_000);
});
