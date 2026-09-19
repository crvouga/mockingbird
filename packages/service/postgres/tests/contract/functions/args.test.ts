import { parity, sequenceParity } from "../helpers.ts";

parity(
  "named arguments in declaration order",
  ["CREATE FUNCTION f(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a * 10 + b $$"],
  "SELECT f(a => 1, b => 2) AS v",
);

parity(
  "positional then named argument",
  ["CREATE FUNCTION f(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a * 10 + b $$"],
  "SELECT f(1, b => 2) AS v",
);

parity(
  "trailing default argument omitted",
  ["CREATE FUNCTION f(a int, b int DEFAULT 5) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$"],
  "SELECT f(1) AS with_default, f(1, 2) AS explicit",
);

parity(
  "default argument overridden by name",
  ["CREATE FUNCTION f(a int, b int DEFAULT 5) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$"],
  "SELECT f(1, b => 9) AS v",
);

parity(
  "multiple defaults filled left to right",
  ["CREATE FUNCTION f(a int, b int DEFAULT 5, c int DEFAULT 7) RETURNS int LANGUAGE sql AS $$ SELECT a + b + c $$"],
  "SELECT f(1) AS x, f(1, 2) AS y, f(1, 2, 3) AS z",
);

parity(
  "text default argument",
  [
    "CREATE FUNCTION greet(name text, greeting text DEFAULT 'hello') RETURNS text LANGUAGE sql AS $$ SELECT greeting || ', ' || name $$",
  ],
  "SELECT greet('world') AS a, greet('world', 'hi') AS b",
);

parity(
  "overloads resolved by argument count",
  [
    "CREATE FUNCTION ov(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$",
    "CREATE FUNCTION ov(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$",
  ],
  "SELECT ov(1) AS one, ov(1, 2) AS two",
);

sequenceParity(
  "DROP FUNCTION without an argument list works for a unique name",
  ["CREATE FUNCTION solo(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
  [{ sql: "DROP FUNCTION solo" }, { sql: "SELECT count(*) AS n FROM pg_proc WHERE proname = 'solo'", query: true }],
);

sequenceParity(
  "DROP FUNCTION IF EXISTS on a missing function is a no-op",
  [],
  [{ sql: "DROP FUNCTION IF EXISTS no_such_fn(int)" }, { sql: "SELECT 1 AS v", query: true }],
);

sequenceParity(
  "redefining a dropped function",
  ["CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$"],
  [
    { sql: "SELECT f(1) AS v", query: true },
    { sql: "DROP FUNCTION f(int)" },
    { sql: "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 100 $$" },
    { sql: "SELECT f(1) AS v", query: true },
  ],
);

parity(
  "CREATE OR REPLACE FUNCTION replaces the body",
  [
    "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$",
    "CREATE OR REPLACE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 2 $$",
  ],
  "SELECT f(1) AS v",
);
