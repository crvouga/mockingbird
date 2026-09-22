import { parity } from "../helpers.ts";

parity(
  "pg_attribute lists user columns in order",
  ["CREATE TABLE t (id int, name text, flag boolean)"],
  "SELECT a.attname, a.attnum FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);

parity(
  "pg_attribute attnotnull reflects NOT NULL",
  ["CREATE TABLE t (id int NOT NULL, v text)"],
  "SELECT a.attname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);

parity(
  "pg_attribute attnotnull true for primary key columns",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  "SELECT a.attname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);

parity(
  "pg_attribute joined to pg_type resolves column types",
  ["CREATE TABLE t (id int, name text, weight float8, big bigint)"],
  "SELECT a.attname, ty.typname FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid JOIN pg_type ty ON a.atttypid = ty.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);

parity(
  "pg_attribute count matches the column count",
  ["CREATE TABLE t (a int, b text, c boolean, d bigint)"],
  "SELECT count(*) AS n FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0",
);

parity(
  "pg_attribute for a table in a user schema",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (x int, y text)"],
  "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = 'app' AND c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);

parity(
  "pg_type has entries for builtin type names",
  [],
  "SELECT typname FROM pg_type WHERE typname IN ('int4', 'int8', 'text', 'bool') ORDER BY typname",
);

parity(
  "column added by ALTER TABLE appears in pg_attribute",
  ["CREATE TABLE t (id int)", "ALTER TABLE t ADD COLUMN extra text"],
  "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
);
