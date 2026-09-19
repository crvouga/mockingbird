import { parity } from "../helpers.ts";

parity(
  "RETURNS SETOF int expands to rows",
  ["CREATE FUNCTION nums() RETURNS SETOF int LANGUAGE sql AS $$ SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 $$"],
  "SELECT * FROM nums() AS t(n) ORDER BY n",
);

parity(
  "SETOF function over table data",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (3), (1), (2)",
    "CREATE FUNCTION ids() RETURNS SETOF int LANGUAGE sql AS $$ SELECT id FROM src ORDER BY id $$",
  ],
  "SELECT * FROM ids() AS t(id)",
);

parity(
  "SETOF function with a parameter",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (1), (2), (3), (4)",
    "CREATE FUNCTION ids_above(min_id int) RETURNS SETOF int LANGUAGE sql AS $$ SELECT id FROM src WHERE id > min_id ORDER BY id $$",
  ],
  "SELECT * FROM ids_above(2) AS t(id)",
);

parity(
  "SETOF function returning no rows",
  ["CREATE FUNCTION empty_set() RETURNS SETOF int LANGUAGE sql AS $$ SELECT 1 WHERE false $$"],
  "SELECT count(*) AS n FROM empty_set()",
);

parity(
  "RETURNS TABLE with two columns",
  ["CREATE FUNCTION pairs() RETURNS TABLE(a int, b text) LANGUAGE sql AS $$ SELECT 1, 'x' UNION ALL SELECT 2, 'y' $$"],
  "SELECT * FROM pairs() ORDER BY a",
);

parity(
  "RETURNS TABLE over table data",
  [
    "CREATE TABLE src (id int, v text)",
    "INSERT INTO src VALUES (2, 'b'), (1, 'a')",
    "CREATE FUNCTION rows_of() RETURNS TABLE(id int, v text) LANGUAGE sql AS $$ SELECT id, v FROM src ORDER BY id $$",
  ],
  "SELECT * FROM rows_of()",
);

parity(
  "RETURNS TABLE columns usable in expressions",
  [
    "CREATE TABLE src (id int, v text)",
    "INSERT INTO src VALUES (1, 'a'), (2, 'b')",
    "CREATE FUNCTION rows_of() RETURNS TABLE(id int, v text) LANGUAGE sql AS $$ SELECT id, v FROM src $$",
  ],
  "SELECT id * 10 AS scaled, upper(v) AS uv FROM rows_of() ORDER BY id",
);

parity(
  "join a RETURNS TABLE function with a table",
  [
    "CREATE TABLE names (id int, name text)",
    "INSERT INTO names VALUES (1, 'alice'), (2, 'bob')",
    "CREATE TABLE scores (id int, score int)",
    "INSERT INTO scores VALUES (1, 10), (2, 20)",
    "CREATE FUNCTION all_scores() RETURNS TABLE(id int, score int) LANGUAGE sql AS $$ SELECT id, score FROM scores $$",
  ],
  "SELECT n.name, s.score FROM names n JOIN all_scores() s ON s.id = n.id ORDER BY n.name",
);

parity(
  "SETOF function called with WHERE filtering",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (1), (2), (3), (4), (5)",
    "CREATE FUNCTION ids() RETURNS SETOF int LANGUAGE sql AS $$ SELECT id FROM src $$",
  ],
  "SELECT * FROM ids() AS t(id) WHERE id % 2 = 1 ORDER BY id",
);
