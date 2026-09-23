import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const wordArb = fc.constantFrom("ash", "birch", "cedar", "oak");

const sideArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 9 }),
    x: fc.oneof(fc.constant(null), fc.integer({ min: -3, max: 3 })),
    w: wordArb,
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 6 },
);

type SideRow = { id: number; x: number | null; w: string };

async function seedSide(db: { exec(sql: string): Promise<unknown> }, table: string, rows: SideRow[]): Promise<void> {
  await db.exec(`CREATE TABLE ${table} (id int PRIMARY KEY, x int, w text)`);
  for (const row of rows) {
    const x = row.x === null ? "NULL" : `(${row.x})`;
    await db.exec(`INSERT INTO ${table} (id, x, w) VALUES (${row.id}, ${x}, '${row.w}')`);
  }
}

const joinTypeArb = fc.constantFrom("INNER", "LEFT", "RIGHT", "FULL", "CROSS");
const opArb = fc.constantFrom("=", "<", "<=", ">", ">=", "<>");
const colArb = fc.constantFrom("id", "x");

describe("join differential fuzz", () => {
  test("random two-table joins match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(sideArb, sideArb, joinTypeArb, opArb, colArb, async (left, right, joinType, op, col) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await seedSide(db, "l", left);
            await seedSide(db, "r", right);
          }

          // FULL JOIN with a non-equality predicate errors 0A000 on both engines
          // (category parity via compareOrReport), so any operator is fair game.
          const joinOp = op;
          const joinClause =
            joinType === "CROSS" ? "CROSS JOIN r" : `${joinType} JOIN r ON l.${col} ${joinOp} r.${col}`;
          const sql = [
            "SELECT l.id AS lid, l.x AS lx, l.w AS lw, r.id AS rid, r.x AS rx, r.w AS rw",
            `FROM l ${joinClause}`,
            "ORDER BY lid, rid, lx, rx, lw, rw",
          ].join(" ");
          compareOrReport(
            "join-two",
            sql,
            { left, right, joinType, op, col },
            await memory.query(sql),
            await postgres.query(sql),
          );
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 240_000);

  test("random three-table join chains match postgres", async () => {
    await fc.assert(
      fc.asyncProperty(
        sideArb,
        sideArb,
        sideArb,
        fc.constantFrom("INNER", "LEFT", "FULL"),
        fc.constantFrom("INNER", "LEFT", "RIGHT"),
        fc.constantFrom("=", "<", ">="),
        async (left, mid, right, jt1, jt2, op) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await seedSide(db, "l", left);
              await seedSide(db, "m", mid);
              await seedSide(db, "r", right);
            }

            const sql = [
              "SELECT l.id AS lid, l.x AS lx, m.id AS mid, m.x AS mx, r.id AS rid, r.x AS rx",
              `FROM l ${jt1} JOIN m ON l.x = m.x ${jt2} JOIN r ON m.x ${op} r.x`,
              "ORDER BY lid, mid, rid, lx, mx, rx",
            ].join(" ");
            compareOrReport(
              "join-three",
              sql,
              { left, mid, right, jt1, jt2, op },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 240_000);
});
