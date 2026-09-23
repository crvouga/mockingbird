import { parity, parityTyped } from "../helpers.ts";

parity("jsonb canonicalizes key order", [], `SELECT '{"b":1,"a":2}'::jsonb AS v`);

parity("jsonb deduplicates keys keeping the last", [], `SELECT '{"a":1,"a":2}'::jsonb AS v`);

parity("json preserves order and duplicates", [], `SELECT '{"b":1,"a":2,"b":3}'::json AS v`);

parity(
  "json preserves whitespace but jsonb normalizes it",
  [],
  `SELECT '{"a": 1,  "b":2}'::json::text AS j, '{"a": 1,  "b":2}'::jsonb::text AS jb`,
);

parity("jsonb::text round trip", [], `SELECT ('{"a": 1}'::jsonb)::text AS v`);

parity("jsonb number canonicalization", [], `SELECT '1.50'::jsonb::text AS a, '1e2'::jsonb::text AS b`);

parity("jsonb equality is structural", [], `SELECT '{"a":1, "b":2}'::jsonb = '{"b":2, "a":1}'::jsonb AS v`);

parity("jsonb inequality on values", [], `SELECT '{"a":1}'::jsonb = '{"a":2}'::jsonb AS v`);

parityTyped("jsonb cast produces jsonb type", [], `SELECT '{"a":1}'::jsonb AS v`);

parityTyped("json cast produces json type", [], `SELECT '{"a":1}'::json AS v`);

parityTyped("->> returns text", [], `SELECT '{"a":1}'::jsonb ->> 'a' AS v`);

parity("json::jsonb conversion canonicalizes", [], `SELECT ('{"b":1,"a":2,"b":3}'::json)::jsonb AS v`);

parity("jsonb::json conversion keeps canonical form", [], `SELECT ('{"b":1,"a":2}'::jsonb)::json AS v`);

parity("jsonb scalar string round trips", [], `SELECT '"hello"'::jsonb AS v`);

parity(
  "jsonb null literal vs SQL NULL",
  [],
  `SELECT 'null'::jsonb IS NULL AS sql_null, jsonb_typeof('null'::jsonb) AS ty`,
);

parity("nested arrays and objects round trip", [], `SELECT '{"a":[{"b":[1,2]},{"c":null}]}'::jsonb AS v`);

parity("unicode escapes in jsonb strings are decoded", [], `SELECT '["a\\u0041b"]'::jsonb ->> 0 AS decoded`);

parity(
  "jsonb column round trips through storage",
  ["CREATE TABLE docs (id int, body jsonb)", `INSERT INTO docs VALUES (1, '{"z":1,"a":{"n":[3,2,1]}}')`],
  "SELECT body FROM docs",
);

parity(
  "jsonb operators over a stored column",
  ["CREATE TABLE docs (id int, body jsonb)", `INSERT INTO docs VALUES (1, '{"tags":["x","y"],"n":1}')`],
  "SELECT body -> 'tags' ->> 0 AS first_tag, body ->> 'n' AS n FROM docs",
);

parity(
  "WHERE containment over a stored column",
  [
    "CREATE TABLE docs (id int, body jsonb)",
    `INSERT INTO docs VALUES (1, '{"a":1}'), (2, '{"a":2}'), (3, '{"a":1,"b":2}')`,
  ],
  `SELECT id FROM docs WHERE body @> '{"a":1}' ORDER BY id`,
);
