import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const upsertArb = fc.record({
  key: fc.integer({ min: 1, max: 6 }),
  value: intArb,
  action: fc.constantFrom("nothing", "replace", "add", "excluded_arith"),
  guard: fc.constantFrom("none", "less", "differs"),
  returning: fc.boolean(),
});

type Upsert = typeof upsertArb extends fc.Arbitrary<infer T> ? T : never;

function upsertSql(upsert: Upsert): string {
  const action =
    upsert.action === "nothing"
      ? "DO NOTHING"
      : upsert.action === "replace"
        ? "DO UPDATE SET v = EXCLUDED.v"
        : upsert.action === "add"
          ? "DO UPDATE SET v = counters.v + EXCLUDED.v"
          : "DO UPDATE SET v = EXCLUDED.v * 2 - counters.v";
  const guard =
    upsert.action === "nothing" || upsert.guard === "none"
      ? ""
      : upsert.guard === "less"
        ? " WHERE counters.v < EXCLUDED.v"
        : " WHERE counters.v <> EXCLUDED.v";
  const returning = upsert.returning ? " RETURNING k, v" : "";
  return `INSERT INTO counters (k, v) VALUES (${upsert.key}, (${upsert.value})) ON CONFLICT (k) ${action}${guard}${returning}`;
}

describe("upsert differential fuzz", () => {
  test("random ON CONFLICT sequences match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(upsertArb, { minLength: 1, maxLength: 11 }), async (upserts) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE counters (k int NOT NULL UNIQUE, v int NOT NULL)");
          }

          for (const [index, upsert] of upserts.entries()) {
            const sql = upsertSql(upsert);
            const viaQuery = upsert.returning;
            compareWriteOrReport(
              `upsert-${upsert.action}`,
              sql,
              { upserts, index },
              viaQuery ? await memory.query(sql) : await memory.exec(sql),
              viaQuery ? await postgres.query(sql) : await postgres.exec(sql),
            );
          }

          const select = "SELECT k, v FROM counters ORDER BY k";
          compareOrReport("upsert-final", select, upserts, await memory.query(select), await postgres.query(select));
          await compareStateOrReport("upsert-state", upserts, memory, postgres);
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 240_000);
});
