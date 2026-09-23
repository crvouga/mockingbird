import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "DROP COLUMN removes column and preserves remaining data",
  [
    "CREATE TABLE t(id INTEGER, name TEXT, note TEXT)",
    "INSERT INTO t VALUES (1,'a','x'),(2,'b','y')",
    "ALTER TABLE t DROP COLUMN note",
  ],
  "SELECT id,name FROM t ORDER BY id",
);

sequenceParity(
  "DROP COLUMN works after dependent index is dropped",
  [
    "CREATE TABLE t(id INTEGER, name TEXT, note TEXT)",
    "CREATE INDEX t_note ON t(note)",
    "INSERT INTO t VALUES (1,'a','x')",
  ],
  [
    { sql: "DROP INDEX t_note" },
    { sql: "ALTER TABLE t DROP COLUMN note" },
    { sql: "SELECT id,name FROM t", query: true },
  ],
);

errorParity(
  "DROP COLUMN rejects column referenced by an index",
  ["CREATE TABLE t(id INTEGER, name TEXT, note TEXT)", "CREATE INDEX t_note ON t(note)"],
  "ALTER TABLE t DROP COLUMN note",
);

errorParity(
  "DROP COLUMN rejects primary key column",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"],
  "ALTER TABLE t DROP COLUMN id",
);

errorParity(
  "DROP COLUMN rejects UNIQUE column",
  ["CREATE TABLE t(id INTEGER, name TEXT UNIQUE)"],
  "ALTER TABLE t DROP COLUMN name",
);

errorParity(
  "DROP COLUMN rejects table-level UNIQUE column",
  ["CREATE TABLE t(id INTEGER, name TEXT, UNIQUE(name))"],
  "ALTER TABLE t DROP COLUMN name",
);

errorParity(
  "DROP COLUMN rejects dropping the last column",
  ["CREATE TABLE t(id INTEGER)"],
  "ALTER TABLE t DROP COLUMN id",
);

errorParity(
  "DROP COLUMN rejects missing column",
  ["CREATE TABLE t(id INTEGER, name TEXT)"],
  "ALTER TABLE t DROP COLUMN missing",
  "no_such_column",
);
