import { parity, parityTyped, queryErrorParity } from "../helpers.ts";

// #692: JSON_TABLE (PostgreSQL 17+): row path, regular / EXISTS / FOR ORDINALITY / NESTED columns,
// ON EMPTY / ON ERROR behaviours, PASSING variables, lateral use.

parity(
  "the issue's JSON_TABLE example",
  [],
  `SELECT * FROM JSON_TABLE('[{"a":1},{"a":2}]'::jsonb, '$[*]' COLUMNS (a int PATH '$.a')) jt`,
);
parity(
  "regular, EXISTS and ordinality columns with ON EMPTY / ON ERROR defaults",
  [],
  `SELECT * FROM JSON_TABLE('[{"a":1,"b":"x"},{"a":2},{"a":"zz","b":[1,2]}]'::jsonb, '$[*]' COLUMNS (id FOR ORDINALITY, a int PATH '$.a', b text, c text PATH '$.b', bj jsonb PATH '$.b', e boolean EXISTS PATH '$.b', d int PATH '$.a' DEFAULT 7 ON ERROR, f int PATH '$.nope' DEFAULT 9 ON EMPTY)) jt`,
);
parityTyped(
  "column types",
  [],
  `SELECT * FROM JSON_TABLE('[{"a":1,"b":"2024-01-02"}]'::jsonb, '$[*]' COLUMNS (id FOR ORDINALITY, a numeric PATH '$.a', b date PATH '$.b', j json PATH '$', e int EXISTS PATH '$.zz')) jt`,
);
parity(
  "scalars go through the column type's input",
  [],
  `SELECT * FROM JSON_TABLE('[1.5, 2, "3", true, "true", 1e2, null, "abcdef"]', '$[*]' COLUMNS (a int PATH '$', b text PATH '$', c bool PATH '$', d float8 PATH '$', v varchar(3) PATH '$'))`,
);
parity(
  "JSON_QUERY-style columns: FORMAT JSON, wrappers and quotes",
  [],
  `SELECT * FROM JSON_TABLE('{"a":{"b":1},"s":"hi","l":[1,2]}'::jsonb, '$' COLUMNS (a text PATH '$.a', aj json PATH '$.a', aw jsonb PATH '$.a.b' WITH WRAPPER, s3 text FORMAT JSON PATH '$.s', s4 text FORMAT JSON PATH '$.s' OMIT QUOTES, s5 jsonb PATH '$.s' KEEP QUOTES, l1 jsonb PATH '$.l[*]' WITH CONDITIONAL WRAPPER, l2 jsonb PATH '$.l[*]' WITHOUT WRAPPER, l3 jsonb PATH '$.l[*]' WITHOUT WRAPPER ERROR ON ERROR))`.replace(
    " ERROR ON ERROR",
    " NULL ON ERROR",
  ),
);
parity(
  "NESTED PATH joins children to their parent row",
  [],
  `SELECT * FROM JSON_TABLE('[{"n":"a","kids":[{"k":1},{"k":2}]},{"n":"b","kids":[]}]'::jsonb, '$[*]' COLUMNS (n text PATH '$.n', NESTED PATH '$.kids[*]' COLUMNS (k int PATH '$.k', o FOR ORDINALITY))) jt`,
);
parity(
  "sibling NESTED paths are unioned",
  [],
  `SELECT * FROM JSON_TABLE('[{"x":[1,2],"y":[3]}]'::jsonb, '$[*]' COLUMNS (NESTED PATH '$.x[*]' COLUMNS (x int PATH '$'), NESTED PATH '$.y[*]' COLUMNS (y int PATH '$'))) jt`,
);
parity(
  "a row path error is an empty table by default",
  [],
  `SELECT * FROM JSON_TABLE('[1,2]'::jsonb, 'strict $.a' COLUMNS (a int PATH '$'))`,
);
queryErrorParity(
  "ERROR ON ERROR for the row path",
  [],
  `SELECT * FROM JSON_TABLE('[1,2]'::jsonb, 'strict $.a' COLUMNS (a int PATH '$') ERROR ON ERROR)`,
);
queryErrorParity(
  "ERROR ON ERROR for a column",
  [],
  `SELECT * FROM JSON_TABLE('{"a":"x"}'::jsonb, '$' COLUMNS (a int PATH '$.a' ERROR ON ERROR))`,
  "invalid_text_representation",
);
queryErrorParity(
  "ERROR ON EMPTY",
  [],
  `SELECT * FROM JSON_TABLE('{"a":"x"}'::jsonb, '$' COLUMNS (a int PATH '$.b' ERROR ON EMPTY))`,
);
queryErrorParity(
  "duplicate column names",
  [],
  `SELECT * FROM JSON_TABLE('[{"a":1}]'::jsonb, '$[*]' COLUMNS (a int PATH '$.a', a text))`,
);
parity(
  "PASSING variables, a path name and a text context",
  [],
  `SELECT * FROM JSON_TABLE('{"a":[1,2]}', '$.a[*]' AS p PASSING 1 AS lim COLUMNS (v numeric PATH '$', e int EXISTS PATH '$ ? (@ > $lim)'))`,
);
parity(
  "JSON_TABLE is lateral to earlier FROM items",
  [
    "CREATE TABLE docs (id int, j jsonb)",
    `INSERT INTO docs VALUES (1, '[{"a":1},{"a":2}]'), (2, '[{"a":3}]'), (3, NULL)`,
  ],
  "SELECT d.id, jt.* FROM docs d, JSON_TABLE(d.j, '$[*]' COLUMNS (a int PATH '$.a')) jt ORDER BY 1, 2",
);
parity(
  "column aliases on JSON_TABLE",
  [],
  `SELECT x.* FROM JSON_TABLE('[{"a":1}]'::jsonb, '$[*]' COLUMNS (a int PATH '$.a', b int PATH '$.b' DEFAULT 5 ON EMPTY)) AS x(c, d)`,
);
