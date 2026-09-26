import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

type JsonFuzz = null | boolean | number | string | JsonFuzz[] | { [k: string]: JsonFuzz };

const jsonLeaf: fc.Arbitrary<JsonFuzz> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  intArb,
  textArb.filter((s) => !s.includes("\\") && !s.includes('"') && s.length <= 12),
);

const jsonValue: fc.Arbitrary<JsonFuzz> = fc.oneof(
  jsonLeaf,
  fc.array(jsonLeaf, { maxLength: 3 }),
  fc.dictionary(fc.constantFrom("a", "b", "c"), jsonLeaf, { maxKeys: 3 }),
  fc.array(fc.dictionary(fc.constantFrom("a", "b"), jsonLeaf, { maxKeys: 2 }), { maxLength: 2 }),
);

function toJsonText(value: JsonFuzz): string {
  return JSON.stringify(value);
}

const pathArb = fc.constantFrom("$", "$[0]", "$[#-1]", "$.a", "$.b");

const opArb = fc.oneof(
  fc.record({ kind: fc.constant("json" as const) }),
  fc.record({ kind: fc.constant("type" as const) }),
  fc.record({ kind: fc.constant("valid" as const) }),
  fc.record({ kind: fc.constant("array_length" as const) }),
  fc.record({ kind: fc.constant("extract" as const), path: pathArb }),
  fc.record({ kind: fc.constant("arrow" as const), path: pathArb, mode: fc.constantFrom("->", "->>") }),
  fc.record({ kind: fc.constant("each" as const) }),
  fc.record({
    kind: fc.constant("set" as const),
    path: fc.constantFrom("$.z", "$[#]"),
    value: intArb,
  }),
);

function buildSql(json: JsonFuzz, op: fc.InferValue<typeof opArb>): string {
  const lit = sqlLiteral(toJsonText(json));
  switch (op.kind) {
    case "json":
      return `SELECT json(${lit}) AS v`;
    case "type":
      return `SELECT json_type(${lit}) AS v`;
    case "valid":
      return `SELECT json_valid(${lit}) AS v`;
    case "array_length":
      return `SELECT json_array_length(${lit}) AS v`;
    case "extract":
      return `SELECT json_extract(${lit}, ${sqlLiteral(op.path)}) AS v`;
    case "arrow":
      return `SELECT (${lit} ${op.mode} ${sqlLiteral(op.path)}) AS v`;
    case "each":
      return `SELECT key, type, id FROM json_each(${lit}) ORDER BY id`;
    case "set":
      return `SELECT json_set(${lit}, ${sqlLiteral(op.path)}, ${sqlLiteral(op.value)}) AS v`;
  }
}

describe("json differential fuzz", () => {
  test("random json ops match SQLite", () => {
    fc.assert(
      fc.property(jsonValue, opArb, (json, op) => {
        const sql = buildSql(json, op);
        withDatabases((memory, sqlite) => {
          compareOrReport("json", sql, { json, op }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  });

  test("random JSON subtype-preserving chains match SQLite", () => {
    fc.assert(
      fc.property(jsonValue, fc.constantFrom("array", "object", "set"), (value, chain) => {
        const literal = sqlLiteral(toJsonText(value));
        const sql =
          chain === "array"
            ? `SELECT json_array(json_extract(json(${literal}), '$')) AS v`
            : chain === "object"
              ? `SELECT json_object('v', json(${literal})) AS v`
              : `SELECT json(json_set('{}', '$.v', json(${literal}))) AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("json-subtype-chain", sql, { value, chain }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  });

  test("json_tree and NULL TVF / FILTER edges match SQLite", () => {
    fc.assert(
      fc.property(jsonValue, (json) => {
        withDatabases((memory, sqlite) => {
          const lit = sqlLiteral(toJsonText(json));
          const tree = `SELECT id, type, key FROM json_tree(${lit}) ORDER BY id`;
          compareOrReport("json-tree", tree, { json }, memory.query(tree), sqlite.query(tree));

          const eachNull = "SELECT count(*) AS n FROM json_each(NULL)";
          compareOrReport("json-each-null", eachNull, {}, memory.query(eachNull), sqlite.query(eachNull));

          const setup = "CREATE TABLE t(j TEXT)";
          memory.exec(setup);
          sqlite.exec(setup);
          memory.exec(`INSERT INTO t VALUES (${lit}), (NULL)`);
          sqlite.exec(`INSERT INTO t VALUES (${lit}), (NULL)`);
          const agg = "SELECT json_group_array(j) FILTER (WHERE j IS NOT NULL) AS v FROM t";
          compareOrReport("json-agg-filter", agg, { json }, memory.query(agg), sqlite.query(agg));
        });
      }),
      fuzzAssertConfig(25),
    );
  });
});
