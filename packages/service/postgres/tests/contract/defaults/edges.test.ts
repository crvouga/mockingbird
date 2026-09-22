import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "DEFAULT VALUES uses every default",
  ["CREATE TABLE t (a int DEFAULT 1, b text DEFAULT 'x', c boolean DEFAULT false)", "INSERT INTO t DEFAULT VALUES"],
  "SELECT a, b, c FROM t",
);

parity(
  "DEFAULT VALUES with no defaults inserts nulls",
  ["CREATE TABLE t (a int, b text)", "INSERT INTO t DEFAULT VALUES"],
  "SELECT a, b FROM t",
);

sequenceParity(
  "mixed DEFAULT keyword positions across rows",
  ["CREATE TABLE t (a int DEFAULT 1, b int DEFAULT 2)"],
  [
    { sql: "INSERT INTO t VALUES (DEFAULT, 20), (10, DEFAULT), (DEFAULT, DEFAULT)" },
    { sql: "SELECT a, b FROM t ORDER BY a, b", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "default respects assignment cast",
  ["CREATE TABLE t (id int, n int DEFAULT 3.6)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, n FROM t",
);

errorParity(
  "default violating check caught on insert",
  ["CREATE TABLE t (id int, n int DEFAULT -1 CHECK (n > 0))"],
  "INSERT INTO t (id) VALUES (1)",
  "constraint_check",
);

errorParity(
  "default null violating not-null caught on insert",
  ["CREATE TABLE t (id int, v text NOT NULL)"],
  "INSERT INTO t (id) VALUES (1)",
  "constraint_notnull",
);

sequenceParity(
  "ADD COLUMN with DEFAULT backfills existing rows",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN v text DEFAULT 'backfilled'" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "default referencing other defaults evaluates independently",
  ["CREATE TABLE t (a int DEFAULT 5, b int DEFAULT 5 * 2)", "INSERT INTO t DEFAULT VALUES"],
  "SELECT a, b FROM t",
);
