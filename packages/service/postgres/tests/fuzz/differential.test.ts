import { describe, test } from "bun:test";
import * as fc from "fast-check";
import type { ContractDb } from "../harness/types.ts";
import { fuzzAssertConfig, intArb, realArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

/** Parenthesize negatives so generated SQL never contains a `- -` unary chain. */
function num(n: number): string {
  return n < 0 ? `(${sqlLiteral(n)})` : sqlLiteral(n);
}

interface ItemRow {
  id: number;
  n: number | null;
  r: number | null;
  s: string | null;
}

const wordArb = fc.constantFrom("apple", "banana", "cherry", "date", "elder", "fig", "grape");

const itemRowsArb: fc.Arbitrary<ItemRow[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 15 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          n: fc.oneof(fc.constant(null), intArb),
          r: fc.oneof(fc.constant(null), realArb),
          s: fc.oneof(fc.constant(null), wordArb),
        }),
      ),
    ),
  )
  .map((rows) => [...rows]);

async function seedItems(db: ContractDb, rows: ItemRow[]): Promise<void> {
  const create = await db.exec("CREATE TABLE items(id int4 PRIMARY KEY, n int4, r numeric, s text)");
  if (!create.ok) throw new Error(`seed create failed: ${create.error?.message}`);
  const tuples = rows
    .map((row) => `(${sqlLiteral(row.id)}, ${sqlLiteral(row.n)}, ${sqlLiteral(row.r)}, ${sqlLiteral(row.s)})`)
    .join(", ");
  const insert = await db.exec(`INSERT INTO items(id, n, r, s) VALUES ${tuples}`);
  if (!insert.ok) throw new Error(`seed insert failed: ${insert.error?.message}`);
}

const arithOperandArb = fc.oneof(intArb, realArb);

describe("differential fuzz", () => {
  test("random arithmetic expressions over int/numeric literals", async () => {
    await fc.assert(
      fc.asyncProperty(
        arithOperandArb,
        arithOperandArb,
        fc.constantFrom("+", "-", "*"),
        intArb,
        intArb.filter((n) => n !== 0),
        fc.constantFrom("+", "-", "*", "/", "%"),
        async (a, b, op, ia, ib, intOp) => {
          const mixedSql = `SELECT (${num(a)} ${op} ${num(b)}) AS v`;
          const intSql = `SELECT (${num(ia)} ${intOp} ${num(ib)}) AS v`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "arith-mixed",
              mixedSql,
              { a, b, op },
              await memory.query(mixedSql),
              await postgres.query(mixedSql),
            );
            compareOrReport(
              "arith-int",
              intSql,
              { ia, ib, intOp },
              await memory.query(intSql),
              await postgres.query(intSql),
            );
          });
        },
      ),
      fuzzAssertConfig(40),
    );
  }, 120_000);

  test("random WHERE filters over a seeded table", async () => {
    const predicateArb = fc.oneof(
      fc.record({
        kind: fc.constant("num" as const),
        col: fc.constantFrom("n", "id"),
        op: fc.constantFrom("=", "<>", "<", "<=", ">", ">="),
        lit: intArb,
      }),
      fc.record({ kind: fc.constant("real" as const), op: fc.constantFrom("<", ">", "<=", ">="), lit: realArb }),
      fc.record({ kind: fc.constant("null" as const), col: fc.constantFrom("n", "r", "s"), not: fc.boolean() }),
    );
    const renderPredicate = (p: fc.InferValue<typeof predicateArb>): string => {
      if (p.kind === "num") return `${p.col} ${p.op} ${num(p.lit)}`;
      if (p.kind === "real") return `r ${p.op} ${num(p.lit)}`;
      return `${p.col} IS ${p.not ? "NOT " : ""}NULL`;
    };
    await fc.assert(
      fc.asyncProperty(
        itemRowsArb,
        predicateArb,
        predicateArb,
        fc.constantFrom("AND", "OR"),
        async (rows, p1, p2, joiner) => {
          const where = `(${renderPredicate(p1)}) ${joiner} (${renderPredicate(p2)})`;
          const sql = `SELECT id, n, r, s FROM items WHERE ${where} ORDER BY id`;
          await withDatabases(async (memory, postgres) => {
            await seedItems(memory, rows);
            await seedItems(postgres, rows);
            compareOrReport("where", sql, rows, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("random ORDER BY column/direction/NULLS combos", async () => {
    await fc.assert(
      fc.asyncProperty(
        itemRowsArb,
        fc.constantFrom("n", "r", "s"),
        fc.constantFrom("ASC", "DESC"),
        fc.constantFrom("", " NULLS FIRST", " NULLS LAST"),
        async (rows, col, dir, nulls) => {
          const sql = `SELECT id, n, r, s FROM items ORDER BY ${col} ${dir}${nulls}, id ASC`;
          await withDatabases(async (memory, postgres) => {
            await seedItems(memory, rows);
            await seedItems(postgres, rows);
            compareOrReport("order-by", sql, rows, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("random LIMIT/OFFSET slices", async () => {
    await fc.assert(
      fc.asyncProperty(
        itemRowsArb,
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        async (rows, limit, offset, limitAll) => {
          const limitClause = limitAll ? "LIMIT ALL" : `LIMIT ${limit}`;
          const sql = `SELECT id, n FROM items ORDER BY id ${limitClause} OFFSET ${offset}`;
          await withDatabases(async (memory, postgres) => {
            await seedItems(memory, rows);
            await seedItems(postgres, rows);
            compareOrReport("limit-offset", sql, rows, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
