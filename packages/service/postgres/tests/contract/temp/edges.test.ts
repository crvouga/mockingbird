// Unique temp-table names + trailing DROPs: the shared oracle session keeps
// pg_temp contents across tests.
import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "temp table not listed in public schema",
  ["CREATE TEMP TABLE tmp_e3 (id int)", "CREATE TABLE p (id int)"],
  [
    {
      sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      query: true,
    },
    { sql: "DROP TABLE tmp_e3" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table survives rollback of later transaction",
  ["CREATE TEMP TABLE tmp_e4 (id int)", "INSERT INTO tmp_e4 VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO tmp_e4 VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT id FROM tmp_e4 ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_e4" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table created inside rolled-back transaction disappears",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TEMP TABLE tmp_e5 (id int)" },
    { sql: "INSERT INTO tmp_e5 VALUES (1)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) FROM tmp_e5", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table CTAS",
  ["CREATE TABLE src_e6 (id int)", "INSERT INTO src_e6 VALUES (1), (2)"],
  [
    { sql: "CREATE TEMP TABLE tmp_e6 AS SELECT id FROM src_e6" },
    { sql: "SELECT id FROM tmp_e6 ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_e6" },
  ],
  { compareFinalState: true },
);
