import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "INSERT OR ROLLBACK rolls back the active transaction",
  ["CREATE TABLE t(v INTEGER UNIQUE)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "INSERT OR ROLLBACK INTO t VALUES (1)" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "INSERT OR FAIL preserves earlier rows from the statement",
  ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT OR FAIL INTO t VALUES (2),(1),(3)" },
    { sql: "SELECT * FROM t ORDER BY v", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "UPDATE OR FAIL preserves earlier row updates",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)", "INSERT INTO t VALUES (1,10),(2,20),(3,30)"],
  [
    { sql: "BEGIN" },
    { sql: "UPDATE OR FAIL t SET v=15 WHERE id IN (1,2)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);
