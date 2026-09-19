import { errorParity, queryErrorParity } from "../helpers.ts";

queryErrorParity("undefined table in SELECT fails with 42P01", [], "SELECT * FROM missing_table", "undefined_table");

queryErrorParity(
  "undefined table in a join fails with 42P01",
  ["CREATE TABLE t (id int)"],
  "SELECT * FROM t JOIN missing_table ON true",
  "undefined_table",
);

errorParity(
  "INSERT into an undefined table fails with 42P01",
  [],
  "INSERT INTO missing_table VALUES (1)",
  "undefined_table",
);

errorParity("UPDATE of an undefined table fails with 42P01", [], "UPDATE missing_table SET x = 1", "undefined_table");

errorParity("DELETE from an undefined table fails with 42P01", [], "DELETE FROM missing_table", "undefined_table");

errorParity("DROP TABLE of an undefined table fails with 42P01", [], "DROP TABLE missing_table", "undefined_table");

queryErrorParity(
  "undefined column in the select list fails with 42703",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT nope FROM t",
  "undefined_column",
);

queryErrorParity(
  "undefined column in WHERE fails with 42703",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t WHERE nope = 1",
  "undefined_column",
);

queryErrorParity(
  "undefined column in ORDER BY fails with 42703",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t ORDER BY nope",
  "undefined_column",
);

errorParity(
  "undefined column in UPDATE SET fails with 42703",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET nope = 1",
  "undefined_column",
);

queryErrorParity(
  "undefined function without arguments fails with 42883",
  [],
  "SELECT no_such_fn()",
  "undefined_function",
);

queryErrorParity(
  "undefined function with an unknown-typed literal fails with 42883",
  [],
  "SELECT no_such_fn('x')",
  "undefined_function",
);

queryErrorParity(
  "undefined function with a text argument fails with 42883",
  [],
  "SELECT no_such_fn('x'::text)",
  "undefined_function",
);

queryErrorParity("undefined operator combination fails with 42883", [], "SELECT 1 + 'a'::text", "undefined_function");
