import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "RELEASE keeps savepoint writes",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "SAVEPOINT s" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "RELEASE s" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
sequenceParity(
  "ROLLBACK TO discards later writes",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "SAVEPOINT s" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO s" },
    { sql: "RELEASE s" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
sequenceParity(
  "nested savepoints isolate inner rollback",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "SAVEPOINT outer" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT inner" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO inner" },
    { sql: "RELEASE inner" },
    { sql: "RELEASE outer" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
sequenceParity(
  "savepoint works inside explicit transaction",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT s" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO s" },
    { sql: "RELEASE s" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
