import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "ADD COLUMN nullable",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN v text" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    { sql: "INSERT INTO t VALUES (3, 'new')" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ADD COLUMN with default backfills",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "ALTER TABLE t ADD COLUMN n int DEFAULT 42" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "ADD COLUMN IF NOT EXISTS skips existing",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a')"],
  [{ sql: "ALTER TABLE t ADD COLUMN IF NOT EXISTS v text" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DROP COLUMN removes data",
  ["CREATE TABLE t (id int, v text, extra int)", "INSERT INTO t VALUES (1, 'a', 10)"],
  [{ sql: "ALTER TABLE t DROP COLUMN extra" }, { sql: "SELECT * FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DROP COLUMN IF EXISTS on missing column is a no-op",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "ALTER TABLE t DROP COLUMN IF EXISTS ghost" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "RENAME COLUMN preserves data",
  ["CREATE TABLE t (id int, old_name text)", "INSERT INTO t VALUES (1, 'x')"],
  [
    { sql: "ALTER TABLE t RENAME COLUMN old_name TO new_name" },
    { sql: "SELECT id, new_name FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "RENAME TABLE preserves data",
  ["CREATE TABLE old_t (id int)", "INSERT INTO old_t VALUES (1)"],
  [{ sql: "ALTER TABLE old_t RENAME TO new_t" }, { sql: "SELECT id FROM new_t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "add then drop column round trip",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN tmp int DEFAULT 0" },
    { sql: "UPDATE t SET tmp = 5" },
    { sql: "ALTER TABLE t DROP COLUMN tmp" },
    { sql: "SELECT * FROM t", query: true },
  ],
  { compareFinalState: true },
);
