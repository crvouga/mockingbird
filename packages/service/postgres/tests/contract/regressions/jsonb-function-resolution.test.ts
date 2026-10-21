import { errorParity, parity, parityTyped } from "../helpers.ts";

// #443 (needs-info): the reported statement is not isolated. The pieces of the report that can be
// pinned are the jsonb argument types a user function sees when its argument comes from a
// lateral subquery, a CASE, or the alias of a set-returning function in FROM.
const setup = [
  "CREATE SCHEMA finance",
  "CREATE TABLE finance.t (id int, payload jsonb)",
  `INSERT INTO finance.t VALUES (1, '{"name":" a ","o":{"k":"v"},"arr":[{"k":"x"},{"k":"y"}]}'), (2, '{"name":"b","o":[],"arr":[]}')`,
  `CREATE FUNCTION finance.touch_value(v jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(btrim(v ->> k), '') $$`,
];

parity(
  "#443 a jsonb CASE projected through CROSS JOIN LATERAL reaches a (jsonb, text) function",
  setup,
  `SELECT t.id, finance.touch_value(x.v, 'k') AS k
   FROM finance.t t
   CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(t.payload -> 'o') = 'object' THEN t.payload -> 'o' ELSE NULL END AS v) x
   ORDER BY t.id`,
);

parity(
  "#443 a CASE with an untyped literal branch resolves to jsonb",
  setup,
  `SELECT t.id, finance.touch_value(CASE WHEN t.id = 1 THEN t.payload -> 'o' ELSE '{}' END, 'k') AS k FROM finance.t t ORDER BY t.id`,
);

parity(
  "#443 the alias of jsonb_array_elements is the jsonb element in a function call",
  setup,
  `SELECT t.id, finance.touch_value(e, 'k') AS k FROM finance.t t CROSS JOIN LATERAL jsonb_array_elements(t.payload -> 'arr') AS e ORDER BY 1, 2`,
);

parity(
  "#443 the alias of jsonb_array_elements is the jsonb element for a builtin",
  setup,
  `SELECT jsonb_typeof(e) AS ty, e ->> 'k' AS k FROM finance.t t, jsonb_array_elements(t.payload -> 'arr') AS e ORDER BY 2`,
);

parityTyped(
  "#443 whole-row reference to a scalar function range variable",
  [],
  "SELECT e, jsonb_array_elements AS whole FROM jsonb_array_elements('[1, \"a\"]') AS e, jsonb_array_elements('[true]') ORDER BY 1::text",
);

parityTyped(
  "#443 a function with WITH ORDINALITY keeps a record for the whole row",
  [],
  "SELECT e FROM jsonb_array_elements('[1]') WITH ORDINALITY AS e",
);

errorParity(
  "#443 a text argument does not resolve a (jsonb, text) function",
  setup,
  "SELECT finance.touch_value(x.v, 'name') FROM (SELECT '{\"name\":\"a\"}'::text AS v) x",
  "undefined_function",
);
