import { describe, test } from "bun:test";
import * as fc from "fast-check";
import type { SqlValue } from "../harness/types.ts";
import { fuzzAssertConfig, intArb, realArb, textArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

function num(n: number): string {
  return n < 0 ? `(${sqlLiteral(n)})` : sqlLiteral(n);
}

interface BindCase {
  value: SqlValue;
  cast: string;
}

const bindCaseArb: fc.Arbitrary<BindCase> = fc.oneof(
  fc.record({ value: intArb, cast: fc.constantFrom("int4", "int8", "numeric") }),
  fc.record({ value: realArb, cast: fc.constantFrom("float8", "numeric") }),
  fc.record({ value: textArb, cast: fc.constant("text") }),
  fc.record({ value: fc.boolean(), cast: fc.constant("bool") }),
  fc.record({ value: fc.constant(null), cast: fc.constantFrom("int4", "float8", "numeric", "text", "bool") }),
);

function inlineLiteral(value: SqlValue): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return num(value);
  return sqlLiteral(value);
}

/** Explicit cast targets that are total (error-free) for each source-value shape. */
const castCaseArb = fc.oneof(
  fc.record({
    kind: fc.constant("int" as const),
    value: intArb,
    cast: fc.constantFrom("int4", "int8", "float8", "numeric", "text", "bool"),
  }),
  fc.record({
    kind: fc.constant("real" as const),
    value: realArb,
    cast: fc.constantFrom("float8", "numeric", "text"),
  }),
  fc.record({
    kind: fc.constant("int-text" as const),
    value: intArb,
    cast: fc.constantFrom("int4", "int8", "float8", "numeric"),
  }),
  fc.record({
    kind: fc.constant("bool-text" as const),
    value: fc.constantFrom("true", "false", "t", "f", "yes", "no", "on", "off", "1", "0"),
    cast: fc.constant("bool"),
  }),
  fc.record({
    kind: fc.constant("bool" as const),
    value: fc.boolean(),
    cast: fc.constantFrom("bool", "text", "int4"),
  }),
);

function renderCastSource(c: fc.InferValue<typeof castCaseArb>): string {
  switch (c.kind) {
    case "int":
    case "real":
      return num(c.value);
    case "int-text":
      return sqlLiteral(String(c.value));
    case "bool-text":
      return sqlLiteral(c.value);
    case "bool":
      return c.value ? "TRUE" : "FALSE";
  }
}

describe("typing and bind-parameter differential fuzz", () => {
  test("bound $1 parameters agree with inlined literals", async () => {
    await fc.assert(
      fc.asyncProperty(bindCaseArb, async ({ value, cast }) => {
        const boundSql = `SELECT ($1)::${cast} AS v`;
        const inlineSql = `SELECT (${inlineLiteral(value)})::${cast} AS v`;
        await withDatabases(async (memory, postgres) => {
          const memBound = await memory.query(boundSql, [value]);
          const pgBound = await postgres.query(boundSql, [value]);
          const memInline = await memory.query(inlineSql);
          const pgInline = await postgres.query(inlineSql);
          compareOrReport("bind-mem-vs-pg", boundSql, { value, cast }, memBound, pgBound);
          compareOrReport("inline-mem-vs-pg", inlineSql, { value, cast }, memInline, pgInline);
          compareOrReport("bind-vs-inline-pg", `${boundSql} vs ${inlineSql}`, { value, cast }, pgBound, pgInline);
          compareOrReport("bind-vs-inline-mem", `${boundSql} vs ${inlineSql}`, { value, cast }, memBound, memInline);
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("random ::casts among int4/int8/float8/numeric/text/bool", async () => {
    await fc.assert(
      fc.asyncProperty(castCaseArb, castCaseArb, async (c1, c2) => {
        const sql1 = `SELECT (${renderCastSource(c1)})::${c1.cast} AS v, ((${renderCastSource(c1)})::${c1.cast})::text AS t`;
        const sql2 = `SELECT (${renderCastSource(c2)})::${c2.cast} AS v`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("cast-chain", sql1, c1, await memory.query(sql1), await postgres.query(sql1));
          compareOrReport("cast-single", sql2, c2, await memory.query(sql2), await postgres.query(sql2));
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("pg_typeof stability of random arithmetic", async () => {
    const typeArb = fc.constantFrom("int4", "int8", "float8", "numeric");
    await fc.assert(
      fc.asyncProperty(
        intArb,
        intArb,
        typeArb,
        typeArb,
        fc.constantFrom("+", "-", "*"),
        intArb,
        realArb,
        fc.constantFrom("+", "-", "*"),
        async (a, b, t1, t2, op, la, lb, litOp) => {
          const castSql = `SELECT pg_typeof((${num(a)})::${t1} ${op} (${num(b)})::${t2}) AS t`;
          const litSql = `SELECT pg_typeof(${num(la)} ${litOp} ${num(lb)}) AS t, pg_typeof(${num(la)} ${litOp} ${num(a)}) AS u`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "typeof-cast-arith",
              castSql,
              { a, b, t1, t2, op },
              await memory.query(castSql),
              await postgres.query(castSql),
            );
            compareOrReport(
              "typeof-literal-arith",
              litSql,
              { la, lb, a, litOp },
              await memory.query(litSql),
              await postgres.query(litSql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
