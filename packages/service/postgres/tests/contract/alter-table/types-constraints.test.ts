import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "ALTER COLUMN TYPE int to bigint",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 100)"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN n TYPE bigint" },
    { sql: "SELECT id, n, pg_typeof(n)::text AS ty FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ALTER COLUMN TYPE int to text",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (42)"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN n TYPE text" },
    { sql: "SELECT n, pg_typeof(n)::text AS ty FROM t", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ALTER COLUMN TYPE with USING expression",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('10'), ('20')"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN v TYPE int USING v::int * 2" },
    { sql: "SELECT v FROM t ORDER BY v", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "ALTER COLUMN TYPE without valid cast fails",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('abc')"],
  "ALTER TABLE t ALTER COLUMN v TYPE int USING v::int",
  "invalid_text_representation",
);

sequenceParity(
  "DROP NOT NULL allows nulls afterwards",
  ["CREATE TABLE t (id int, v text NOT NULL)", "INSERT INTO t VALUES (1, 'x')"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN v DROP NOT NULL" },
    { sql: "INSERT INTO t VALUES (2, NULL)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ADD CONSTRAINT CHECK enforced on new rows",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (5)"],
  [{ sql: "ALTER TABLE t ADD CONSTRAINT n_pos CHECK (n > 0)" }, { sql: "SELECT n FROM t", query: true }],
  { compareFinalState: true },
);

errorParity(
  "check added via ALTER enforced on insert",
  ["CREATE TABLE t (n int)", "ALTER TABLE t ADD CONSTRAINT n_pos CHECK (n > 0)"],
  "INSERT INTO t VALUES (0)",
  "constraint_check",
);

sequenceParity(
  "ADD CONSTRAINT UNIQUE then DROP CONSTRAINT",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "ALTER TABLE t ADD CONSTRAINT t_id_uniq UNIQUE (id)" },
    { sql: "ALTER TABLE t DROP CONSTRAINT t_id_uniq" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "unique added via ALTER enforced on insert",
  ["CREATE TABLE t (id int)", "ALTER TABLE t ADD CONSTRAINT t_id_uniq UNIQUE (id)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

errorParity(
  "foreign key added via ALTER enforced on insert",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "CREATE TABLE child (pid int)",
    "ALTER TABLE child ADD CONSTRAINT child_fk FOREIGN KEY (pid) REFERENCES parent(id)",
  ],
  "INSERT INTO child VALUES (1)",
  "constraint_foreign",
);
