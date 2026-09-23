import { errorParity, parity } from "../helpers.ts";

errorParity(
  "NOT NULL rejects explicit NULL",
  ["CREATE TABLE t(id INTEGER,name TEXT NOT NULL)"],
  "INSERT INTO t VALUES (1,NULL)",
  "constraint_notnull",
);
errorParity(
  "NOT NULL rejects omitted column without default",
  ["CREATE TABLE t(id INTEGER,name TEXT NOT NULL)"],
  "INSERT INTO t(id) VALUES (1)",
  "constraint_notnull",
);
parity(
  "NOT NULL accepts non-null values",
  ["CREATE TABLE t(id INTEGER,name TEXT NOT NULL)", "INSERT INTO t VALUES (1,''),(2,'ok')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "NOT NULL with default accepts omitted column",
  ["CREATE TABLE t(id INTEGER,name TEXT NOT NULL DEFAULT 'unknown')", "INSERT INTO t(id) VALUES (1)"],
  "SELECT * FROM t",
);
errorParity(
  "UPDATE cannot set NOT NULL column to NULL",
  ["CREATE TABLE t(id INTEGER,name TEXT NOT NULL)", "INSERT INTO t VALUES (1,'ok')"],
  "UPDATE t SET name=NULL",
  "constraint_notnull",
);
