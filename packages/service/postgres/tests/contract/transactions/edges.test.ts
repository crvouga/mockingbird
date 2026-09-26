import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "BEGIN inside a transaction is tolerated with a warning",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "nested BEGIN does not create a nested transaction (single ROLLBACK undoes all)",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

sequenceParity(
  "COMMIT outside a transaction is tolerated",
  ["CREATE TABLE t (id int)"],
  [{ sql: "COMMIT" }, { sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT * FROM t", query: true }],
);

sequenceParity(
  "ROLLBACK outside a transaction is tolerated",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "ROLLBACK" }, { sql: "SELECT * FROM t", query: true }],
);

sequenceParity(
  "ROLLBACK works after a failed statement inside a transaction",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT 1/0" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

sequenceParity(
  "failed statement outside txn does not affect committed data",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "constraint failure then ROLLBACK undoes the whole transaction",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "data committed before a later rollback survives",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "BEGIN" },
    { sql: "DELETE FROM t" },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
