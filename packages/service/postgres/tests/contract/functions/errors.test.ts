import { errorParity, queryErrorParity, sequenceParity } from "../helpers.ts";

queryErrorParity(
  "calling an undefined function fails with 42883",
  [],
  "SELECT no_such_function()",
  "undefined_function",
);

queryErrorParity(
  "calling with a text argument no overload accepts fails with 42883",
  ["CREATE FUNCTION only_zero() RETURNS int LANGUAGE sql AS $$ SELECT 0 $$"],
  "SELECT only_zero('x'::text)",
  "undefined_function",
);

errorParity(
  "duplicate function with the same signature fails with 42723",
  ["CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
  "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$",
  "duplicate_object",
);

sequenceParity(
  "dropped function is no longer callable",
  ["CREATE FUNCTION gone(msg text) RETURNS text LANGUAGE sql AS $$ SELECT msg $$"],
  [
    { sql: "SELECT gone('here'::text) AS v", query: true },
    { sql: "DROP FUNCTION gone(text)" },
    { sql: "SELECT gone('here'::text)", query: true },
  ],
);

queryErrorParity(
  "function body error surfaces at call time",
  ["CREATE FUNCTION bad_math() RETURNS int LANGUAGE sql AS $$ SELECT 1/0 $$"],
  "SELECT bad_math()",
  "division_by_zero",
);
