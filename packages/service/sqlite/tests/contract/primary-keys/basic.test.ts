import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "INTEGER PRIMARY KEY generates keys",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT)", "INSERT INTO t(name) VALUES ('a'),('b')"],
  "SELECT id,name FROM t ORDER BY id",
);
errorParity(
  "primary key rejects duplicate integer key",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT)", "INSERT INTO t VALUES (1,'a')"],
  "INSERT INTO t VALUES (1,'b')",
);
errorParity(
  "composite primary key rejects duplicate tuple",
  ["CREATE TABLE t(a INTEGER,b INTEGER,PRIMARY KEY(a,b))", "INSERT INTO t VALUES (1,2)"],
  "INSERT INTO t VALUES (1,2)",
);
parity(
  "different composite key tuples are accepted",
  ["CREATE TABLE t(a INTEGER,b INTEGER,PRIMARY KEY(a,b))", "INSERT INTO t VALUES (1,1),(1,2),(2,1)"],
  "SELECT * FROM t ORDER BY a,b",
);

parity(
  "AUTOINCREMENT generates increasing keys",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)", "INSERT INTO t(name) VALUES ('a'),('b')"],
  "SELECT id,name FROM t ORDER BY id",
);

sequenceParity(
  "AUTOINCREMENT does not reuse deleted ids",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
    "INSERT INTO t(name) VALUES ('a'),('b')",
    "DELETE FROM t WHERE id=2",
  ],
  [{ sql: "INSERT INTO t(name) VALUES ('c')" }, { sql: "SELECT id,name FROM t ORDER BY id", query: true }],
);
