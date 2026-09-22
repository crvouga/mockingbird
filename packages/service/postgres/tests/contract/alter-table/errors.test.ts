import { errorParity } from "../helpers.ts";

errorParity("alter missing table", [], "ALTER TABLE missing_table ADD COLUMN v text", "undefined_table");

errorParity(
  "add duplicate column",
  ["CREATE TABLE t (id int)"],
  "ALTER TABLE t ADD COLUMN id text",
  "duplicate_object",
);

errorParity("drop missing column", ["CREATE TABLE t (id int)"], "ALTER TABLE t DROP COLUMN ghost", "undefined_column");

errorParity(
  "rename missing column",
  ["CREATE TABLE t (id int)"],
  "ALTER TABLE t RENAME COLUMN ghost TO ghost2",
  "undefined_column",
);

errorParity(
  "rename column to existing name",
  ["CREATE TABLE t (a int, b int)"],
  "ALTER TABLE t RENAME COLUMN a TO b",
  "duplicate_object",
);

errorParity(
  "rename table to existing name",
  ["CREATE TABLE a (id int)", "CREATE TABLE b (id int)"],
  "ALTER TABLE a RENAME TO b",
  "duplicate_object",
);

errorParity("drop missing constraint", ["CREATE TABLE t (id int)"], "ALTER TABLE t DROP CONSTRAINT ghost");

errorParity(
  "alter type of missing column",
  ["CREATE TABLE t (id int)"],
  "ALTER TABLE t ALTER COLUMN ghost TYPE text",
  "undefined_column",
);
