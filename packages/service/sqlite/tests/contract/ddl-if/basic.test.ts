import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "CREATE TABLE IF NOT EXISTS is a no-op when table exists",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  [{ sql: "CREATE TABLE IF NOT EXISTS t(id INTEGER, name TEXT)" }, { sql: "SELECT * FROM t", query: true }],
);

sequenceParity(
  "CREATE INDEX IF NOT EXISTS is a no-op when index exists",
  ["CREATE TABLE t(id INTEGER)", "CREATE INDEX t_id ON t(id)"],
  [
    { sql: "CREATE INDEX IF NOT EXISTS t_id ON t(id)" },
    { sql: "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name", query: true },
  ],
);

sequenceParity(
  "CREATE VIEW IF NOT EXISTS is a no-op when view exists",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (7)", "CREATE VIEW v AS SELECT id FROM t"],
  [{ sql: "CREATE VIEW IF NOT EXISTS v AS SELECT id+1 AS id FROM t" }, { sql: "SELECT * FROM v", query: true }],
);

sequenceParity(
  "DROP TABLE IF EXISTS succeeds for missing table",
  [],
  [
    { sql: "DROP TABLE IF EXISTS missing_table" },
    { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", query: true },
  ],
);

sequenceParity(
  "DROP TABLE IF EXISTS removes existing table",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "DROP TABLE IF EXISTS t" },
    { sql: "DROP TABLE IF EXISTS t" },
    { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", query: true },
  ],
);

sequenceParity(
  "DROP INDEX IF EXISTS succeeds for missing index",
  ["CREATE TABLE t(id INTEGER)"],
  [
    { sql: "DROP INDEX IF EXISTS missing_idx" },
    { sql: "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name", query: true },
  ],
);

sequenceParity(
  "DROP VIEW IF EXISTS succeeds for missing view",
  [],
  [
    { sql: "DROP VIEW IF EXISTS missing_view" },
    { sql: "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name", query: true },
  ],
);
