import { parity, sequenceParity } from "../helpers.ts";

parity(
  "ADD COLUMN extends existing rows with default",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1),(2)", "ALTER TABLE t ADD COLUMN label TEXT DEFAULT 'new'"],
  "SELECT * FROM t ORDER BY id",
);
sequenceParity(
  "renamed table remains queryable",
  ["CREATE TABLE old_name(id INTEGER)", "INSERT INTO old_name VALUES (1)"],
  [{ sql: "ALTER TABLE old_name RENAME TO new_name" }, { sql: "SELECT * FROM new_name", query: true }],
);
parity(
  "RENAME COLUMN preserves data",
  [
    "CREATE TABLE t(id INTEGER,old_name TEXT)",
    "INSERT INTO t VALUES (1,'value')",
    "ALTER TABLE t RENAME COLUMN old_name TO new_name",
  ],
  "SELECT id,new_name FROM t",
);
parity(
  "added nullable column is NULL for old rows",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)", "ALTER TABLE t ADD COLUMN note TEXT"],
  "SELECT id,note,typeof(note) kind FROM t",
);
