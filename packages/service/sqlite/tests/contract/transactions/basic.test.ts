import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "COMMIT persists transaction writes",
  ["CREATE TABLE t(id INTEGER)"],
  [{ sql: "BEGIN" }, { sql: "INSERT INTO t VALUES (1)" }, { sql: "COMMIT" }, { sql: "SELECT * FROM t", query: true }],
);
sequenceParity(
  "ROLLBACK discards transaction writes",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
parity(
  "multiple writes commit atomically",
  ["CREATE TABLE t(id INTEGER)", "BEGIN", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)", "COMMIT"],
  "SELECT * FROM t ORDER BY id",
);
sequenceParity(
  "rolled-back update restores old value",
  ["CREATE TABLE t(id INTEGER,v TEXT)", "INSERT INTO t VALUES (1,'old')"],
  [{ sql: "BEGIN" }, { sql: "UPDATE t SET v='new'" }, { sql: "ROLLBACK" }, { sql: "SELECT * FROM t", query: true }],
);

sequenceParity(
  "ROLLBACK preserves total_changes and last_insert_rowid",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)", "INSERT INTO t VALUES (1, 1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (2, 2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT total_changes() AS t, last_insert_rowid() AS r", query: true },
    { sql: "INSERT INTO t VALUES (3, 3)" },
    { sql: "SELECT total_changes() AS t, id FROM t ORDER BY id", query: true },
  ],
);
