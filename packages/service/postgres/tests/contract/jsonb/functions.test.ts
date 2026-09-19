import { parity } from "../helpers.ts";

parity("jsonb_set replaces an existing key", [], `SELECT jsonb_set('{"a":1}'::jsonb, '{a}', '9'::jsonb) AS v`);

parity("jsonb_set adds a missing key by default", [], `SELECT jsonb_set('{"a":1}'::jsonb, '{b}', '2'::jsonb) AS v`);

parity(
  "jsonb_set with create_missing false does not add",
  [],
  `SELECT jsonb_set('{"a":1}'::jsonb, '{b}', '2'::jsonb, false) AS v`,
);

parity("jsonb_set into a nested path", [], `SELECT jsonb_set('{"a":{"b":1}}'::jsonb, '{a,b}', '"x"'::jsonb) AS v`);

parity("jsonb_set on an array index", [], `SELECT jsonb_set('[1,2,3]'::jsonb, '{1}', '99'::jsonb) AS v`);

parity("jsonb_insert into an array position", [], `SELECT jsonb_insert('[1,2]'::jsonb, '{1}', '9'::jsonb) AS v`);

parity("jsonb_insert after a position", [], `SELECT jsonb_insert('[1,2]'::jsonb, '{1}', '9'::jsonb, true) AS v`);

parity(
  "jsonb_strip_nulls removes null object values",
  [],
  `SELECT jsonb_strip_nulls('{"a":null,"b":1,"c":{"d":null,"e":2}}'::jsonb) AS v`,
);

parity(
  "jsonb_typeof for every kind",
  [],
  `SELECT jsonb_typeof('{}'::jsonb) AS o, jsonb_typeof('[]'::jsonb) AS a, jsonb_typeof('"x"'::jsonb) AS s, jsonb_typeof('1'::jsonb) AS n, jsonb_typeof('true'::jsonb) AS b, jsonb_typeof('null'::jsonb) AS nu`,
);

parity("jsonb_array_length", [], `SELECT jsonb_array_length('[1,2,3]'::jsonb) AS v`);

parity("jsonb_array_length of an empty array", [], `SELECT jsonb_array_length('[]'::jsonb) AS v`);

parity(
  "jsonb_each yields key value pairs",
  [],
  `SELECT key, value FROM jsonb_each('{"b":2,"a":1}'::jsonb) ORDER BY key`,
);

parity(
  "jsonb_each_text yields text values",
  [],
  `SELECT key, value FROM jsonb_each_text('{"a":1,"b":"s","c":null}'::jsonb) ORDER BY key`,
);

parity("jsonb_object_keys lists keys", [], `SELECT k FROM jsonb_object_keys('{"b":1,"a":2}'::jsonb) AS k ORDER BY k`);

parity(
  "jsonb_array_elements expands an array",
  [],
  `SELECT e FROM jsonb_array_elements('[3,1,2]'::jsonb) AS t(e) ORDER BY e::text`,
);

parity(
  "jsonb_array_elements_text expands to text",
  [],
  `SELECT v FROM jsonb_array_elements_text('["a","b"]'::jsonb) AS t(v) ORDER BY v`,
);

parity("jsonb_build_object from scalars", [], `SELECT jsonb_build_object('a', 1, 'b', 'x', 'c', true) AS v`);

parity(
  "jsonb_build_object with nested build",
  [],
  `SELECT jsonb_build_object('outer', jsonb_build_object('inner', 1)) AS v`,
);

parity("jsonb_build_array mixed types", [], `SELECT jsonb_build_array(1, 'x', NULL, true) AS v`);

parity("jsonb_pretty formats output", [], `SELECT jsonb_pretty('{"a":{"c":1},"b":[1,2]}'::jsonb) AS v`);

parity("to_jsonb of an integer", [], `SELECT to_jsonb(42) AS v`);

parity("to_jsonb of text", [], `SELECT to_jsonb('hi'::text) AS v`);

parity("to_jsonb of a boolean", [], `SELECT to_jsonb(true) AS v`);

parity("row_to_json over a subquery row", [], `SELECT row_to_json(r) AS v FROM (SELECT 1 AS a, 'x' AS b) r`);

parity(
  "row_to_json over a table row",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a')"],
  "SELECT row_to_json(t) AS v FROM t",
);

parity(
  "jsonb_agg aggregates with deterministic order",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (3), (1), (2)"],
  "SELECT jsonb_agg(v ORDER BY v) AS v FROM t",
);

parity(
  "jsonb_object_agg aggregates key value pairs",
  ["CREATE TABLE t (k text, v int)", "INSERT INTO t VALUES ('a', 1), ('b', 2)"],
  "SELECT jsonb_object_agg(k, v) AS v FROM t",
);
