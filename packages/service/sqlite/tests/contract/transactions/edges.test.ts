import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "nested savepoint releases preserve all writes",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT outer_sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT inner_sp" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "RELEASE inner_sp" },
    { sql: "RELEASE outer_sp" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
sequenceParity(
  "rollback to savepoint then commit keeps earlier writes",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT s" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO s" },
    { sql: "RELEASE s" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
sequenceParity(
  "inner rollback does not discard outer savepoint writes",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "SAVEPOINT outer_sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SAVEPOINT inner_sp" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK TO inner_sp" },
    { sql: "RELEASE inner_sp" },
    { sql: "RELEASE outer_sp" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
sequenceParity(
  "released inner savepoint remains subject to outer rollback",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT outer_sp" },
    { sql: "SAVEPOINT inner_sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "RELEASE inner_sp" },
    { sql: "ROLLBACK TO outer_sp" },
    { sql: "RELEASE outer_sp" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
