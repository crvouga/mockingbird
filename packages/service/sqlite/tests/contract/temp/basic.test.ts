import { parity, sequenceParity } from "../helpers.ts";

parity(
  "CREATE TEMP TABLE stores and queries rows",
  ["CREATE TEMP TABLE t(id INTEGER, name TEXT)", "INSERT INTO t VALUES (1,'temp')"],
  "SELECT id,name FROM t",
);

parity(
  "CREATE TEMPORARY TABLE is accepted",
  ["CREATE TEMPORARY TABLE t(id INTEGER)", "INSERT INTO t VALUES (3)"],
  "SELECT id FROM t",
);

sequenceParity(
  "DROP TABLE removes temp table",
  ["CREATE TEMP TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  [{ sql: "DROP TABLE t" }, { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", query: true }],
);

sequenceParity(
  "temp table coexists with main table of different name",
  [
    "CREATE TABLE main_t(id INTEGER)",
    "CREATE TEMP TABLE temp_t(id INTEGER)",
    "INSERT INTO main_t VALUES (1)",
    "INSERT INTO temp_t VALUES (2)",
  ],
  [
    { sql: "SELECT id FROM main_t", query: true },
    { sql: "SELECT id FROM temp_t", query: true },
  ],
);
