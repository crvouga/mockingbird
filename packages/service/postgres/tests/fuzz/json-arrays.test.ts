import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

type JsonFuzz = null | boolean | number | string | JsonFuzz[] | { [key: string]: JsonFuzz };

const keyArb = fc.constantFrom("a", "b", "c", "k1", "k2");
const jsonLeafArb: fc.Arbitrary<JsonFuzz> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  intArb,
  fc.constantFrom("x", "yy", "zed", ""),
);
const jsonInnerArb: fc.Arbitrary<JsonFuzz> = fc.oneof(
  jsonLeafArb,
  fc.array(jsonLeafArb, { maxLength: 3 }),
  fc.dictionary(keyArb, jsonLeafArb, { maxKeys: 3 }),
);
const jsonObjectArb: fc.Arbitrary<{ [key: string]: JsonFuzz }> = fc.dictionary(keyArb, jsonInnerArb, { maxKeys: 4 });
const jsonArrayArb: fc.Arbitrary<JsonFuzz[]> = fc.array(jsonInnerArb, { maxLength: 4 });

function jsonbLit(doc: JsonFuzz): string {
  return `${sqlLiteral(JSON.stringify(doc))}::jsonb`;
}

function num(n: number): string {
  return n < 0 ? `(${n})` : String(n);
}

/** Pick a deterministic subset of an object's entries using a boolean mask. */
function subsetOf(doc: { [key: string]: JsonFuzz }, mask: boolean[]): { [key: string]: JsonFuzz } {
  const out: { [key: string]: JsonFuzz } = {};
  Object.entries(doc).forEach(([key, value], index) => {
    if (mask[index % mask.length]) out[key] = value;
  });
  return out;
}

describe("json/array differential fuzz", () => {
  test("jsonb -> ->> #> extraction and jsonb_array_length", async () => {
    await fc.assert(
      fc.asyncProperty(
        jsonObjectArb,
        jsonArrayArb,
        keyArb,
        keyArb,
        fc.integer({ min: -5, max: 5 }),
        async (obj, arr, k1, k2, index) => {
          const objLit = jsonbLit(obj);
          const arrLit = jsonbLit(arr);
          const objSql =
            `SELECT (${objLit} -> '${k1}') AS a, (${objLit} ->> '${k1}') AS b, ` +
            `(${objLit} #> '{${k1},${k2}}') AS c, (${objLit} #>> '{${k1}}') AS d`;
          const arrSql =
            `SELECT (${arrLit} -> ${num(index)}) AS a, (${arrLit} ->> ${num(index)}) AS b, ` +
            `jsonb_array_length(${arrLit}) AS c, (${arrLit} #> '{0}') AS d`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "jsonb-obj",
              objSql,
              { obj, k1, k2 },
              await memory.query(objSql),
              await postgres.query(objSql),
            );
            compareOrReport(
              "jsonb-arr",
              arrSql,
              { arr, index },
              await memory.query(arrSql),
              await postgres.query(arrSql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("jsonb @> containment and || merge", async () => {
    await fc.assert(
      fc.asyncProperty(
        jsonObjectArb,
        jsonObjectArb,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        async (obj1, obj2, mask) => {
          const subset = subsetOf(obj1, mask);
          const sql =
            `SELECT (${jsonbLit(obj1)} @> ${jsonbLit(obj2)}) AS a, ` +
            `(${jsonbLit(obj1)} @> ${jsonbLit(subset)}) AS b, ` +
            `(${jsonbLit(subset)} <@ ${jsonbLit(obj1)}) AS c, ` +
            `(${jsonbLit(obj1)} || ${jsonbLit(obj2)}) AS d`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "jsonb-contain-merge",
              sql,
              { obj1, obj2, subset },
              await memory.query(sql),
              await postgres.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("jsonb compare and ORDER BY match postgres", async () => {
    const numArb = fc.oneof(
      intArb,
      fc.integer({ min: 1, max: 999999999999999 }).map((n) => `${n}.${n % 10}`),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(numArb, { minLength: 2, maxLength: 5 }), async (nums) => {
        const values = nums.map((n) => `('${n}'::jsonb)`).join(", ");
        const sql = `SELECT v FROM (VALUES ${values}) t(v) ORDER BY v`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("jsonb-order", sql, { nums }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 120_000);

  test("int arrays: subscripting, array_length, unnest, || and @>", async () => {
    const intsArb = fc.array(intArb, { minLength: 1, maxLength: 6 });
    await fc.assert(
      fc.asyncProperty(
        intsArb,
        intsArb,
        fc.integer({ min: -1, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (xs, ys, index, mask) => {
          const arr = `ARRAY[${xs.map(num).join(", ")}]`;
          const arr2 = `ARRAY[${ys.map(num).join(", ")}]`;
          const sub = xs.filter((_, i) => mask[i % mask.length]);
          const subArr = sub.length === 0 ? "ARRAY[]::int4[]" : `ARRAY[${sub.map(num).join(", ")}]`;
          const sql =
            `SELECT (${arr})[${num(index)}] AS a, array_length(${arr}, 1) AS b, ` +
            `(${arr} || ${arr2}) AS c, (${arr} @> ${subArr}) AS d, (${arr} @> ${arr2}) AS e`;
          const unnestSql = `SELECT u FROM unnest(${arr}) AS u`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport(
              "int-array-ops",
              sql,
              { xs, ys, index, sub },
              await memory.query(sql),
              await postgres.query(sql),
            );
            compareOrReport(
              "int-array-unnest",
              unnestSql,
              { xs },
              await memory.query(unnestSql),
              await postgres.query(unnestSql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("text arrays: subscripting, array_length, unnest, || and @>", async () => {
    const wordArb = fc.constantFrom("ant", "bee", "cat", "dog", "eel", "fox");
    const wordsArb = fc.array(wordArb, { minLength: 1, maxLength: 5 });
    await fc.assert(
      fc.asyncProperty(wordsArb, wordsArb, fc.integer({ min: 0, max: 6 }), async (xs, ys, index) => {
        const arr = `ARRAY[${xs.map((w) => sqlLiteral(w)).join(", ")}]`;
        const arr2 = `ARRAY[${ys.map((w) => sqlLiteral(w)).join(", ")}]`;
        const sql =
          `SELECT (${arr})[${index}] AS a, array_length(${arr}, 1) AS b, ` +
          `(${arr} || ${arr2}) AS c, (${arr} @> ${arr2}) AS d`;
        const unnestSql = `SELECT u FROM unnest(${arr}) AS u`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("text-array-ops", sql, { xs, ys, index }, await memory.query(sql), await postgres.query(sql));
          compareOrReport(
            "text-array-unnest",
            unnestSql,
            { xs },
            await memory.query(unnestSql),
            await postgres.query(unnestSql),
          );
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);
});
