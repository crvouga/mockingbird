import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "more expressions than target columns",
  ["CREATE TABLE t (a int, b int)"],
  "INSERT INTO t VALUES (1, 2, 3)",
  "syntax",
);

errorParity(
  "not-null violation on insert",
  ["CREATE TABLE t (id int NOT NULL, v text)"],
  "INSERT INTO t VALUES (NULL, 'x')",
  "constraint_notnull",
);

errorParity(
  "not-null violation via omitted column",
  ["CREATE TABLE t (id int NOT NULL, v text)"],
  "INSERT INTO t (v) VALUES ('x')",
  "constraint_notnull",
);

errorParity(
  "check violation on insert",
  ["CREATE TABLE t (id int CHECK (id > 0))"],
  "INSERT INTO t VALUES (-1)",
  "constraint_check",
);

errorParity("insert into missing table", [], "INSERT INTO missing_table VALUES (1)", "undefined_table");

errorParity(
  "insert into missing column",
  ["CREATE TABLE t (a int)"],
  "INSERT INTO t (b) VALUES (1)",
  "undefined_column",
);

errorParity(
  "duplicate column in target list",
  ["CREATE TABLE t (a int, b int)"],
  "INSERT INTO t (a, a) VALUES (1, 2)",
  "duplicate_object",
);

errorParity(
  "invalid text representation for int",
  ["CREATE TABLE t (a int)"],
  "INSERT INTO t VALUES ('abc')",
  "invalid_text_representation",
);

errorParity(
  "unique violation on insert",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

sequenceParity(
  "failed insert leaves prior rows intact",
  ["CREATE TABLE t (id int NOT NULL)", "INSERT INTO t VALUES (1), (2)"],
  [{ sql: "INSERT INTO t VALUES (NULL)" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);
