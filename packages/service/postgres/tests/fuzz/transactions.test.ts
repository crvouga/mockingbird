import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, compareStateOrReport, withDatabases } from "./helpers.ts";

/**
 * Known divergences steered around (tests/contract/_reports/session-system.md):
 * - No aborted-transaction state in memory — every generated statement is one
 *   that cannot fail (upsert, update/delete by key), so a transaction never
 *   enters the aborted state.
 * - ROLLBACK TO the same savepoint twice diverges — savepoints are forgotten
 *   after one rollback and names are never reused.
 */
const stepArb = fc.record({
  action: fc.constantFrom(
    "upsert",
    "update",
    "delete",
    "begin",
    "commit",
    "rollback",
    "savepoint",
    "release",
    "rollback_to",
  ),
  id: fc.integer({ min: 1, max: 8 }),
  v: intArb,
});

type Step = typeof stepArb extends fc.Arbitrary<infer T> ? T : never;

describe("transaction differential fuzz", () => {
  test("random transaction and savepoint sequences match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 12 }), async (steps) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE t (id int PRIMARY KEY, v int)");
          }

          let inTxn = false;
          let spCounter = 0;
          const spStack: string[] = [];

          const run = async (label: string, sql: string, index: number, dml: boolean): Promise<void> => {
            const mem = await memory.exec(sql);
            const pg = await postgres.exec(sql);
            if (dml) {
              compareOrReport(label, sql, { steps, index }, mem, pg);
            } else {
              compareOutcomeOrReport(label, sql, { steps, index }, mem, pg);
            }
          };

          for (const [index, step] of steps.entries()) {
            const s: Step = step;
            if (s.action === "upsert") {
              await run(
                "txn-upsert",
                `INSERT INTO t (id, v) VALUES (${s.id}, (${s.v})) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v`,
                index,
                true,
              );
            } else if (s.action === "update") {
              await run("txn-update", `UPDATE t SET v = v + (${s.v}) WHERE id = ${s.id}`, index, true);
            } else if (s.action === "delete") {
              await run("txn-delete", `DELETE FROM t WHERE id = ${s.id}`, index, true);
            } else if (s.action === "begin") {
              if (inTxn) continue;
              await run("txn-begin", "BEGIN", index, false);
              inTxn = true;
            } else if (s.action === "commit") {
              if (!inTxn) continue;
              await run("txn-commit", "COMMIT", index, false);
              inTxn = false;
              spStack.length = 0;
            } else if (s.action === "rollback") {
              if (!inTxn) continue;
              await run("txn-rollback", "ROLLBACK", index, false);
              inTxn = false;
              spStack.length = 0;
            } else if (s.action === "savepoint") {
              if (!inTxn) continue;
              spCounter += 1;
              const name = `sp${spCounter}`;
              await run("txn-savepoint", `SAVEPOINT ${name}`, index, false);
              spStack.push(name);
            } else if (s.action === "release") {
              const name = spStack.pop();
              if (name === undefined) continue;
              await run("txn-release", `RELEASE SAVEPOINT ${name}`, index, false);
            } else {
              // rollback_to: forget the savepoint afterwards (reuse diverges)
              const name = spStack.pop();
              if (name === undefined) continue;
              await run("txn-rollback-to", `ROLLBACK TO SAVEPOINT ${name}`, index, false);
            }
          }

          if (inTxn) {
            await run("txn-final-commit", "COMMIT", steps.length, false);
          }

          const select = "SELECT id, v FROM t ORDER BY id";
          compareOrReport("txn-final", select, steps, await memory.query(select), await postgres.query(select));
          await compareStateOrReport("txn-state", steps, memory, postgres);
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 240_000);
});
