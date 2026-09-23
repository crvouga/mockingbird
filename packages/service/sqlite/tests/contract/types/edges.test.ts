import { parity } from "../helpers.ts";

const mixed = ["CREATE TABLE t(v)", "INSERT INTO t VALUES (NULL),(2),(1.5),('10'),('2'),(X'32')"];
parity("mixed storage classes sort in SQLite order", mixed, "SELECT v,typeof(v) kind FROM t ORDER BY v");
parity(
  "descending mixed storage classes reverse consistently",
  mixed,
  "SELECT v,typeof(v) kind FROM t ORDER BY v DESC",
);
parity(
  "NUMERIC affinity stores decimal text as real",
  ["CREATE TABLE t(v NUMERIC)", "INSERT INTO t VALUES ('1.5')"],
  "SELECT v,typeof(v) kind FROM t",
);
parity(
  "INTEGER affinity stores integer text as integer",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES ('42')"],
  "SELECT v,typeof(v) kind FROM t",
);
parity(
  "blob and text retain distinct storage classes",
  ["CREATE TABLE t(v)", "INSERT INTO t VALUES ('abc'),(X'616263')"],
  "SELECT typeof(v) kind,hex(v) bytes FROM t ORDER BY typeof(v)",
);
