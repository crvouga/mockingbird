import { parity, sequenceParity } from "../helpers.ts";

parity(
  "information_schema.tables reports the user table",
  ["CREATE TABLE t (id int)"],
  "SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables WHERE table_name = 't'",
);

parity(
  "information_schema.tables reports views as VIEW",
  ["CREATE TABLE t (id int)", "CREATE VIEW infv AS SELECT id FROM t"],
  "SELECT table_name, table_type FROM information_schema.tables WHERE table_name = 'infv'",
);

parity(
  "information_schema.columns basic shape",
  ["CREATE TABLE t (id int NOT NULL, name varchar(10), flag boolean)"],
  "SELECT column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
);

parity(
  "information_schema.columns ordinal positions",
  ["CREATE TABLE t (a int, b text, c bigint)"],
  "SELECT column_name, ordinal_position FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
);

parity(
  "information_schema.columns for a table in a user schema",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (x int, y text)"],
  "SELECT table_schema, column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 't' ORDER BY ordinal_position",
);

parity(
  "information_schema.columns numeric types",
  ["CREATE TABLE t (i int, b bigint, s smallint, r real, d double precision, n numeric(10,2))"],
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
);

sequenceParity(
  "information_schema reflects ALTER TABLE ADD and DROP COLUMN",
  ["CREATE TABLE t (id int, temp text)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN extra bigint" },
    {
      sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
      query: true,
    },
    { sql: "ALTER TABLE t DROP COLUMN temp" },
    {
      sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
      query: true,
    },
  ],
);

parity(
  "information_schema.sequences reports the user sequence",
  ["CREATE SEQUENCE s START 5 INCREMENT BY 2"],
  "SELECT sequence_schema, sequence_name, start_value, increment FROM information_schema.sequences WHERE sequence_name = 's'",
);

parity(
  "dropped table vanishes from information_schema.tables",
  ["CREATE TABLE t (id int)", "DROP TABLE t"],
  "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 't'",
);
