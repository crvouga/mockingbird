import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

/** Typed rendering: bare NULL adopts different types in memory vs oracle, so always cast NULL. */
function intVal(v: number | null): string {
  if (v === null) return "NULL::int4";
  return v < 0 ? `(${v})` : String(v);
}

function textVal(v: string | null): string {
  return v === null ? "NULL::text" : sqlLiteral(v);
}

const intOrNullArb = fc.oneof(fc.constant(null), intArb);
const wordArb = fc.constantFrom("alpha", "beta", "gamma", "delta", "", "zeta");
const textOrNullArb = fc.oneof(fc.constant(null), wordArb);

type BoolExpr =
  | { kind: "leaf"; a: number | null; op: string; b: number | null }
  | { kind: "not"; inner: BoolExpr }
  | { kind: "bin"; op: "AND" | "OR"; left: BoolExpr; right: BoolExpr };

const boolExprArb: fc.Arbitrary<BoolExpr> = fc.letrec<{ expr: BoolExpr }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.record({
      kind: fc.constant("leaf" as const),
      a: intOrNullArb,
      op: fc.constantFrom("=", "<>", "<", "<=", ">", ">="),
      b: intOrNullArb,
    }),
    fc.record({ kind: fc.constant("not" as const), inner: tie("expr") }),
    fc.record({
      kind: fc.constant("bin" as const),
      op: fc.constantFrom("AND" as const, "OR" as const),
      left: tie("expr"),
      right: tie("expr"),
    }),
  ),
})).expr;

function renderBool(e: BoolExpr): string {
  switch (e.kind) {
    case "leaf":
      return `(${intVal(e.a)} ${e.op} ${intVal(e.b)})`;
    case "not":
      return `(NOT ${renderBool(e.inner)})`;
    case "bin":
      return `(${renderBool(e.left)} ${e.op} ${renderBool(e.right)})`;
  }
}

describe("expression differential fuzz", () => {
  test("random AND/OR/NOT predicate trees", async () => {
    await fc.assert(
      fc.asyncProperty(boolExprArb, async (expr) => {
        const sql = `SELECT ${renderBool(expr)} AS v`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("bool-tree", sql, expr, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  }, 120_000);

  test("random CASE expressions (searched and simple)", async () => {
    await fc.assert(
      fc.asyncProperty(
        intArb,
        intArb,
        intArb,
        intOrNullArb,
        intOrNullArb,
        intOrNullArb,
        fc.constantFrom("=", "<", ">"),
        fc.boolean(),
        async (x, w1, w2, r1, r2, relse, op, withElse) => {
          // All branches share one type (int) — mixed-type CASE resolution is a known divergence.
          const elseClause = withElse ? ` ELSE ${intVal(relse)}` : "";
          const searched =
            `SELECT CASE WHEN ${intVal(x)} ${op} ${intVal(w1)} THEN ${intVal(r1)} ` +
            `WHEN ${intVal(x)} ${op} ${intVal(w2)} THEN ${intVal(r2)}${elseClause} END AS v`;
          const simple =
            `SELECT CASE ${intVal(x)} WHEN ${intVal(w1)} THEN ${intVal(r1)} ` +
            `WHEN ${intVal(w2)} THEN ${intVal(r2)}${elseClause} END AS v`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "case-searched",
              searched,
              { x, w1, w2, r1, r2, relse, op, withElse },
              await memory.query(searched),
              await postgres.query(searched),
            );
            compareOrReport(
              "case-simple",
              simple,
              { x, w1, w2, r1, r2, relse, withElse },
              await memory.query(simple),
              await postgres.query(simple),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("COALESCE/NULLIF/GREATEST/LEAST over same-type mixed values", async () => {
    const intArgsArb = fc.array(intOrNullArb, { minLength: 2, maxLength: 4 });
    const textArgsArb = fc.array(textOrNullArb, { minLength: 2, maxLength: 4 });
    await fc.assert(
      fc.asyncProperty(
        intArgsArb,
        textArgsArb,
        intOrNullArb,
        intOrNullArb,
        textOrNullArb,
        textOrNullArb,
        async (ints, texts, na, nb, ta, tb) => {
          const intArgs = ints.map(intVal).join(", ");
          const textArgs = texts.map(textVal).join(", ");
          const sql =
            `SELECT coalesce(${intArgs}) AS c1, coalesce(${textArgs}) AS c2, ` +
            `nullif(${intVal(na)}, ${intVal(nb)}) AS n1, nullif(${textVal(ta)}, ${textVal(tb)}) AS n2, ` +
            `greatest(${intArgs}) AS g1, least(${intArgs}) AS l1, ` +
            `greatest(${textArgs}) AS g2, least(${textArgs}) AS l2`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "conditional-fns",
              sql,
              { ints, texts, na, nb, ta, tb },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("IS [NOT] DISTINCT FROM, BETWEEN, and IN lists with NULLs", async () => {
    const inListArb = fc.array(intOrNullArb, { minLength: 1, maxLength: 5 });
    await fc.assert(
      fc.asyncProperty(
        intOrNullArb,
        intOrNullArb,
        textOrNullArb,
        textOrNullArb,
        intOrNullArb,
        intArb,
        intArb,
        fc.boolean(),
        inListArb,
        async (a, b, s1, s2, x, lo, hi, symmetric, list) => {
          const distinctSql =
            `SELECT (${intVal(a)} IS DISTINCT FROM ${intVal(b)}) AS d1, ` +
            `(${intVal(a)} IS NOT DISTINCT FROM ${intVal(b)}) AS d2, ` +
            `(${textVal(s1)} IS DISTINCT FROM ${textVal(s2)}) AS d3, ` +
            `(${textVal(s1)} IS NOT DISTINCT FROM ${textVal(s2)}) AS d4`;
          const betweenKw = symmetric ? "BETWEEN SYMMETRIC" : "BETWEEN";
          const betweenSql =
            `SELECT (${intVal(x)} ${betweenKw} ${intVal(lo)} AND ${intVal(hi)}) AS b1, ` +
            `(${intVal(x)} NOT ${betweenKw} ${intVal(lo)} AND ${intVal(hi)}) AS b2`;
          const inList = list.map(intVal).join(", ");
          const inSql = `SELECT (${intVal(x)} IN (${inList})) AS i1, (${intVal(x)} NOT IN (${inList})) AS i2`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "is-distinct",
              distinctSql,
              { a, b, s1, s2 },
              await memory.query(distinctSql),
              await postgres.query(distinctSql),
            );
            compareOrReport(
              "between",
              betweenSql,
              { x, lo, hi, symmetric },
              await memory.query(betweenSql),
              await postgres.query(betweenSql),
            );
            compareOrReport("in-list", inSql, { x, list }, await memory.query(inSql), await postgres.query(inSql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
