// NOTE: the PGlite oracle session is shared across tests and its reset keeps
// pg_temp schemas, so every temp table here uses a unique name and is dropped
// at the end of its test to avoid cross-test leakage.
import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "temp table insert and select",
  ["CREATE TEMP TABLE tmp_b1 (id int, v text)"],
  [
    { sql: "INSERT INTO tmp_b1 VALUES (1, 'a'), (2, 'b')" },
    { sql: "SELECT id, v FROM tmp_b1 ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_b1" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "TEMPORARY keyword spelling",
  ["CREATE TEMPORARY TABLE tmp_b2 (id int)"],
  [
    { sql: "INSERT INTO tmp_b2 VALUES (1)" },
    { sql: "SELECT id FROM tmp_b2", query: true },
    { sql: "DROP TABLE tmp_b2" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table full DML cycle",
  ["CREATE TEMP TABLE tmp_b3 (id int PRIMARY KEY, v text)"],
  [
    { sql: "INSERT INTO tmp_b3 VALUES (1, 'a'), (2, 'b')" },
    { sql: "UPDATE tmp_b3 SET v = 'z' WHERE id = 1" },
    { sql: "DELETE FROM tmp_b3 WHERE id = 2" },
    { sql: "SELECT id, v FROM tmp_b3 ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_b3" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table with defaults and constraints",
  ["CREATE TEMP TABLE tmp_b4 (id int PRIMARY KEY, v text DEFAULT 'dv', n int CHECK (n >= 0))"],
  [
    { sql: "INSERT INTO tmp_b4 (id, n) VALUES (1, 5)" },
    { sql: "SELECT id, v, n FROM tmp_b4", query: true },
    { sql: "DROP TABLE tmp_b4" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp serial sequence",
  ["CREATE TEMP TABLE tmp_b5 (id serial, v text)"],
  [
    { sql: "INSERT INTO tmp_b5 (v) VALUES ('a'), ('b')" },
    { sql: "SELECT id, v FROM tmp_b5 ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_b5" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "temp table join with permanent table",
  [
    "CREATE TABLE perm (id int, v text)",
    "INSERT INTO perm VALUES (1, 'p1'), (2, 'p2')",
    "CREATE TEMP TABLE tmp_b6 (id int)",
    "INSERT INTO tmp_b6 VALUES (2)",
  ],
  [
    { sql: "SELECT perm.id, perm.v FROM perm JOIN tmp_b6 ON perm.id = tmp_b6.id", query: true },
    { sql: "DROP TABLE tmp_b6" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "insert from temp into permanent",
  ["CREATE TABLE dest (id int)", "CREATE TEMP TABLE tmp_b7 (id int)", "INSERT INTO tmp_b7 VALUES (1), (2)"],
  [
    { sql: "INSERT INTO dest SELECT id FROM tmp_b7" },
    { sql: "SELECT id FROM dest ORDER BY id", query: true },
    { sql: "DROP TABLE tmp_b7" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DROP temp table makes it unreachable",
  ["CREATE TEMP TABLE tmp_b8 (id int)", "INSERT INTO tmp_b8 VALUES (1)"],
  [{ sql: "DROP TABLE tmp_b8" }, { sql: "SELECT count(*) FROM tmp_b8", query: true }],
  { compareFinalState: true },
);
