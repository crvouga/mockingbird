import { errorParity, parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "DEFERRABLE INITIALLY IMMEDIATE parses and enforces",
  ["CREATE TABLE t (id int UNIQUE DEFERRABLE INITIALLY IMMEDIATE)"],
  [{ sql: "INSERT INTO t VALUES (1), (2)" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "DEFERRABLE INITIALLY IMMEDIATE still rejects duplicates outside txn",
  ["CREATE TABLE t (id int UNIQUE DEFERRABLE INITIALLY IMMEDIATE)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

sequenceParity(
  "DEFERRABLE INITIALLY DEFERRED parses",
  ["CREATE TABLE t (id int PRIMARY KEY DEFERRABLE INITIALLY DEFERRED)"],
  [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT id FROM t", query: true }],
  { compareFinalState: true },
);

errorParity(
  "sqlstate 23502 for not-null",
  ["CREATE TABLE t (id int NOT NULL)"],
  "INSERT INTO t (id) VALUES (NULL)",
  "constraint_notnull",
);

errorParity(
  "sqlstate 23505 for unique",
  ["CREATE TABLE t (id int UNIQUE)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

errorParity(
  "sqlstate 23514 for check",
  ["CREATE TABLE t (id int CHECK (id != 0))"],
  "INSERT INTO t VALUES (0)",
  "constraint_check",
);

parity(
  "unique constraint check is case-sensitive for text",
  ["CREATE TABLE t (v text UNIQUE)", "INSERT INTO t VALUES ('abc')"],
  "INSERT INTO t VALUES ('ABC') RETURNING v",
);

sequenceParity(
  "unique across updates re-checked",
  ["CREATE TABLE t (id int UNIQUE)", "INSERT INTO t VALUES (1), (2)"],
  [{ sql: "UPDATE t SET id = 3 WHERE id = 2" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "check constraint referencing multiple columns on update",
  ["CREATE TABLE t (lo int, hi int, CHECK (lo <= hi))", "INSERT INTO t VALUES (1, 10)"],
  "UPDATE t SET lo = 20",
  "constraint_check",
);
