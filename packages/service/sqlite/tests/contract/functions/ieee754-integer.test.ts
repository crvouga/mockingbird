import { Database as BunDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

// Captured against bun:sqlite 3.54.0 on macOS, Bun 1.4.0. Older platform
// oracles lack these functions; the captured assertions still run there.
const cases: Array<[string, string | null, string]> = [
  ["ieee754_to_int(1.0)", "4607182418800017408", "integer"],
  ["ieee754_to_int(-1.5)", "-4613937818241073152", "integer"],
  ["ieee754_to_int(0.0)", "0", "integer"],
  ["ieee754_to_int(5e-324)", "1", "integer"],
  ["ieee754_from_int(4607182418800017408)", "1.0", "real"],
  ["ieee754_from_int(0)", "0.0", "real"],
  ["ieee754_from_int(-9223372036854775808)", "0.0", "real"],
  ["ieee754_from_int(9218868437227405312)", "Inf", "real"],
  ["ieee754_from_int(-4503599627370496)", "-Inf", "real"],
  ["ieee754_from_int(-1)", null, "null"],
  ["ieee754_from_int(9223372036854775807)", null, "null"],
];
for (const input of ["NULL", "'1'", "'abc'", "X'00'"]) {
  cases.push([`ieee754_to_int(${input})`, null, "null"], [`ieee754_from_int(${input})`, null, "null"]);
}
cases.push(["ieee754_to_int(1)", null, "null"], ["ieee754_from_int(1.0)", null, "null"]);

test("IEEE754 integer bit casts preserve signed bits and require exact storage classes", () => {
  const memory = new Database();
  const oracle = new BunDatabase(":memory:");
  const hasBitCasts = oracle
    .query("SELECT count(*) AS n FROM pragma_function_list WHERE name='ieee754_to_int'")
    .get() as { n: number };
  try {
    for (const [expression, value, type] of cases) {
      const sql = `SELECT CAST(${expression} AS TEXT) AS value, typeof(${expression}) AS type`;
      expect(memory.prepare(sql).get()).toEqual({ value, type });
      if (hasBitCasts.n) expect(memory.prepare(sql).get()).toEqual(oracle.query(sql).get());
    }
    for (const name of ["ieee754_from_int", "ieee754_to_int"]) {
      for (const args of ["", "1,2"]) {
        expect(() => memory.prepare(`SELECT ${name}(${args})`).get()).toThrow(
          `wrong number of arguments to function ${name}()`,
        );
        if (hasBitCasts.n)
          expect(() => oracle.query(`SELECT ${name}(${args})`).get()).toThrow(
            `wrong number of arguments to function ${name}()`,
          );
      }
    }
  } finally {
    memory.close();
    oracle.close();
  }
});
