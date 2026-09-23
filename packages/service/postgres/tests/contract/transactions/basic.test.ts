import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "committed insert is visible after COMMIT",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b')" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK discards inserts",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1), (2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK discards updates",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'orig')"],
  [
    { sql: "BEGIN" },
    { sql: "UPDATE t SET v = 'changed' WHERE id = 1" },
    { sql: "SELECT v FROM t WHERE id = 1", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT v FROM t WHERE id = 1", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK discards deletes",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"],
  [
    { sql: "BEGIN" },
    { sql: "DELETE FROM t WHERE id > 1" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "implicit transaction commits each statement",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"],
  "SELECT * FROM t ORDER BY id",
);

sequenceParity(
  "changes inside txn are visible to the same session before commit",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (10)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "UPDATE t SET id = 11" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "COMMIT" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "START TRANSACTION works like BEGIN",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "START TRANSACTION" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "END commits like COMMIT",
  ["CREATE TABLE t (id int)"],
  [{ sql: "BEGIN" }, { sql: "INSERT INTO t VALUES (7)" }, { sql: "END" }, { sql: "SELECT * FROM t", query: true }],
);

sequenceParity(
  "BEGIN WORK and COMMIT WORK forms",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN WORK" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT WORK" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "sequential transactions accumulate committed work",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (3)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "mixed DML in a single transaction",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')" },
    { sql: "UPDATE t SET v = 'z' WHERE id = 2" },
    { sql: "DELETE FROM t WHERE id = 3" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "read-only transaction",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "SELECT * FROM t", query: true },
    { sql: "SELECT count(*) AS n FROM t", query: true },
    { sql: "COMMIT" },
  ],
);
