import { errorParity, parity } from "../helpers.ts";

parity(
  "composite unique index lookup by leftmost prefix",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, v TEXT)",
    "CREATE UNIQUE INDEX t_ab ON t(a,b)",
    "INSERT INTO t VALUES (1,10,1,'x'),(2,10,2,'y'),(3,20,1,'z')",
  ],
  "SELECT id,b,v FROM t WHERE a=10 ORDER BY b",
);

parity(
  "composite unique index lookup by full key",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, v TEXT)",
    "CREATE UNIQUE INDEX t_ab ON t(a,b)",
    "INSERT INTO t VALUES (1,10,1,'x'),(2,10,2,'y')",
  ],
  "SELECT id,v FROM t WHERE a=10 AND b=2",
);

errorParity(
  "composite unique index rejects duplicate full key",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)",
    "CREATE UNIQUE INDEX t_ab ON t(a,b)",
    "INSERT INTO t VALUES (1,10,1)",
  ],
  "INSERT INTO t VALUES (2,10,1)",
  "constraint_unique",
);

parity(
  "composite unique index allows same prefix with different second column",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)",
    "CREATE UNIQUE INDEX t_ab ON t(a,b)",
    "INSERT INTO t VALUES (1,10,1),(2,10,2)",
  ],
  "SELECT id,a,b FROM t ORDER BY id",
);

parity(
  "three-column index prefix of two columns",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c INTEGER)",
    "CREATE INDEX t_abc ON t(a,b,c)",
    "INSERT INTO t VALUES (1,1,2,3),(2,1,2,4),(3,1,9,1),(4,2,2,3)",
  ],
  "SELECT id FROM t WHERE a=1 AND b=2 ORDER BY c",
);
