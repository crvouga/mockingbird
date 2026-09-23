import { errorParity, execParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

parity(
  "WITHOUT ROWID tables scan in primary key order",
  ["CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID", "INSERT INTO t VALUES ('z','1'),('a','2'),('m','3')"],
  "SELECT * FROM t",
);

parity(
  "composite WITHOUT ROWID primary key order",
  ["CREATE TABLE t(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID", "INSERT INTO t VALUES ('b',1),('a',2),('a',1)"],
  "SELECT * FROM t",
);

queryErrorParity(
  "WITHOUT ROWID tables reject rowid references",
  ["CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID", "INSERT INTO t VALUES ('a','1')"],
  "SELECT rowid FROM t",
);

errorParity(
  "WITHOUT ROWID insert rejects rowid column",
  ["CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID"],
  "INSERT INTO t(rowid, a, b) VALUES (1,'a','1')",
);

execParity("WITHOUT ROWID create table succeeds", [], "CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID");

sequenceParity(
  "WITHOUT ROWID last_insert_rowid stays zero",
  ["CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID"],
  [{ sql: "INSERT INTO t VALUES ('a','1')" }, { sql: "SELECT last_insert_rowid() AS id", query: true }],
);

parity(
  "WITHOUT ROWID primary key update moves clustered row",
  [
    "CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID",
    "INSERT INTO t VALUES ('a','1')",
    "UPDATE t SET a='b' WHERE a='a'",
  ],
  "SELECT * FROM t",
);

errorParity(
  "WITHOUT ROWID NOCASE primary key rejects duplicate keys",
  ["CREATE TABLE t(a TEXT COLLATE NOCASE PRIMARY KEY, b TEXT) WITHOUT ROWID", "INSERT INTO t VALUES ('A','1')"],
  "INSERT INTO t VALUES ('a','2')",
);

parity(
  "WITHOUT ROWID UPSERT DO UPDATE",
  [
    "CREATE TABLE t(a TEXT PRIMARY KEY, b INT) WITHOUT ROWID",
    "INSERT INTO t VALUES ('x',1)",
    "INSERT INTO t VALUES ('x',2) ON CONFLICT(a) DO UPDATE SET b = excluded.b + t.b",
  ],
  "SELECT a, b FROM t",
);

parity(
  "WITHOUT ROWID DELETE and reinsert same primary key",
  [
    "CREATE TABLE t(a TEXT PRIMARY KEY, b INT) WITHOUT ROWID",
    "INSERT INTO t VALUES ('a',1),('b',2)",
    "DELETE FROM t WHERE a = 'a'",
    "INSERT INTO t VALUES ('a',9)",
  ],
  "SELECT a, b FROM t ORDER BY a",
);
