import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "column NOT NULL rejects null insert",
  ["CREATE TABLE t (id int NOT NULL)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);

errorParity(
  "column-level CHECK rejects bad value",
  ["CREATE TABLE t (age int CHECK (age >= 0))"],
  "INSERT INTO t VALUES (-1)",
  "constraint_check",
);

errorParity(
  "table-level CHECK across columns",
  ["CREATE TABLE t (lo int, hi int, CHECK (lo <= hi))"],
  "INSERT INTO t VALUES (10, 5)",
  "constraint_check",
);

errorParity(
  "named CHECK constraint",
  ["CREATE TABLE t (n int, CONSTRAINT n_positive CHECK (n > 0))"],
  "INSERT INTO t VALUES (0)",
  "constraint_check",
);

errorParity(
  "named NOT NULL via constraint syntax",
  ["CREATE TABLE t (id int CONSTRAINT id_nn NOT NULL)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);

sequenceParity(
  "CHECK passes when null (unknown is allowed)",
  ["CREATE TABLE t (n int CHECK (n > 0))"],
  [{ sql: "INSERT INTO t VALUES (NULL)" }, { sql: "SELECT n FROM t", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "CHECK with expression involving functions",
  ["CREATE TABLE t (name text CHECK (length(name) >= 2))"],
  [{ sql: "INSERT INTO t VALUES ('ok'), ('yes')" }, { sql: "SELECT name FROM t ORDER BY name", query: true }],
  { compareFinalState: true },
);

errorParity(
  "CHECK with function rejects short value",
  ["CREATE TABLE t (name text CHECK (length(name) >= 2))"],
  "INSERT INTO t VALUES ('x')",
  "constraint_check",
);

errorParity(
  "multiple CHECK constraints all enforced",
  ["CREATE TABLE t (n int CHECK (n > 0) CHECK (n < 100))"],
  "INSERT INTO t VALUES (500)",
  "constraint_check",
);

sequenceParity(
  "boundary values accepted",
  ["CREATE TABLE t (n int CHECK (n BETWEEN 1 AND 10))"],
  [{ sql: "INSERT INTO t VALUES (1), (10)" }, { sql: "SELECT n FROM t ORDER BY n", query: true }],
  { compareFinalState: true },
);
