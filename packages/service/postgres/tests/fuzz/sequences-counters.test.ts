import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const seqOpArb = fc.record({
  seq: fc.constantFrom("s1", "s2"),
  kind: fc.constantFrom("nextval", "nextval", "currval", "setval"),
  k: fc.integer({ min: 1, max: 400 }),
  isCalled: fc.boolean(),
});

const serialOpArb = fc.record({
  explicit: fc.boolean(),
  v: intArb,
});

describe("sequence differential fuzz", () => {
  test("random nextval, currval, and setval sequences match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 5 }),
        fc.array(seqOpArb, { minLength: 1, maxLength: 11 }),
        async (start, increment, operations) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE SEQUENCE s1");
              await db.exec(`CREATE SEQUENCE s2 START WITH ${start} INCREMENT BY ${increment}`);
            }

            // currval only after nextval on the same sequence in this session
            const called: Record<string, boolean> = { s1: false, s2: false };
            for (const [index, op] of operations.entries()) {
              let sql: string;
              if (op.kind === "currval") {
                if (!called[op.seq]) continue;
                sql = `SELECT currval('${op.seq}') AS v`;
              } else if (op.kind === "setval") {
                sql = `SELECT setval('${op.seq}', ${op.k}, ${op.isCalled}) AS v`;
              } else {
                sql = `SELECT nextval('${op.seq}') AS v`;
                called[op.seq] = true;
              }
              compareOrReport(
                `seq-${op.kind}`,
                sql,
                { start, increment, operations, index },
                await memory.query(sql),
                await postgres.query(sql),
              );
            }
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 240_000);

  test("serial column inserts match postgres per step", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(serialOpArb, { minLength: 1, maxLength: 10 }), async (operations) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE st (id serial PRIMARY KEY, v int)");
          }

          for (const [index, op] of operations.entries()) {
            // explicit ids live far from the serial range so they never collide
            const sql = op.explicit
              ? `INSERT INTO st (id, v) VALUES (${900 + index}, (${op.v})) RETURNING id, v`
              : `INSERT INTO st (v) VALUES ((${op.v})) RETURNING id, v`;
            compareWriteOrReport(
              "serial-insert",
              sql,
              { operations, index },
              await memory.query(sql),
              await postgres.query(sql),
            );
          }

          const select = "SELECT id, v FROM st ORDER BY id";
          compareOrReport("serial-final", select, operations, await memory.query(select), await postgres.query(select));
          await compareStateOrReport("serial-state", operations, memory, postgres);
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
