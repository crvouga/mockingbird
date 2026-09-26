import { errorParity } from "../helpers.ts";

errorParity(
  "not-null violation on update",
  ["CREATE TABLE t (id int, v text NOT NULL)", "INSERT INTO t VALUES (1, 'x')"],
  "UPDATE t SET v = NULL WHERE id = 1",
  "constraint_notnull",
);

errorParity(
  "check violation on update",
  ["CREATE TABLE t (id int CHECK (id > 0))", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET id = -5",
  "constraint_check",
);

errorParity(
  "unique violation on update",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1), (2)"],
  "UPDATE t SET id = 1 WHERE id = 2",
  "constraint_unique",
);

errorParity(
  "undefined column in SET",
  ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET b = 1",
  "undefined_column",
);

errorParity(
  "undefined column in WHERE",
  ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET a = 2 WHERE missing = 1",
  "undefined_column",
);

errorParity("undefined table in UPDATE", [], "UPDATE missing_table SET a = 1", "undefined_table");

errorParity(
  "invalid text representation on update",
  ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET a = 'nope'",
  "invalid_text_representation",
);

errorParity(
  "SET row syntax arity mismatch",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 2)"],
  "UPDATE t SET (a, b) = (1, 2, 3)",
  "syntax",
);

errorParity(
  "cardinality error from scalar subquery in SET",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)", "CREATE TABLE s (n int)", "INSERT INTO s VALUES (1), (2)"],
  "UPDATE t SET id = (SELECT n FROM s)",
  "cardinality",
);

errorParity(
  "numeric out of range on update",
  ["CREATE TABLE t (n smallint)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET n = 999999",
  "numeric_out_of_range",
);
