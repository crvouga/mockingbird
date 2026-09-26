import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const actionArb = fc.constantFrom("insert", "begin", "commit", "rollback", "savepoint", "release", "rollback_to");

describe("transaction differential fuzz", () => {
  test("random transaction and savepoint sequences match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            action: actionArb,
            id: fc.integer({ min: 1, max: 12 }),
            value: textArb,
          }),
          { minLength: 3, maxLength: 16 },
        ),
        (steps) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)");
            }

            let savepointDepth = 0;
            let inTxn = false;

            for (const [index, step] of steps.entries()) {
              let sql: string;
              if (step.action === "insert") {
                sql = `INSERT OR REPLACE INTO t(id, value) VALUES (${step.id}, '${step.value.replaceAll("'", "''")}')`;
              } else if (step.action === "begin") {
                if (inTxn) continue;
                sql = "BEGIN";
                inTxn = true;
              } else if (step.action === "commit") {
                if (!inTxn) continue;
                sql = "COMMIT";
                inTxn = false;
                savepointDepth = 0;
              } else if (step.action === "rollback") {
                if (!inTxn) continue;
                sql = "ROLLBACK";
                inTxn = false;
                savepointDepth = 0;
              } else if (step.action === "savepoint") {
                if (!inTxn) {
                  for (const db of [memory, sqlite]) db.exec("BEGIN");
                  inTxn = true;
                }
                savepointDepth++;
                sql = `SAVEPOINT sp${savepointDepth}`;
              } else if (step.action === "release") {
                if (savepointDepth === 0) continue;
                sql = `RELEASE sp${savepointDepth}`;
                savepointDepth--;
              } else {
                if (savepointDepth === 0) continue;
                sql = `ROLLBACK TO sp${savepointDepth}`;
              }

              compareOutcomeOrReport(`txn-${step.action}`, sql, { steps, index }, memory.exec(sql), sqlite.exec(sql));
            }

            if (inTxn) {
              compareOutcomeOrReport("txn-final-commit", "COMMIT", steps, memory.exec("COMMIT"), sqlite.exec("COMMIT"));
            }

            const select = "SELECT id, value FROM t ORDER BY id";
            compareOrReport("txn-final", select, steps, memory.query(select), sqlite.query(select));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });
});
