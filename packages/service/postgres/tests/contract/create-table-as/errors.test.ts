import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "CTAS into existing table name",
  ["CREATE TABLE t (id int)"],
  "CREATE TABLE t AS SELECT 1 AS id",
  "duplicate_object",
);

sequenceParity(
  "CTAS IF NOT EXISTS skips existing",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (7)"],
  [{ sql: "CREATE TABLE IF NOT EXISTS t AS SELECT 99 AS id" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity("CTAS from missing table", [], "CREATE TABLE t AS SELECT * FROM missing_src", "undefined_table");

errorParity("CTAS from query with error", [], "CREATE TABLE t AS SELECT 1 / 0 AS v", "division_by_zero");
