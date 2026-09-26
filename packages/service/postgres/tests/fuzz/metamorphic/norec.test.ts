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
  fc.record({ kind: fc.constant("notnull" as const) }),
  fc.record({ kind: fc.constant("like" as const), p: fc.constantFrom("%", "a%", "%z", "_", "%b%") }),
  fc.record({ kind: fc.constant("numgt" as const), n: intArb }),
  fc.record({ kind: fc.constant("extract" as const), part: fc.constantFrom("month", "day", "hour") }),
);

type Predicate = fc.InferValue<typeof predicateArb>;

function predicateSql(pred: Predicate, prefix = ""): string {
  const a = `${prefix}a`;
  const b = `${prefix}b`;
  if (pred.kind === "gt") return `${a} > ${pred.n}`;
  if (pred.kind === "lt") return `${a} < ${pred.n}`;
  if (pred.kind === "eq") return `${a} = ${pred.n}`;
  if (pred.kind === "isnull") return `${a} IS NULL`;
  if (pred.kind === "notnull") return `${a} IS NOT NULL`;
  if (pred.kind === "numgt") return `${a}::numeric > ${pred.n}::numeric`;
  if (pred.kind === "extract")
    return `EXTRACT(${pred.part} FROM timestamp '2020-05-15 14:30:00') >= 0 AND ${a} IS NOT NULL`;
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
 * NoREC: the optimized filtered count must equal the non-optimized rewrite
 * that projects the predicate as a boolean and sums it, on both engines.
 */
describe("NoREC metamorphic fuzz", () => {
  test("WHERE count matches boolean-sum rewrite on both engines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        async (rows, pred) => {
          const p = predicateSql(pred);
          await withDatabases(async (memory, postgres) => {
            await seed([memory, postgres], "t", rows);

            const optimized = `SELECT count(*) AS n FROM t WHERE (${p})`;
            const rewrite = `SELECT coalesce(sum((${p})::int), 0) AS n FROM t`;

            const perEngine = { memory: [0, 0], postgres: [0, 0] };
            for (const [index, sql] of [optimized, rewrite].entries()) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(`norec-${index === 0 ? "opt" : "rewrite"}`, sql, { rows, pred }, memRes, pgRes);
              perEngine.memory[index] = Number(memRes.values[0]?.[0] ?? "-1");
              perEngine.postgres[index] = Number(pgRes.values[0]?.[0] ?? "-1");
            }
            for (const [engine, [opt, rewritten]] of Object.entries(perEngine)) {
              if (opt !== rewritten) {
                throw new Error(`NoREC mismatch on ${engine}: count=${opt} sum=${rewritten} pred=${p}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(18),
    );
  }, 120_000);

  test("join WHERE count matches boolean-sum rewrite on both engines", async () => {
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

            const join = "FROM l INNER JOIN r ON l.id = r.id";
            const optimized = `SELECT count(*) AS n ${join} WHERE (${p})`;
            const rewrite = `SELECT coalesce(sum((${p})::int), 0) AS n ${join}`;

            const perEngine = { memory: [0, 0], postgres: [0, 0] };
            for (const [index, sql] of [optimized, rewrite].entries()) {
              const memRes = await memory.query(sql);
              const pgRes = await postgres.query(sql);
              compareOrReport(
                `norec-join-${index === 0 ? "opt" : "rewrite"}`,
                sql,
                { left, right, pred },
                memRes,
                pgRes,
              );
              perEngine.memory[index] = Number(memRes.values[0]?.[0] ?? "-1");
              perEngine.postgres[index] = Number(pgRes.values[0]?.[0] ?? "-1");
            }
            for (const [engine, [opt, rewritten]] of Object.entries(perEngine)) {
              if (opt !== rewritten) {
                throw new Error(`join NoREC mismatch on ${engine}: count=${opt} sum=${rewritten} pred=${p}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);
});
