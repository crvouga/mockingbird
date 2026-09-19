import { errorParity, parity } from "../helpers.ts";

errorParity(
  "UNIQUE column rejects duplicate value",
  ["CREATE TABLE t(id INTEGER,email TEXT UNIQUE)", "INSERT INTO t VALUES (1,'a@x')"],
  "INSERT INTO t VALUES (2,'a@x')",
  "constraint_unique",
);
parity(
  "UNIQUE permits multiple NULL values",
  ["CREATE TABLE t(id INTEGER,email TEXT UNIQUE)", "INSERT INTO t VALUES (1,NULL),(2,NULL)"],
  "SELECT * FROM t ORDER BY id",
);
errorParity(
  "table-level composite UNIQUE rejects duplicate tuple",
  ["CREATE TABLE t(a INTEGER,b INTEGER,UNIQUE(a,b))", "INSERT INTO t VALUES (1,2)"],
  "INSERT INTO t VALUES (1,2)",
  "constraint_unique",
);
parity(
  "composite UNIQUE accepts rows differing in one column",
  ["CREATE TABLE t(a INTEGER,b INTEGER,UNIQUE(a,b))", "INSERT INTO t VALUES (1,1),(1,2),(2,1)"],
  "SELECT * FROM t ORDER BY a,b",
);
