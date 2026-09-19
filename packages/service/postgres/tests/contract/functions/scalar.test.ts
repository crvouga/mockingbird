import { parity, parityTyped } from "../helpers.ts";

parity(
  "scalar sql function with one argument",
  ["CREATE FUNCTION add_one(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$"],
  "SELECT add_one(41) AS v",
);

parity(
  "scalar function with multiple arguments",
  ["CREATE FUNCTION weighted(a int, b int, w int) RETURNS int LANGUAGE sql AS $$ SELECT a * w + b $$"],
  "SELECT weighted(2, 3, 10) AS v",
);

parity(
  "text-returning function",
  ["CREATE FUNCTION shout(msg text) RETURNS text LANGUAGE sql AS $$ SELECT upper(msg) || '!' $$"],
  "SELECT shout('hello') AS v",
);

parity(
  "boolean-returning function",
  ["CREATE FUNCTION is_even(n int) RETURNS boolean LANGUAGE sql AS $$ SELECT n % 2 = 0 $$"],
  "SELECT is_even(4) AS a, is_even(5) AS b",
);

parity(
  "function used inside WHERE",
  [
    "CREATE FUNCTION is_even(n int) RETURNS boolean LANGUAGE sql AS $$ SELECT n % 2 = 0 $$",
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2), (3), (4)",
  ],
  "SELECT id FROM t WHERE is_even(id) ORDER BY id",
);

parity(
  "function reading from a table",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (1), (2), (3)",
    "CREATE FUNCTION total() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM src $$",
  ],
  "SELECT total() AS v",
);

parity(
  "IMMUTABLE function with a RETURN expression body",
  ["CREATE FUNCTION dbl(x int) RETURNS int IMMUTABLE LANGUAGE sql RETURN x * 2"],
  "SELECT dbl(21) AS v",
);

parity(
  "BEGIN ATOMIC function body",
  ["CREATE FUNCTION ba(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT x * 2; END"],
  "SELECT ba(21) AS v",
);

parity(
  "STRICT function returns NULL on NULL input without evaluating",
  ["CREATE FUNCTION plus1(a int) RETURNS int LANGUAGE sql STRICT AS $$ SELECT a + 1 $$"],
  "SELECT plus1(NULL) IS NULL AS strict_null, plus1(1) AS normal",
);

parity(
  "non-strict function receives NULL input",
  ["CREATE FUNCTION coal(a int) RETURNS int LANGUAGE sql AS $$ SELECT coalesce(a, -1) $$"],
  "SELECT coal(NULL) AS v",
);

parityTyped(
  "function return type is reported",
  ["CREATE FUNCTION add_one(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$"],
  "SELECT add_one(1) AS v",
);

parity(
  "function calling another function",
  [
    "CREATE FUNCTION inner_fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$",
    "CREATE FUNCTION outer_fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT inner_fn(x) * 10 $$",
  ],
  "SELECT outer_fn(4) AS v",
);

parity(
  "function over table rows in the select list",
  [
    "CREATE FUNCTION dbl(x int) RETURNS int LANGUAGE sql AS $$ SELECT x * 2 $$",
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2), (3)",
  ],
  "SELECT id, dbl(id) AS doubled FROM t ORDER BY id",
);
