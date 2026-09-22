import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "DROP SCHEMA without CASCADE fails when the schema has tables",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  "DROP SCHEMA app",
  "other",
);

errorParity(
  "DROP SCHEMA RESTRICT fails when the schema has tables",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  "DROP SCHEMA app RESTRICT",
  "other",
);

sequenceParity(
  "DROP SCHEMA CASCADE removes contained tables",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)", "INSERT INTO app.t VALUES (1)"],
  [
    { sql: "DROP SCHEMA app CASCADE" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
    { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
  ],
);

sequenceParity(
  "DROP SCHEMA CASCADE removes contained sequences and views",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.t (id int)",
    "CREATE VIEW app.v AS SELECT id FROM app.t",
    "CREATE SEQUENCE app.s",
  ],
  [
    { sql: "DROP SCHEMA app CASCADE" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname IN ('t', 'v', 's')", query: true },
  ],
);

sequenceParity(
  "DROP SCHEMA IF EXISTS on a missing schema is a no-op",
  [],
  [{ sql: "DROP SCHEMA IF EXISTS no_such_schema" }, { sql: "SELECT 1 AS v", query: true }],
);

sequenceParity(
  "cross-schema foreign key enforced",
  [
    "CREATE SCHEMA a",
    "CREATE TABLE a.parent (id int PRIMARY KEY)",
    "CREATE TABLE child (pid int REFERENCES a.parent(id))",
    "INSERT INTO a.parent VALUES (1)",
  ],
  [
    { sql: "INSERT INTO child VALUES (1)" },
    { sql: "INSERT INTO child VALUES (2)" },
    { sql: "SELECT * FROM child ORDER BY pid", query: true },
  ],
);

sequenceParity(
  "dropping one schema leaves same-named table in another schema",
  [
    "CREATE SCHEMA a",
    "CREATE SCHEMA b",
    "CREATE TABLE a.t (v text)",
    "CREATE TABLE b.t (v text)",
    "INSERT INTO b.t VALUES ('survives')",
  ],
  [{ sql: "DROP SCHEMA a CASCADE" }, { sql: "SELECT v FROM b.t", query: true }],
);

sequenceParity(
  "recreate schema after cascade drop",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  [
    { sql: "DROP SCHEMA app CASCADE" },
    { sql: "CREATE SCHEMA app" },
    { sql: "CREATE TABLE app.t (id int)" },
    { sql: "INSERT INTO app.t VALUES (9)" },
    { sql: "SELECT * FROM app.t", query: true },
  ],
);
