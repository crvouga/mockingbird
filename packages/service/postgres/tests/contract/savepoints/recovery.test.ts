import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "ROLLBACK TO after unique violation recovers the transaction",
  ["CREATE TABLE t (id int PRIMARY KEY)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK TO after division by zero recovers the transaction",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT sp" },
    { sql: "SELECT 1/0" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "ROLLBACK TO after undefined table error recovers the transaction",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "SELECT * FROM no_such_table" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "ROLLBACK TO after check violation recovers the transaction",
  ["CREATE TABLE t (id int CHECK (id > 0))"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (-1)" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (5)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "ROLLBACK TO after not-null violation recovers the transaction",
  ["CREATE TABLE t (id int NOT NULL)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (NULL)" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "work before the savepoint survives error recovery and commit",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1, 'keep')" },
    { sql: "UPDATE t SET v = 'kept' WHERE id = 1" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (1, 'dup')" },
    { sql: "ROLLBACK TO sp" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "two failures recovered by two savepoints",
  ["CREATE TABLE t (id int PRIMARY KEY)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT a" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO a" },
    { sql: "SAVEPOINT b" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO b" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "recovered transaction sees pre-savepoint rows",
  ["CREATE TABLE t (id int PRIMARY KEY)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT sp" },
    { sql: "SELECT 1/0" },
    { sql: "ROLLBACK TO sp" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "COMMIT" },
  ],
);
