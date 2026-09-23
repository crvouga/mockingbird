import { parity } from "../helpers.ts";

parity(
  "json_tree object",
  [],
  `
  SELECT id, parent, fullkey, type, key, path
  FROM json_tree('{"a":[1]}')
  ORDER BY id`,
);

parity(
  "json_tree array nested",
  [],
  `
  SELECT id, parent, fullkey, type, key
  FROM json_tree('[1,{"a":2},null,true,"x"]')
  ORDER BY id`,
);

parity(
  "json_tree with path",
  [],
  `
  SELECT id, parent, fullkey, type, key
  FROM json_tree('{"a":{"b":[1,2]}}', '$.a')
  ORDER BY id`,
);

parity(
  "json_tree join filter",
  ["CREATE TABLE docs(id INTEGER, body TEXT)", `INSERT INTO docs VALUES (1, '{"tags":["a","b"]}')`],
  `SELECT d.id AS id, j.value AS value
    FROM docs d
    JOIN json_tree(d.body) AS j
    WHERE j.type = 'text'
    ORDER BY j.value`,
);

parity(
  "multiple json tvfs",
  [],
  `
  SELECT e.key, t.fullkey
  FROM json_each('[1,2]') AS e
  JOIN json_tree('{"x":[1,2]}') AS t ON e.key = CAST(t.key AS INTEGER)
  WHERE t.type = 'integer'
  ORDER BY e.key, t.fullkey`,
);
