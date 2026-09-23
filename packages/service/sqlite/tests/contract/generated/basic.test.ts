import { errorParity, parity } from "../helpers.ts";

parity(
  "STORED generated column is materialized",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id + 1) STORED)",
    "INSERT INTO t(id) VALUES (1),(2)",
  ],
  "SELECT id, v FROM t ORDER BY id",
);

parity(
  "VIRTUAL generated column is computed on read",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id * 2) VIRTUAL)",
    "INSERT INTO t(id) VALUES (3),(4)",
  ],
  "SELECT id, v FROM t ORDER BY id",
);

parity(
  "STORED generated column with COLLATE on base expression",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, g TEXT GENERATED ALWAYS AS (upper(name)) STORED)",
    "INSERT INTO t(id, name) VALUES (1,'abc'),(2,'XyZ')",
  ],
  "SELECT id, name, g FROM t ORDER BY id",
);

parity(
  "VIRTUAL generated used in WHERE and ORDER BY",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id * 10) VIRTUAL)",
    "INSERT INTO t(id) VALUES (1),(2),(3)",
  ],
  "SELECT id, v FROM t WHERE v >= 20 ORDER BY v DESC",
);

errorParity(
  "cannot insert into generated column (differential)",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id+1) STORED)"],
  "INSERT INTO t(id, v) VALUES (1, 99)",
  "misuse",
);
