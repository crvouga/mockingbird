import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const wordArb = fc.constantFrom("red", "green", "blue", "amber", "plum");

const t1SeedArb = fc.uniqueArray(fc.record({ id: fc.integer({ min: 1, max: 12 }), a: intArb, b: wordArb }), {
  selector: (row) => row.id,
  minLength: 0,
  maxLength: 6,
});

const t2SeedArb = fc.uniqueArray(fc.record({ id: fc.integer({ min: 1, max: 12 }), n: intArb }), {
  selector: (row) => row.id,
  minLength: 0,
  maxLength: 6,
});

const opArb = fc.record({
  kind: fc.constantFrom("insert1", "insert2", "update1", "update2", "delete1", "delete2"),
  id: fc.integer({ min: 1, max: 16 }),
  k: intArb,
  word: wordArb,
  setKind: fc.integer({ min: 0, max: 3 }),
  predKind: fc.integer({ min: 0, max: 2 }),
  byId: fc.boolean(),
  returning: fc.boolean(),
});

type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * Multi-row UPDATE/DELETE never carry RETURNING: row order of RETURNING output
 * is not deterministic, and postgres physically relocates updated tuples.
 * Multi-row statements here cannot fail (no constraints on non-PK columns), so
 * the known multi-row-atomicity divergence (tests/contract/_reports/dml-ddl.md)
 * cannot trigger.
 */
function opToSql(op: Op): string {
  const t1Returning = " RETURNING id, a, b";
  const t2Returning = " RETURNING id, n";
  switch (op.kind) {
    case "insert1":
      return `INSERT INTO t1 (id, a, b) VALUES (${op.id}, (${op.k}), '${op.word}')${op.returning ? t1Returning : ""}`;
    case "insert2":
      return `INSERT INTO t2 (id, n) VALUES (${op.id}, (${op.k}))${op.returning ? t2Returning : ""}`;
    case "update1": {
      const set =
        op.setKind === 0
          ? `a = a + (${op.k})`
          : op.setKind === 1
            ? `a = (${op.k})`
            : op.setKind === 2
              ? `b = '${op.word}'`
              : `a = a * 2, b = '${op.word}'`;
      if (op.byId) return `UPDATE t1 SET ${set} WHERE id = ${op.id}${op.returning ? t1Returning : ""}`;
      const pred = op.predKind === 0 ? `a < (${op.k})` : op.predKind === 1 ? `a >= (${op.k})` : `b = '${op.word}'`;
      return `UPDATE t1 SET ${set} WHERE ${pred}`;
    }
    case "update2": {
      const set = op.setKind % 2 === 0 ? `n = n + (${op.k})` : `n = (${op.k})`;
      if (op.byId) return `UPDATE t2 SET ${set} WHERE id = ${op.id}${op.returning ? t2Returning : ""}`;
      const pred = op.predKind === 0 ? `n < (${op.k})` : op.predKind === 1 ? `n >= (${op.k})` : `n <> (${op.k})`;
      return `UPDATE t2 SET ${set} WHERE ${pred}`;
    }
    case "delete1": {
      if (op.byId) return `DELETE FROM t1 WHERE id = ${op.id}${op.returning ? t1Returning : ""}`;
      const pred = op.predKind === 0 ? `a < (${op.k})` : op.predKind === 1 ? `a >= (${op.k})` : `b = '${op.word}'`;
      return `DELETE FROM t1 WHERE ${pred}`;
    }
    default: {
      if (op.byId) return `DELETE FROM t2 WHERE id = ${op.id}${op.returning ? t2Returning : ""}`;
      const pred = op.predKind === 0 ? `n < (${op.k})` : op.predKind === 1 ? `n >= (${op.k})` : `n <> (${op.k})`;
      return `DELETE FROM t2 WHERE ${pred}`;
    }
  }
}

describe("DML differential fuzz", () => {
  test("random insert, update, and delete sequences match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        t1SeedArb,
        t2SeedArb,
        fc.array(opArb, { minLength: 1, maxLength: 10 }),
        async (t1Rows, t2Rows, operations) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE t1 (id int PRIMARY KEY, a int, b text)");
              await db.exec("CREATE TABLE t2 (id int PRIMARY KEY, n int)");
            }
            for (const row of t1Rows) {
              const sql = "INSERT INTO t1 (id, a, b) VALUES ($1, $2, $3)";
              compareWriteOrReport(
                "dml-seed-t1",
                sql,
                row,
                await memory.exec(sql, [row.id, row.a, row.b]),
                await postgres.exec(sql, [row.id, row.a, row.b]),
              );
            }
            for (const row of t2Rows) {
              const sql = "INSERT INTO t2 (id, n) VALUES ($1, $2)";
              compareWriteOrReport(
                "dml-seed-t2",
                sql,
                row,
                await memory.exec(sql, [row.id, row.n]),
                await postgres.exec(sql, [row.id, row.n]),
              );
            }

            for (const [index, op] of operations.entries()) {
              const sql = opToSql(op);
              // RETURNING output only surfaces through query(); exec() drops rows.
              const viaQuery = sql.includes(" RETURNING ");
              compareWriteOrReport(
                `dml-${op.kind}`,
                sql,
                { t1Rows, t2Rows, operations, index },
                viaQuery ? await memory.query(sql) : await memory.exec(sql),
                viaQuery ? await postgres.query(sql) : await postgres.exec(sql),
              );
            }

            const setup = { t1Rows, t2Rows, operations };
            const sel1 = "SELECT id, a, b FROM t1 ORDER BY id";
            compareOrReport("dml-final-t1", sel1, setup, await memory.query(sel1), await postgres.query(sel1));
            const sel2 = "SELECT id, n FROM t2 ORDER BY id";
            compareOrReport("dml-final-t2", sel2, setup, await memory.query(sel2), await postgres.query(sel2));
            await compareStateOrReport("dml-state", setup, memory, postgres);
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 240_000);
});
