import { Database as BunDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { parity } from "../helpers.ts";

parity("jsonb hex encoding array", [], `SELECT hex(jsonb('[1,2]'))`);
parity("jsonb hex null true false", [], `SELECT hex(jsonb('null')), hex(jsonb('true')), hex(jsonb('false'))`);
parity("jsonb hex empty", [], `SELECT hex(jsonb('[]')), hex(jsonb('{}'))`);
parity("jsonb typeof", [], `SELECT typeof(jsonb('[1]')), typeof(json('[1]'))`);
parity("json roundtrip jsonb", [], `SELECT json(jsonb('{"a":[1,2,true]}'))`);
parity("jsonb_array", [], `SELECT hex(jsonb_array(1, 2))`);
parity("jsonb_object", [], `SELECT json(jsonb_object('a', 1, 'b', json('[2]')))`);
parity(
  "jsonb_extract array",
  [],
  `SELECT typeof(jsonb_extract('{"a":[1,2]}', '$.a')), json(jsonb_extract('{"a":[1,2]}', '$.a'))`,
);
parity("jsonb_extract scalar", [], `SELECT jsonb_extract('{"a":1}', '$.a')`);
parity("jsonb_set", [], `SELECT json(jsonb_set(jsonb('{"a":1}'), '$.b', 2))`);
parity("jsonb_insert", [], `SELECT json(jsonb_insert('[1,2]', '$[#]', 3))`);
parity("jsonb_remove", [], `SELECT json(jsonb_remove('{"a":1,"b":2}', '$.a'))`);
parity("jsonb_patch", [], `SELECT json(jsonb_patch('{"a":1}', '{"b":2}'))`);
parity(
  "jsonb_group_array",
  ["CREATE TABLE t(v)", "INSERT INTO t VALUES (1), (2)"],
  `SELECT json(jsonb_group_array(v)) FROM t`,
);

test("jsonb_array_insert roundtrips through json()", () => {
  const db = new InMemoryAdapter();
  try {
    const result = db.query(`SELECT json(jsonb_array_insert('[1,2,3]','$[1]','new')) AS v`);
    expect(result.ok).toBe(true);
    expect(String(result.rows[0]!.v)).toBe('[1,"new",2,3]');
  } finally {
    db.close();
  }
});

{
  const oracle = new BunDatabase(":memory:");
  const hasArrayInsert =
    oracle.prepare("select 1 as ok from pragma_function_list() where name = 'jsonb_array_insert' limit 1").get() !=
    null;
  oracle.close();
  if (hasArrayInsert) {
    parity("jsonb_array_insert", [], `SELECT json(jsonb_array_insert('[1,2,3]', '$[1]', 'new')) AS v`);
  }
}
