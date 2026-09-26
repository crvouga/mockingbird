import { parity, sequenceParity } from "../helpers.ts";

parity(
  "user table appears in pg_class with relkind r",
  ["CREATE TABLE t (id int)"],
  "SELECT relname, relkind FROM pg_class WHERE relname = 't'",
);

parity(
  "view appears in pg_class with relkind v",
  ["CREATE TABLE t (id int)", "CREATE VIEW myv AS SELECT id FROM t"],
  "SELECT relname, relkind FROM pg_class WHERE relname = 'myv'",
);

parity(
  "sequence appears in pg_class with relkind S",
  ["CREATE SEQUENCE seq_cat"],
  "SELECT relname, relkind FROM pg_class WHERE relname = 'seq_cat'",
);

parity(
  "pg_class joined to pg_namespace resolves the schema",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 't'",
);

parity(
  "user tables in public listed by namespace join",
  ["CREATE TABLE alpha (id int)", "CREATE TABLE beta (id int)"],
  "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname",
);

sequenceParity(
  "pg_class row disappears after DROP TABLE",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
    { sql: "DROP TABLE t" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
  ],
);

parity(
  "pg_tables shows the user table with its schema",
  ["CREATE TABLE t (id int)"],
  "SELECT schemaname, tablename FROM pg_tables WHERE tablename = 't'",
);

parity(
  "pg_tables for a table in a user schema",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  "SELECT schemaname, tablename FROM pg_tables WHERE tablename = 't'",
);

parity(
  "pg_views shows the user view",
  ["CREATE TABLE t (id int)", "CREATE VIEW myv AS SELECT id FROM t"],
  "SELECT viewname FROM pg_views WHERE viewname = 'myv'",
);

parity(
  "same relname in two schemas yields two pg_class rows",
  ["CREATE SCHEMA a", "CREATE SCHEMA b", "CREATE TABLE a.dup (id int)", "CREATE TABLE b.dup (id int)"],
  "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 'dup' ORDER BY n.nspname",
);
