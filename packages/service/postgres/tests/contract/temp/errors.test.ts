// Unique temp-table names: errorParity setups cannot drop their temp tables,
// and the shared oracle session keeps pg_temp contents across tests.
import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "temp unique violation",
  ["CREATE TEMP TABLE tmp_x1 (id int UNIQUE)", "INSERT INTO tmp_x1 VALUES (1)"],
  "INSERT INTO tmp_x1 VALUES (1)",
  "constraint_unique",
);

errorParity(
  "temp not-null violation",
  ["CREATE TEMP TABLE tmp_x2 (id int NOT NULL)"],
  "INSERT INTO tmp_x2 VALUES (NULL)",
  "constraint_notnull",
);

errorParity(
  "temp check violation",
  ["CREATE TEMP TABLE tmp_x3 (n int CHECK (n > 0))"],
  "INSERT INTO tmp_x3 VALUES (0)",
  "constraint_check",
);

errorParity(
  "duplicate temp table name",
  ["CREATE TEMP TABLE tmp_x4 (id int)"],
  "CREATE TEMP TABLE tmp_x4 (id int)",
  "duplicate_object",
);

sequenceParity(
  "query after drop fails identically",
  ["CREATE TEMP TABLE tmp_x5 (id int)"],
  [{ sql: "DROP TABLE tmp_x5" }, { sql: "SELECT * FROM tmp_x5", query: true }, { sql: "DROP TABLE IF EXISTS tmp_x5" }],
  { compareFinalState: true },
);

errorParity(
  "temp primary key violation",
  ["CREATE TEMP TABLE tmp_x6 (id int PRIMARY KEY)", "INSERT INTO tmp_x6 VALUES (1)"],
  "INSERT INTO tmp_x6 VALUES (1)",
  "constraint_unique",
);
