import { parity } from "../helpers.ts";

parity(
  "declared affinities coerce numeric text",
  ["CREATE TABLE t(i INTEGER,r REAL,t TEXT,b BLOB,n NUMERIC)", "INSERT INTO t VALUES ('42','42','42','42','42')"],
  "SELECT i,r,t,b,n,typeof(i) ti,typeof(r) tr,typeof(t) tt,typeof(b) tb,typeof(n) tn FROM t",
);
parity(
  "REAL affinity forces real representation",
  ["CREATE TABLE t(v REAL)", "INSERT INTO t VALUES (7),(7.5),('8')"],
  "SELECT v,typeof(v) AS kind FROM t ORDER BY rowid",
);
parity(
  "NUMERIC affinity chooses integer or real",
  ["CREATE TABLE t(v NUMERIC)", "INSERT INTO t VALUES ('3.0'),('3.25'),('not-number')"],
  "SELECT v,typeof(v) AS kind FROM t ORDER BY rowid",
);
parity(
  "BLOB affinity preserves storage classes",
  ["CREATE TABLE t(v BLOB)", "INSERT INTO t VALUES (1),(2.5),('x'),(X'CAFE'),(NULL)"],
  "SELECT typeof(v) AS kind,hex(v) AS bytes FROM t ORDER BY rowid",
);
