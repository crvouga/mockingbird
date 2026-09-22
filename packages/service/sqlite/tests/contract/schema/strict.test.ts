import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "STRICT TEXT stores text",
  ["CREATE TABLE t(x TEXT) STRICT", "INSERT INTO t VALUES ('ok')"],
  "SELECT typeof(x) AS t, x FROM t",
);

parity(
  "STRICT TEXT converts integer to text",
  ["CREATE TABLE t(x TEXT) STRICT", "INSERT INTO t VALUES (1)"],
  "SELECT typeof(x) AS t, x FROM t",
);

errorParity(
  "STRICT INT rejects text",
  ["CREATE TABLE t(x INT) STRICT"],
  "INSERT INTO t VALUES ('nope')",
  "datatype_mismatch",
);

parity(
  "STRICT INT stores integer",
  ["CREATE TABLE t(x INT) STRICT", "INSERT INTO t VALUES (7)"],
  "SELECT typeof(x) AS t, x FROM t",
);

errorParity(
  "STRICT INT rejects real",
  ["CREATE TABLE t(x INT) STRICT"],
  "INSERT INTO t VALUES (1.5)",
  "datatype_mismatch",
);

parity(
  "STRICT INTEGER PRIMARY KEY is a rowid alias",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, x TEXT) STRICT", "INSERT INTO t(x) VALUES ('a')"],
  "SELECT id, x FROM t",
);

parity(
  "STRICT REAL stores floating point",
  ["CREATE TABLE t(x REAL) STRICT", "INSERT INTO t VALUES (1.25)"],
  "SELECT typeof(x) AS t, x FROM t",
);

parity(
  "STRICT REAL converts integer to real",
  ["CREATE TABLE t(x REAL) STRICT", "INSERT INTO t VALUES (3)"],
  "SELECT typeof(x) AS t FROM t",
);

parity(
  "STRICT ANY preserves storage class",
  [
    "CREATE TABLE t(x ANY) STRICT",
    "INSERT INTO t VALUES (1)",
    "INSERT INTO t VALUES ('a')",
    "INSERT INTO t VALUES (1.5)",
  ],
  "SELECT typeof(x) AS t FROM t ORDER BY rowid",
);

errorParity("STRICT rejects unknown declared type", [], "CREATE TABLE t(x VARCHAR) STRICT");

errorParity(
  "STRICT BLOB rejects text",
  ["CREATE TABLE t(x BLOB) STRICT"],
  "INSERT INTO t VALUES ('abc')",
  "datatype_mismatch",
);

parity(
  "STRICT BLOB stores blob",
  ["CREATE TABLE t(x BLOB) STRICT", "INSERT INTO t VALUES (X'00FF')"],
  "SELECT typeof(x) AS t FROM t",
);

parity(
  "STRICT allows NULL in nullable columns",
  ["CREATE TABLE t(x TEXT) STRICT", "INSERT INTO t VALUES (NULL)"],
  "SELECT x FROM t",
);

errorParity(
  "STRICT NOT NULL still rejects NULL",
  ["CREATE TABLE t(x TEXT NOT NULL) STRICT"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);

sequenceParity(
  "STRICT WITH WITHOUT ROWID",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, x TEXT) STRICT, WITHOUT ROWID"],
  [{ sql: "INSERT INTO t VALUES (1,'a')" }, { sql: "SELECT id,x FROM t", query: true }],
);

parity(
  "ordinary table still applies affinity unlike STRICT TEXT",
  ["CREATE TABLE t(x TEXT)", "INSERT INTO t VALUES (1)"],
  "SELECT typeof(x) AS t, x FROM t",
);
