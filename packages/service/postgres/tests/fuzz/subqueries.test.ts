import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, nullArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const smallIntArb = fc.integer({ min: -5, max: 5 });

const tRowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 12 }),
    a: fc.oneof(nullArb, smallIntArb),
    g: fc.integer({ min: 0, max: 2 }),
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 7 },
);

type TRow = { id: number; a: number | null; g: number };

async function seed(db: { exec(sql: string): Promise<unknown> }, table: string, rows: TRow[]): Promise<void> {
  await db.exec(`CREATE TABLE ${table} (id int PRIMARY KEY, a int, g int)`);
  for (const row of rows) {
    const a = row.a === null ? "NULL" : `(${row.a})`;
    await db.exec(`INSERT INTO ${table} (id, a, g) VALUES (${row.id}, ${a}, ${row.g})`);
  }
}

describe("subquery differential fuzz", () => {
  test("scalar, EXISTS, and ANY/ALL subqueries match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(tRowsArb, tRowsArb, smallIntArb, fc.integer({ min: 0, max: 2 }), async (tRows, sRows, k, g) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await seed(db, "t", tRows);
            await seed(db, "s", sRows);
          }

          const cases = [
            "SELECT t.id, (SELECT max(s.a) FROM s) AS m FROM t ORDER BY t.id",
            "SELECT t.id, (SELECT sum(s.a) FROM s WHERE s.g = t.g) AS m FROM t ORDER BY t.id",
            "SELECT t.id, (SELECT min(s.a) FROM s WHERE s.g = t.g) AS m FROM t ORDER BY t.id",
            "SELECT t.id, (SELECT count(*) FROM s WHERE s.a = t.a) AS c FROM t ORDER BY t.id",
            `SELECT t.id, (SELECT count(*) FROM s WHERE s.g = t.g AND s.a > (${k})) AS c FROM t ORDER BY t.id`,
            "SELECT t.id FROM t WHERE EXISTS (SELECT 1 FROM s WHERE s.a = t.a) ORDER BY t.id",
            `SELECT t.id FROM t WHERE NOT EXISTS (SELECT 1 FROM s WHERE s.g = t.g AND s.a > (${k})) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a > ANY (SELECT s.a FROM s WHERE s.g = ${g}) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a <= ALL (SELECT s.a FROM s WHERE s.g <> ${g}) ORDER BY t.id`,
            `SELECT t.id FROM t WHERE t.a = ANY (SELECT s.a FROM s) ORDER BY t.id`,
          ];
          for (const sql of cases) {
            compareOrReport(
              "subquery",
              sql,
              { tRows, sRows, k, g },
              await memory.query(sql),
              await postgres.query(sql),
            );
          }
        });
      }),
      fuzzAssertConfig(20),
    );
  }, 240_000);

  test("IN and NOT IN with deliberate NULLs match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        tRowsArb,
        fc.array(fc.oneof(nullArb, smallIntArb), { minLength: 0, maxLength: 6 }),
        fc.oneof(nullArb, smallIntArb),
        async (tRows, haystack, needle) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await seed(db, "t", tRows);
              await db.exec("CREATE TABLE s (a int)");
              for (const value of haystack) {
                await db.exec(`INSERT INTO s (a) VALUES (${value === null ? "NULL" : `(${value})`})`);
              }
            }

            const lit = needle === null ? "NULL::int" : `(${needle})::int`;
            const inList =
              haystack.length === 0
                ? "((-999))"
                : `(${haystack.map((v) => (v === null ? "NULL" : `(${v})`)).join(", ")})`;
            const cases = [
              "SELECT t.id FROM t WHERE t.a IN (SELECT a FROM s) ORDER BY t.id",
              "SELECT t.id FROM t WHERE t.a NOT IN (SELECT a FROM s) ORDER BY t.id",
              `SELECT t.id FROM t WHERE t.a IN ${inList} ORDER BY t.id`,
              `SELECT t.id FROM t WHERE t.a NOT IN ${inList} ORDER BY t.id`,
              `SELECT ${lit} IN (SELECT a FROM s) AS v`,
              `SELECT ${lit} NOT IN (SELECT a FROM s) AS v`,
              `SELECT ${lit} IN (SELECT a FROM s WHERE false) AS v`,
              `SELECT ${lit} NOT IN (SELECT a FROM s WHERE false) AS v`,
            ];
            for (const sql of cases) {
              compareOrReport(
                "in-null",
                sql,
                { tRows, haystack, needle },
                await memory.query(sql),
                await postgres.query(sql),
              );
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
