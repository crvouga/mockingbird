import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, textArb } from "../config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "../helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: fc.oneof(nullArb, intArb),
  b: fc.oneof(
    nullArb,
    textArb.filter((s) => s.length <= 12),
  ),
});

type Row = fc.InferValue<typeof rowArb>;

const predicateArb = fc.oneof(
  fc.record({ kind: fc.constant("gt" as const), n: intArb }),
  fc.record({ kind: fc.constant("lt" as const), n: intArb }),
  fc.record({ kind: fc.constant("eq" as const), n: intArb }),
  fc.record({ kind: fc.constant("isnull" as const) }),
  fc.record({ kind: fc.constant("like" as const), p: fc.constantFrom("%", "a%", "%z", "_", "%b%") }),
  fc.record({ kind: fc.constant("numgt" as const), n: intArb }),
);

type Predicate = fc.InferValue<typeof predicateArb>;

/** Boolean predicate over columns `a` (int) / `b` (text), optionally qualified. */
function predicateSql(pred: Predicate, prefix = ""): string {
  const a = `${prefix}a`;
  const b = `${prefix}b`;
  if (pred.kind === "gt") return `${a} > ${pred.n}`;
  if (pred.kind === "lt") return `${a} < ${pred.n}`;
  if (pred.kind === "eq") return `${a} = ${pred.n}`;
  if (pred.kind === "isnull") return `${a} IS NULL`;
  if (pred.kind === "numgt") return `${a}::numeric > ${pred.n}::numeric`;
  return `${b} LIKE ${sqlLiteral(pred.p)}`;
}

function insertSql(table: string, rows: Row[]): string {
  const tuples = rows.map((r) => `(${r.id}, ${sqlLiteral(r.a)}, ${sqlLiteral(r.b)})`).join(", ");
  return `INSERT INTO ${table} VALUES ${tuples}`;
}

async function seed(dbs: { exec(sql: string): Promise<{ ok: boolean }> }[], table: string, rows: Row[]): Promise<void> {
  for (const db of dbs) {
    const created = await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY, a int, b text)`);
    if (!created.ok) throw new Error(`seed: CREATE TABLE ${table} failed`);
    if (rows.length > 0) {
      const inserted = await db.exec(insertSql(table, rows));
      if (!inserted.ok) throw new Error(`seed: INSERT INTO ${table} failed`);
    }
  }
}

/**
 * Ternary Logic Partitioning (SQLancer-style):
 * |Q| = |Q WHERE P| + |Q WHERE NOT P| + |Q WHERE (P) IS NULL|
 * on both engines, and each partition's rows must match across engines.
 */
describe("TLP metamorphic fuzz", () => {
  test("single-table partition counts sum to full scan on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        async (rows, pred) => {
          const p = predicateSql(pred);
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "t", rows);

            const full = "SELECT id, a, b FROM t ORDER BY id";
            const partTrue = `SELECT id, a, b FROM t WHERE (${p}) ORDER BY id`;
            const partFalse = `SELECT id, a, b FROM t WHERE NOT (${p}) ORDER BY id`;
            const partNull = `SELECT id, a, b FROM t WHERE (${p}) IS NULL ORDER BY id`;

            const counts = { memory: 0, postgres: 0 };
            for (const [label, sql, sign] of [
              ["full", full, -1],
              ["true", partTrue, 1],
              ["false", partFalse, 1],
              ["null", partNull, 1],
            ] as const) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`tlp-${label}`, sql, { rows, pred }, memRes, pgRes);
              counts.memory += sign * memRes.values.length;
              counts.postgres += sign * pgRes.values.length;
            }
            for (const [engine, delta] of Object.entries(counts)) {
              if (delta !== 0) {
                throw new Error(`TLP cardinality broken on ${engine}: partitions - full = ${delta}, pred=${p}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  }, 120_000);

  test("two-table INNER JOIN partitions match on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        predicateArb,
        async (left, right, pred) => {
          const p = predicateSql(pred, "l.");
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "l", left);
            await seed([memory, postgres], "r", right);

            const base = "SELECT l.id AS lid, r.id AS rid, l.a, r.b FROM l INNER JOIN r ON l.id = r.id";
            const order = "ORDER BY lid, rid";
            const full = `${base} ${order}`;
            const partTrue = `${base} WHERE (${p}) ${order}`;
            const partFalse = `${base} WHERE NOT (${p}) ${order}`;
            const partNull = `${base} WHERE (${p}) IS NULL ${order}`;

            const counts = { memory: 0, postgres: 0 };
            for (const [label, sql, sign] of [
              ["full", full, -1],
              ["true", partTrue, 1],
              ["false", partFalse, 1],
              ["null", partNull, 1],
            ] as const) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`tlp-join-${label}`, sql, { left, right, pred }, memRes, pgRes);
              counts.memory += sign * memRes.values.length;
              counts.postgres += sign * pgRes.values.length;
            }
            for (const [engine, delta] of Object.entries(counts)) {
              if (delta !== 0) {
                throw new Error(`join TLP cardinality broken on ${engine}: partitions - full = ${delta}, pred=${p}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(10),
    );
  }, 120_000);

  test("aggregate partition sums add up to the total on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        async (rows, pred) => {
          const p = predicateSql(pred);
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "t", rows);

            const total = "SELECT sum(a) AS s FROM t";
            const partTrue = `SELECT sum(a) AS s FROM t WHERE (${p})`;
            const partFalse = `SELECT sum(a) AS s FROM t WHERE NOT (${p})`;
            const partNull = `SELECT sum(a) AS s FROM t WHERE (${p}) IS NULL`;

            const sums = { memory: 0, postgres: 0 };
            for (const [label, sql, sign] of [
              ["total", total, -1],
              ["true", partTrue, 1],
              ["false", partFalse, 1],
              ["null", partNull, 1],
            ] as const) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`tlp-agg-${label}`, sql, { rows, pred }, memRes, pgRes);
              sums.memory += sign * Number(memRes.values[0]?.[0] ?? "0");
              sums.postgres += sign * Number(pgRes.values[0]?.[0] ?? "0");
            }
            for (const [engine, delta] of Object.entries(sums)) {
              if (delta !== 0) {
                throw new Error(`aggregate TLP broken on ${engine}: partition sums - total = ${delta}, pred=${p}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);

  test("FULL OUTER JOIN partitions match on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 8 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 8 }),
        predicateArb,
        async (left, right, pred) => {
          const p = predicateSql(pred, "l.");
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "l", left);
            await seed([memory, postgres], "r", right);

            const base = "SELECT l.id AS lid, r.id AS rid FROM l FULL OUTER JOIN r ON l.a = r.a";
            const order = "ORDER BY lid, rid";
            const full = `${base} ${order}`;
            const partTrue = `${base} WHERE (${p}) ${order}`;
            const partFalse = `${base} WHERE NOT (${p}) ${order}`;
            const partNull = `${base} WHERE (${p}) IS NULL ${order}`;

            const counts = { memory: 0, postgres: 0 };
            for (const [label, sql, sign] of [
              ["full", full, -1],
              ["true", partTrue, 1],
              ["false", partFalse, 1],
              ["null", partNull, 1],
            ] as const) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`tlp-full-${label}`, sql, { left, right, pred }, memRes, pgRes);
              counts.memory += sign * memRes.values.length;
              counts.postgres += sign * pgRes.values.length;
            }
            for (const [engine, delta] of Object.entries(counts)) {
              if (delta !== 0) throw new Error(`full outer TLP broken on ${engine}: delta=${delta}`);
            }
          });
        },
      ),
      fuzzAssertConfig(10),
    );
  }, 120_000);

  test("three-table INNER JOIN chain partitions match on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        predicateArb,
        async (aRows, bRows, cRows, pred) => {
          const p = predicateSql(pred, "a.");
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "a", aRows);
            await seed([memory, postgres], "b", bRows);
            await seed([memory, postgres], "c", cRows);

            const base =
              "SELECT a.id AS aid, b.id AS bid, c.id AS cid FROM a INNER JOIN b ON a.id = b.id INNER JOIN c ON b.id = c.id";
            const order = "ORDER BY aid, bid, cid";
            const full = `${base} ${order}`;
            const partTrue = `${base} WHERE (${p}) ${order}`;
            const partFalse = `${base} WHERE NOT (${p}) ${order}`;
            const partNull = `${base} WHERE (${p}) IS NULL ${order}`;

            const counts = { memory: 0, postgres: 0 };
            for (const [label, sql, sign] of [
              ["full", full, -1],
              ["true", partTrue, 1],
              ["false", partFalse, 1],
              ["null", partNull, 1],
            ] as const) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`tlp-3join-${label}`, sql, { aRows, bRows, cRows, pred }, memRes, pgRes);
              counts.memory += sign * memRes.values.length;
              counts.postgres += sign * pgRes.values.length;
            }
            for (const [engine, delta] of Object.entries(counts)) {
              if (delta !== 0) throw new Error(`3-join TLP broken on ${engine}: delta=${delta}`);
            }
          });
        },
      ),
      fuzzAssertConfig(8),
    );
  }, 120_000);

  test("DISTINCT count partition (DQP) matches on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 15 }),
        predicateArb,
        async (rows, pred) => {
          const p = predicateSql(pred);
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "t", rows);

            const queries = [
              ["full", "SELECT count(DISTINCT a) AS c FROM t"],
              ["true", `SELECT count(DISTINCT a) AS c FROM t WHERE (${p})`],
              ["false", `SELECT count(DISTINCT a) AS c FROM t WHERE NOT (${p})`],
              ["null", `SELECT count(DISTINCT a) AS c FROM t WHERE (${p}) IS NULL`],
            ] as const;
            for (const [label, sql] of queries) {
              compareOrReport(`dqp-${label}`, sql, { rows, pred }, await memory.query(sql), await postgres.query(sql));
            }
          });
        },
      ),
      fuzzAssertConfig(10),
    );
  }, 120_000);

  test("IN subquery vs INNER JOIN rewrite yields same ids on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        intArb,
        async (left, right, threshold) => {
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "l", left);
            await seed([memory, postgres], "r", right);

            const inSql = `SELECT l.id FROM l WHERE l.a IN (SELECT r.a FROM r WHERE r.a > ${threshold}) ORDER BY 1`;
            const joinSql = `SELECT DISTINCT l.id FROM l INNER JOIN r ON l.a = r.a WHERE r.a > ${threshold} ORDER BY 1`;
            const memIn = await memory.query(inSql);
            const pgIn = await postgres.query(inSql);
            const memJoin = await memory.query(joinSql);
            const pgJoin = await postgres.query(joinSql);
            compareOrReport("in-vs-join-in", inSql, { left, right, threshold }, memIn, pgIn);
            compareOrReport("in-vs-join-join", joinSql, { left, right, threshold }, memJoin, pgJoin);
            if (JSON.stringify(memIn.values) !== JSON.stringify(memJoin.values)) {
              throw new Error("memory IN vs JOIN mismatch");
            }
            if (JSON.stringify(pgIn.values) !== JSON.stringify(pgJoin.values)) {
              throw new Error("postgres IN vs JOIN mismatch");
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);
});
