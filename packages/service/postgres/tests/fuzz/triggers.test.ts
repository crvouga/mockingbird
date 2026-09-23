import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const wordArb = fc.constantFrom("alpha", "beta", "gamma", "delta", "echo");

describe("trigger differential fuzz", () => {
  test("BEFORE INSERT trigger increments audit counter", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 20 }), v: wordArb }), { minLength: 1, maxLength: 6 }),
        intArb,
        async (rows, bump) => {
          await withDatabases(async (memory, postgres) => {
            const setup = `
              CREATE TABLE t (id int PRIMARY KEY, v text);
              CREATE TABLE audit (n int NOT NULL DEFAULT 0);
              INSERT INTO audit VALUES (0);
              CREATE FUNCTION bump_audit() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                UPDATE audit SET n = n + ${bump};
                RETURN NEW;
              END;
              $$;
              CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION bump_audit();
            `;
            for (const db of [memory, postgres]) await db.exec(setup);
            for (const row of rows) {
              const sql = `INSERT INTO t VALUES (${row.id}, ${sqlLiteral(row.v)})`;
              compareOrReport("trig-insert", sql, { row, bump }, await memory.query(sql), await postgres.query(sql));
            }
            const auditSql = "SELECT n FROM audit";
            compareOrReport(
              "trig-audit",
              auditSql,
              { rows, bump },
              await memory.query(auditSql),
              await postgres.query(auditSql),
            );
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);
});
