import { JSN_SECTION } from "../../../compat/sections/jsn.ts";
import { runCatalog } from "./run.ts";

runCatalog(JSN_SECTION, [
  { id: "JSN-rt-01", kind: "parity", sql: `SELECT '{"b":1,"a":2}'::jsonb AS v` },
  { id: "JSN-rt-02", kind: "parity", sql: `SELECT '{"a":1,"a":2}'::jsonb AS v` },
  {
    id: "JSN-rt-03",
    kind: "parity",
    sql: `SELECT '{"b":1,"a":2,"b":3}'::json AS dup, '{"a": 1,  "b":2}'::json::text AS j, '{"a": 1,  "b":2}'::jsonb::text AS jb`,
  },
  { id: "JSN-rt-04", kind: "parity", sql: `SELECT ('{"a": 1}'::jsonb)::text AS v` },
  {
    id: "JSN-rt-05",
    kind: "parity",
    sql:
      `SELECT '1.50'::jsonb::text AS a, '1e2'::jsonb::text AS b, ` +
      `'100000000000000000000000'::jsonb::text AS big, '0.1e-3'::jsonb::text AS small`,
  },
  {
    id: "JSN-rt-06",
    kind: "parity",
    sql: `SELECT ('{"b":1,"a":2,"b":3}'::json)::jsonb AS j2jb, ('{"b":1,"a":2}'::jsonb)::json AS jb2j`,
  },
  {
    id: "JSN-rt-07",
    kind: "parity",
    sql: `SELECT '"hello"'::jsonb AS s, 'null'::jsonb IS NULL AS sql_null, jsonb_typeof('null'::jsonb) AS ty`,
  },
  {
    id: "JSN-rt-08",
    kind: "parity",
    sql: `SELECT '{"a":[{"b":[1,2]},{"c":null}]}'::jsonb AS nested, '["a\\u0041b"]'::jsonb ->> 0 AS decoded`,
  },
  {
    id: "JSN-rt-09",
    kind: "parity",
    setup: ["CREATE TABLE docs (id int, body jsonb)", `INSERT INTO docs VALUES (1, '{"z":1,"a":{"n":[3,2,1]}}')`],
    sql: "SELECT body FROM docs",
  },
  {
    id: "JSN-op-01",
    kind: "parity",
    sql: `SELECT '{"a":{"b":1}}'::jsonb -> 'a' AS field, '[10,20,30]'::jsonb -> 1 AS idx`,
  },
  {
    id: "JSN-op-02",
    kind: "parity",
    sql: `SELECT '{"a":{"b":1}}'::jsonb ->> 'a' AS field, '[10,20,30]'::jsonb ->> -1 AS neg`,
  },
  {
    id: "JSN-op-03",
    kind: "parity",
    sql:
      `SELECT '{"a":1}'::jsonb -> 'zzz' IS NULL AS missing_key, '[1,2]'::jsonb ->> 5 IS NULL AS oob, ` +
      `'{"a":1}'::jsonb #> '{x,y}' IS NULL AS missing_path`,
  },
  {
    id: "JSN-op-04",
    kind: "parity",
    sql: `SELECT '{"a":{"b":[1,2]}}'::jsonb #> '{a,b,1}' AS jb, '{"a":{"b":1}}'::jsonb #>> '{a,b}' AS txt`,
  },
  {
    id: "JSN-op-05",
    kind: "parity",
    sql:
      `SELECT '{"a":1,"b":2}'::jsonb @> '{"a":1}'::jsonb AS obj, '[1,2,3]'::jsonb @> '[3,1]'::jsonb AS arr, ` +
      `'{"a":{"b":1,"c":2}}'::jsonb @> '{"a":{"b":1}}'::jsonb AS nested, '{"a":1}'::jsonb @> '{"a":2}'::jsonb AS no`,
  },
  { id: "JSN-op-06", kind: "parity", sql: `SELECT '{"a":1}'::jsonb <@ '{"a":1,"b":2}'::jsonb AS v` },
  {
    id: "JSN-op-07",
    kind: "parity",
    sql:
      `SELECT '{"a":1}'::jsonb ? 'a' AS has, '{"a":1}'::jsonb ? 'b' AS hasnt, '["x","y"]'::jsonb ? 'x' AS arrmem, ` +
      `'{"a":1}'::jsonb ?| array['a','z'] AS anyof, '{"a":1,"b":2}'::jsonb ?& array['a','b'] AS allof`,
  },
  {
    id: "JSN-op-08",
    kind: "parity",
    sql:
      `SELECT '{"a":1,"b":1}'::jsonb || '{"b":2,"c":3}'::jsonb AS objs, '[1]'::jsonb || '[2,3]'::jsonb AS arrs, ` +
      `'{"a":1}'::jsonb || '1'::jsonb AS scalar`,
  },
  {
    id: "JSN-op-09",
    kind: "parity",
    sql:
      `SELECT '{"a":1,"b":2}'::jsonb - 'a' AS bykey, '[1,2,3]'::jsonb - 1 AS byidx, '[1,2]'::jsonb - 99 AS oob, ` +
      `'{"a":1,"b":2,"c":3}'::jsonb - array['a','b'] AS bykeys, '{"a":1}'::jsonb - 'zzz' AS noop`,
  },
  { id: "JSN-op-10", kind: "parity", sql: `SELECT '{"a":{"b":1,"c":2}}'::jsonb #- '{a,b}' AS v` },
  {
    id: "JSN-eq-01",
    kind: "parity",
    sql: `SELECT '{"a":1, "b":2}'::jsonb = '{"b":2, "a":1}'::jsonb AS same, '{"a":1}'::jsonb = '{"a":2}'::jsonb AS diff`,
  },
  {
    id: "JSN-fn-01",
    kind: "parity",
    sql:
      `SELECT jsonb_set('{"a":1}'::jsonb, '{a}', '9'::jsonb) AS replace, ` +
      `jsonb_set('{"a":1}'::jsonb, '{b}', '2'::jsonb) AS add, ` +
      `jsonb_set('{"a":1}'::jsonb, '{b}', '2'::jsonb, false) AS nocreate, ` +
      `jsonb_set('{"a":{"b":1}}'::jsonb, '{a,b}', '"x"'::jsonb) AS nested, ` +
      `jsonb_set('[1,2,3]'::jsonb, '{1}', '99'::jsonb) AS arridx`,
  },
  {
    id: "JSN-fn-02",
    kind: "parity",
    sql: `SELECT jsonb_insert('[1,2]'::jsonb, '{1}', '9'::jsonb) AS before, jsonb_insert('[1,2]'::jsonb, '{1}', '9'::jsonb, true) AS after`,
  },
  {
    id: "JSN-fn-03",
    kind: "parity",
    sql:
      `SELECT jsonb_strip_nulls('{"a":null,"b":1,"c":{"d":null,"e":2}}'::jsonb) AS jb, ` +
      `json_strip_nulls('{"a":null,"b":1}'::json)::text AS j`,
  },
  { id: "JSN-fn-04", kind: "parity", sql: `SELECT jsonb_pretty('{"a":{"c":1},"b":[1,2]}'::jsonb) AS v` },
  {
    id: "JSN-fn-05",
    kind: "parity",
    sql:
      `SELECT jsonb_typeof('{}'::jsonb) AS o, jsonb_typeof('[]'::jsonb) AS a, jsonb_typeof('"x"'::jsonb) AS s, ` +
      `jsonb_typeof('1'::jsonb) AS n, jsonb_typeof('true'::jsonb) AS b, json_typeof('123'::json) AS jn`,
  },
  {
    id: "JSN-fn-06",
    kind: "parity",
    sql: `SELECT jsonb_array_length('[1,2,3]'::jsonb) AS jb, jsonb_array_length('[]'::jsonb) AS empty, json_array_length('[1,2,3]'::json) AS j`,
  },
  {
    id: "JSN-fn-07",
    kind: "parity",
    sql: `SELECT k FROM jsonb_object_keys('{"b":1,"a":2}'::jsonb) AS k ORDER BY k`,
  },
  {
    id: "JSN-fn-08",
    kind: "parity",
    sql:
      `SELECT 'jb' AS src, key, value::text AS v FROM jsonb_each('{"b":2,"a":1}'::jsonb) ` +
      `UNION ALL SELECT 'txt', key, value FROM jsonb_each_text('{"a":1,"b":"s","c":null}'::jsonb) ORDER BY 1, 2`,
  },
  {
    id: "JSN-fn-09",
    kind: "parity",
    sql:
      `SELECT e::text AS e, i FROM jsonb_array_elements('["x","y"]'::jsonb) WITH ORDINALITY AS t(e, i) ` +
      `UNION ALL SELECT v, o FROM jsonb_array_elements_text('["a","b"]'::jsonb) WITH ORDINALITY AS s(v, o) ORDER BY 1`,
  },
  {
    id: "JSN-fn-10",
    kind: "parity",
    sql:
      `SELECT json_extract_path('{"a":{"b":1}}'::json, 'a', 'b')::text AS j, ` +
      `jsonb_extract_path_text('{"a":{"b":1}}'::jsonb, 'a', 'b') AS jbt`,
  },
  {
    id: "JSN-fn-11",
    kind: "parity",
    sql:
      `SELECT jsonb_build_object('a', 1, 'b', 'x', 'c', true) AS jbo, ` +
      `jsonb_build_object('outer', jsonb_build_object('inner', 1)) AS nested, ` +
      `jsonb_build_array(1, 'x', NULL, true) AS jba, json_build_object('a', 1)::text AS jo`,
  },
  { id: "JSN-fn-12", kind: "parity", sql: `SELECT jsonb_object('{a,1,b,2}'::text[]) AS v` },
  {
    id: "JSN-fn-13",
    kind: "parity",
    sql:
      `SELECT to_jsonb(42) AS n, to_jsonb('hi'::text) AS s, to_jsonb(true) AS b, to_json('hi'::text)::text AS j, ` +
      `(SELECT row_to_json(r) FROM (SELECT 1 AS a, 'x' AS b) r) AS rowj`,
  },
  { id: "JSN-cast-01", kind: "parity", sql: `SELECT ('1'::jsonb)::int AS i, ('true'::jsonb)::boolean AS b` },
  {
    id: "JSN-agg-01",
    kind: "parity",
    setup: ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (3), (1), (2)"],
    sql: "SELECT jsonb_agg(v ORDER BY v) AS jb, json_agg(v ORDER BY v) AS j FROM t",
  },
  {
    id: "JSN-agg-02",
    kind: "parity",
    setup: ["CREATE TABLE t (k text, v int)", "INSERT INTO t VALUES ('a', 1), ('b', 2)"],
    sql: "SELECT jsonb_object_agg(k, v) AS jb, json_object_agg(k, v ORDER BY k) AS j FROM t",
  },
  {
    id: "JSN-agg-03",
    kind: "parity",
    setup: ["CREATE TABLE t (v int)"],
    sql: "SELECT jsonb_agg(v) AS jb, json_agg(v) AS j, jsonb_object_agg('k', v) AS oa FROM t",
  },
  {
    id: "JSN-where-01",
    kind: "parity",
    setup: [
      "CREATE TABLE docs (id int, body jsonb)",
      `INSERT INTO docs VALUES (1, '{"a":1}'), (2, '{"a":2}'), (3, '{"a":1,"b":2}')`,
    ],
    sql: `SELECT id FROM docs WHERE body @> '{"a":1}' ORDER BY id`,
  },
  {
    id: "JSN-err-01",
    kind: "error",
    sql: `SELECT '{bad'::jsonb`,
    query: true,
    messageTier: "A",
  },
  {
    id: "JSN-err-02",
    kind: "error",
    sql: `SELECT '{"a":1}x'::jsonb`,
    query: true,
    messageTier: "A",
  },
  {
    id: "JSN-err-03",
    kind: "error",
    sql: `SELECT jsonb_array_length('{}'::jsonb)`,
    query: true,
    messageTier: "A",
  },
  {
    id: "JSN-err-04",
    kind: "error",
    sql: `SELECT ''::jsonb`,
    query: true,
    messageTier: "A",
  },
]);
