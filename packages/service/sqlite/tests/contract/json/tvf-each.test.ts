import { parity, queryErrorParity } from "../helpers.ts";

parity(
  "json_each array columns",
  [],
  `
  SELECT key, value, type, atom, id, parent, fullkey, path
  FROM json_each('[1,{"a":2},null,true,"x"]')
  ORDER BY id`,
);

parity(
  "json_each object",
  [],
  `
  SELECT key, value, type, atom, id, parent, fullkey, path
  FROM json_each('{"a":1,"b":[2]}')
  ORDER BY id`,
);

parity("json_each empty array", [], `SELECT COUNT(*) AS c FROM json_each('[]')`);
parity("json_each empty object", [], `SELECT COUNT(*) AS c FROM json_each('{}')`);
parity(
  "json_each scalar",
  [],
  `
  SELECT key, value, type, atom, id, parent, fullkey, path FROM json_each('123')`,
);

parity(
  "json_each with path",
  [],
  `
  SELECT key, value, type, id, fullkey FROM json_each('{"a":[10,20]}', '$.a') ORDER BY key`,
);

parity(
  "json_each join",
  ["CREATE TABLE t(id INTEGER, data TEXT)", `INSERT INTO t VALUES (1, '[1,2]'), (2, '[3]')`],
  `SELECT t.id AS id, j.value AS value FROM t, json_each(t.data) AS j ORDER BY t.id, j.key`,
);

parity(
  "json_each filter aggregate",
  [],
  `
  SELECT SUM(value) AS s FROM json_each('[1,2,3,4]') WHERE key >= 1`,
);

queryErrorParity("json_each malformed", [], `SELECT * FROM json_each('{')`);
