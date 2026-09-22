import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "duplicate index name",
  ["CREATE TABLE t (id int)", "CREATE INDEX t_idx ON t (id)"],
  "CREATE INDEX t_idx ON t (id)",
  "duplicate_object",
);

sequenceParity(
  "CREATE INDEX IF NOT EXISTS skips duplicate",
  ["CREATE TABLE t (id int)", "CREATE INDEX t_idx ON t (id)", "INSERT INTO t VALUES (1)"],
  [{ sql: "CREATE INDEX IF NOT EXISTS t_idx ON t (id)" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "index name collides with table name",
  ["CREATE TABLE t (id int)", "CREATE TABLE other (id int)"],
  "CREATE INDEX other ON t (id)",
  "duplicate_object",
);

errorParity("index on missing table", [], "CREATE INDEX idx ON missing_table (id)", "undefined_table");

errorParity(
  "index on missing column",
  ["CREATE TABLE t (id int)"],
  "CREATE INDEX idx ON t (ghost)",
  "undefined_column",
);

sequenceParity(
  "DROP INDEX IF EXISTS on missing index",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "DROP INDEX IF EXISTS ghost" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);
