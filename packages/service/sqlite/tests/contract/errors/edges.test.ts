import { errorParity, queryErrorParity } from "../helpers.ts";

errorParity(
  "non-integer INTEGER PRIMARY KEY is datatype mismatch",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
  "INSERT INTO t VALUES ('abc')",
  "datatype_mismatch",
);
errorParity(
  "real INTEGER PRIMARY KEY is datatype mismatch",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY)"],
  "INSERT INTO t VALUES (1.5)",
  "datatype_mismatch",
);
queryErrorParity(
  "unqualified duplicate join column is ambiguous",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)"],
  "SELECT id FROM a JOIN b ON a.id=b.id",
  "other",
);
queryErrorParity(
  "ambiguous WHERE column is rejected",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES (1)"],
  "SELECT a.id FROM a JOIN b ON a.id=b.id WHERE id=1",
  "other",
);
queryErrorParity(
  "qualified duplicate columns remain valid only when present",
  ["CREATE TABLE a(id INTEGER)"],
  "SELECT b.id FROM a",
  "no_such_column",
);
