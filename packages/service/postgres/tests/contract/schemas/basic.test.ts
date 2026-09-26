import { parity, sequenceParity } from "../helpers.ts";

parity(
  "create schema and a table inside it",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int, v text)", "INSERT INTO app.t VALUES (1, 'x')"],
  "SELECT * FROM app.t",
);

parity(
  "schema appears in pg_namespace",
  ["CREATE SCHEMA app"],
  "SELECT nspname FROM pg_namespace WHERE nspname = 'app'",
);

parity(
  "qualified insert update select",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.items (id int, v text)",
    "INSERT INTO app.items VALUES (1, 'x')",
    "UPDATE app.items SET v = 'y' WHERE id = 1",
  ],
  "SELECT * FROM app.items ORDER BY id",
);

parity(
  "qualified delete",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.items (id int)",
    "INSERT INTO app.items VALUES (1), (2)",
    "DELETE FROM app.items WHERE id = 1",
  ],
  "SELECT * FROM app.items ORDER BY id",
);

parity(
  "same table name in two schemas holds separate data",
  [
    "CREATE SCHEMA a",
    "CREATE SCHEMA b",
    "CREATE TABLE a.t (v text)",
    "CREATE TABLE b.t (v text)",
    "INSERT INTO a.t VALUES ('from a')",
    "INSERT INTO b.t VALUES ('from b')",
  ],
  "SELECT (SELECT v FROM a.t) AS av, (SELECT v FROM b.t) AS bv",
);

sequenceParity(
  "CREATE SCHEMA IF NOT EXISTS is idempotent",
  ["CREATE SCHEMA app"],
  [
    { sql: "CREATE SCHEMA IF NOT EXISTS app" },
    { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
  ],
);

sequenceParity(
  "CREATE TABLE IF NOT EXISTS inside a schema",
  ["CREATE SCHEMA app", "CREATE TABLE IF NOT EXISTS app.t (id int)"],
  [
    { sql: "CREATE TABLE IF NOT EXISTS app.t (id int)" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
  ],
);

parity(
  "join across schemas",
  [
    "CREATE SCHEMA a",
    "CREATE SCHEMA b",
    "CREATE TABLE a.users (id int, name text)",
    "CREATE TABLE b.orders (id int, user_id int, total int)",
    "INSERT INTO a.users VALUES (1, 'alice'), (2, 'bob')",
    "INSERT INTO b.orders VALUES (10, 1, 100), (11, 2, 200), (12, 1, 50)",
  ],
  "SELECT u.name, sum(o.total) AS total FROM a.users u JOIN b.orders o ON o.user_id = u.id GROUP BY u.name ORDER BY u.name",
);

parity(
  "sequence inside a schema",
  ["CREATE SCHEMA app", "CREATE SEQUENCE app.seq START 7"],
  "SELECT nextval('app.seq') AS v",
);

parity(
  "view inside a schema",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.t (id int)",
    "INSERT INTO app.t VALUES (1), (2)",
    "CREATE VIEW app.v AS SELECT id FROM app.t",
  ],
  "SELECT * FROM app.v ORDER BY id",
);

sequenceParity(
  "DROP SCHEMA removes an empty schema",
  ["CREATE SCHEMA app"],
  [{ sql: "DROP SCHEMA app" }, { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true }],
);
