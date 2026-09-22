import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, compareWriteOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

/**
 * Random feature-combination fuzz: compose 2-3 orthogonal query features
 * (DISTINCT, GROUP BY, HAVING, window function, CTE wrapper, set operation
 * with itself, LIMIT/OFFSET) into one always-valid query over a seeded table
 * and compare the results across engines. A total ORDER BY keeps row order
 * (and therefore LIMIT windows) deterministic. DISTINCT ON is intentionally
 * excluded (known ordering-enforcement divergence).
 */

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 60 }),
  g: fc.integer({ min: 0, max: 4 }),
  v: fc.integer({ min: -50, max: 50 }),
  s: fc.constantFrom("a", "ab", "b", "ba", "zz", "q7", "x", "mm"),
});

const comboArb = fc
  .record({
    core: fc.constantFrom("plain" as const, "distinct" as const, "group" as const, "window" as const),
    having: fc.boolean(),
    havingMin: fc.integer({ min: 1, max: 3 }),
    setop: fc.constantFrom(
      "none" as const,
      "UNION ALL" as const,
      "UNION" as const,
      "INTERSECT" as const,
      "EXCEPT" as const,
    ),
    cte: fc.boolean(),
    limit: fc.option(fc.record({ n: fc.integer({ min: 0, max: 8 }), off: fc.integer({ min: 0, max: 4 }) }), {
      nil: null,
    }),
  })
  .filter((c) => {
    const n = featureCount(c);
    return n >= 2 && n <= 3;
  });

type Combo = fc.InferValue<typeof comboArb>;

function featureCount(c: Combo): number {
  return (
    (c.core === "plain" ? 0 : 1) +
    (c.core === "group" && c.having ? 1 : 0) +
    (c.setop === "none" ? 0 : 1) +
    (c.cte ? 1 : 0) +
    (c.limit === null ? 0 : 1)
  );
}

function buildQuery(c: Combo): string {
  let inner: string;
  let cols: string[];
  switch (c.core) {
    case "plain":
      inner = "SELECT id, g, v, s FROM t";
      cols = ["id", "g", "v", "s"];
      break;
    case "distinct":
      inner = "SELECT DISTINCT g, v FROM t";
      cols = ["g", "v"];
      break;
    case "group":
      inner = "SELECT g, count(*) AS c, sum(v) AS sv FROM t GROUP BY g";
      if (c.having) inner += ` HAVING count(*) >= ${c.havingMin}`;
      cols = ["g", "c", "sv"];
      break;
    case "window":
      inner = "SELECT id, g, v, sum(v) OVER (PARTITION BY g ORDER BY id) AS w FROM t";
      cols = ["id", "g", "v", "w"];
      break;
  }

  const combined = c.setop === "none" ? inner : `${inner} ${c.setop} ${inner}`;
  const colList = cols.join(", ");
  let sql = c.cte
    ? `WITH q AS (${combined}) SELECT ${colList} FROM q ORDER BY ${colList}`
    : `SELECT ${colList} FROM (${combined}) AS q ORDER BY ${colList}`;
  if (c.limit !== null) sql += ` LIMIT ${c.limit.n} OFFSET ${c.limit.off}`;
  return sql;
}

describe("feature-combination differential fuzz", () => {
  test("composed 2-3 feature queries match across engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 15 }),
        comboArb,
        async (rows, combo) => {
          const sql = buildQuery(combo);
          await withDatabases(async (memory, postgres) => {
            const create = "CREATE TABLE t(id int PRIMARY KEY, g int NOT NULL, v int NOT NULL, s text NOT NULL)";
            for (const db of [memory, postgres]) {
              const created = await db.exec(create);
              if (!created.ok) throw new Error("combo seed: CREATE TABLE failed");
            }
            const tuples = rows.map((r) => `(${r.id}, ${r.g}, ${r.v}, ${sqlLiteral(r.s)})`).join(", ");
            const insert = `INSERT INTO t VALUES ${tuples}`;
            compareWriteOrReport("combo-seed", insert, rows, await memory.exec(insert), await postgres.exec(insert));

            compareOrReport("combo-query", sql, { rows, combo }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 120_000);
});
