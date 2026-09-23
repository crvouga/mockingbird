import { parity, sequenceParity } from "../helpers.ts";

parity(
  "user function appears in pg_proc",
  ["CREATE FUNCTION uf(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
  "SELECT proname, pronargs FROM pg_proc WHERE proname = 'uf'",
);

parity(
  "pg_proc pronargs reflects the argument count",
  ["CREATE FUNCTION three_args(a int, b text, c boolean) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
  "SELECT proname, pronargs FROM pg_proc WHERE proname = 'three_args'",
);

parity(
  "overloads produce multiple pg_proc rows",
  [
    "CREATE FUNCTION ov(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$",
    "CREATE FUNCTION ov(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$",
  ],
  "SELECT proname, pronargs FROM pg_proc WHERE proname = 'ov' ORDER BY pronargs",
);

sequenceParity(
  "pg_proc row disappears after DROP FUNCTION",
  ["CREATE FUNCTION uf(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
  [
    { sql: "SELECT count(*) AS n FROM pg_proc WHERE proname = 'uf'", query: true },
    { sql: "DROP FUNCTION uf(int)" },
    { sql: "SELECT count(*) AS n FROM pg_proc WHERE proname = 'uf'", query: true },
  ],
);

parity(
  "function in a user schema joins pg_namespace",
  ["CREATE SCHEMA util", "CREATE FUNCTION util.helper(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$"],
  "SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'helper'",
);

parity(
  "builtin function is present in pg_proc",
  [],
  "SELECT count(*) > 0 AS present FROM pg_proc WHERE proname = 'lower'",
);

parity(
  "no-argument user function has pronargs 0",
  ["CREATE FUNCTION zero_args() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$"],
  "SELECT proname, pronargs FROM pg_proc WHERE proname = 'zero_args'",
);
