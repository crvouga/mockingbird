import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "ROLLBACK TO undoes work after the savepoint only",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT sp1" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO sp1" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "RELEASE SAVEPOINT keeps changes made after the savepoint",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT sp1" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "RELEASE SAVEPOINT sp1" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "RELEASE without SAVEPOINT keyword",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp1" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "RELEASE sp1" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "ROLLBACK TO SAVEPOINT long form",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp1" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO SAVEPOINT sp1" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

sequenceParity(
  "nested savepoints: rollback to outer discards inner work",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT a" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SAVEPOINT b" },
    { sql: "INSERT INTO t VALUES (3)" },
    { sql: "ROLLBACK TO a" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "nested savepoints: rollback to inner keeps outer work",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT a" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT b" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO b" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "savepoint name reuse shadows the older savepoint",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT a" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SAVEPOINT a" },
    { sql: "INSERT INTO t VALUES (3)" },
    { sql: "ROLLBACK TO a" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "work continues normally after ROLLBACK TO",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO sp" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "ROLLBACK of whole transaction discards released savepoint work",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "RELEASE sp" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

sequenceParity(
  "savepoint over update and delete",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "UPDATE t SET v = 'z' WHERE id = 1" },
    { sql: "DELETE FROM t WHERE id = 2" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "ROLLBACK TO sp" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
