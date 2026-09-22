import { parity } from "../helpers.ts";
import { SQLITE_JSON_INSTALL_STATEMENTS } from "./sqlite-json-install.ts";

const install = [...SQLITE_JSON_INSTALL_STATEMENTS];

const withText = [...install, "CREATE TABLE t (j text)", `INSERT INTO t VALUES ('{"a":1,"b":[2,3],"c":{"d":"x"}}')`];

parity(
  "sqlite_json_atom_text unwraps jsonb scalars",
  install,
  `SELECT sqlite_json_atom_text('"hi"'::jsonb) AS s, sqlite_json_atom_text('1'::jsonb) AS n, sqlite_json_atom_text('true'::jsonb) AS b, sqlite_json_atom_text('null'::jsonb) AS nu, sqlite_json_atom_text('{"a":1}'::jsonb) AS o`,
);

parity(
  "json_valid accepts objects and arrays",
  install,
  `SELECT json_valid('{"a":1}'::text) AS o, json_valid('[1,2]'::text) AS a`,
);

parity("json_valid rejects invalid JSON", install, `SELECT json_valid('{'::text) AS v, json_valid(''::text) AS empty`);

parity("json_valid of NULL is false", install, `SELECT json_valid(NULL::text) AS v`);

parity(
  "json_type one-arg classifies JSON kinds",
  install,
  `SELECT json_type('{}'::text) AS o, json_type('[]'::text) AS a, json_type('"x"'::text) AS t, json_type('1'::text) AS r, json_type('true'::text) AS b, json_type('null'::text) AS n`,
);

parity(
  "json_type two-arg follows a path",
  withText,
  `SELECT json_type(j, '$.a') AS a, json_type(j, '$.b') AS b, json_type(j, '$.c') AS c, json_type(j, '$.c.d') AS d FROM t`,
);

parity("json_type of invalid JSON is NULL", install, `SELECT json_type('{'::text) AS v`);

parity("json_array_length of a text array", install, `SELECT json_array_length('[1,2,3]'::text) AS v`);

parity("json_array_length of a non-array is NULL", install, `SELECT json_array_length('{"a":1}'::text) AS v`);

parity("json_array_length two-arg nested path", withText, `SELECT json_array_length(j, '$.b') AS v FROM t`);

parity(
  "json_extract field and nested path",
  withText,
  `SELECT json_extract(j, '$.a') AS a, json_extract(j, '$.c.d') AS d, json_extract(j, '$') IS NOT NULL AS root FROM t`,
);

parity("json_extract missing path is NULL", withText, `SELECT json_extract(j, '$.missing') AS v FROM t`);

parity("json_quote wraps text as JSON", install, `SELECT json_quote('hello'::text) AS v`);

parity(
  "sqlite_json_path_to_text_array splits sqlite paths",
  install,
  `SELECT sqlite_json_path_to_text_array('$.a[0].b'::text) AS v`,
);

parity(
  "json_set replaces and adds keys",
  install,
  `SELECT json_set('{"a":1}'::text, '$.a', '9') AS replaced, json_set('{"a":1}'::text, '$.b', '2') AS added`,
);

parity(
  "json_insert does not overwrite an existing key",
  install,
  `SELECT json_insert('{"a":1}'::text, '$.a', '9') AS keep, json_insert('{"a":1}'::text, '$.b', '2') AS add`,
);

parity(
  "json_replace only updates existing keys",
  install,
  `SELECT json_replace('{"a":1}'::text, '$.a', '9') AS updated, json_replace('{"a":1}'::text, '$.b', '2') AS missing`,
);

parity("json_remove deletes a path", install, `SELECT json_remove('{"a":1,"b":2}'::text, '$.a') AS v`);

parity(
  "json_patch concatenates objects",
  install,
  `SELECT json_patch('{"a":1,"b":2}'::text, '{"b":9,"c":3}'::text) AS v`,
);

parity(
  "json_each walks an object",
  install,
  `SELECT key, value, type, atom, parent, path FROM json_each('{"a":1,"b":"x"}'::text) ORDER BY key`,
);

parity(
  "json_each walks an array",
  install,
  `SELECT key, value, type, atom, id, parent, fullkey, path FROM json_each('[1,"x"]'::text) ORDER BY id`,
);

parity("json_each two-arg nested array", withText, `SELECT key, atom, fullkey FROM json_each(j, '$.b') ORDER BY id`);

parity("json_each of NULL yields no rows", install, `SELECT count(*) AS n FROM json_each(NULL::text)`);
