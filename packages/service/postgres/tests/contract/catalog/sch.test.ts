import { SCH_SECTION } from "../../../compat/sections/sch.ts";
import { runCatalog } from "./run.ts";

runCatalog(SCH_SECTION, [
  {
    id: "SCH-create-01",
    kind: "parity",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int, v text)", "INSERT INTO app.t VALUES (1, 'x')"],
    sql: "SELECT * FROM app.t",
  },
  {
    id: "SCH-create-02",
    kind: "sequence",
    setup: ["CREATE SCHEMA app"],
    steps: [
      { sql: "CREATE SCHEMA IF NOT EXISTS app" },
      { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
    ],
  },
  {
    id: "SCH-create-03",
    kind: "parity",
    setup: ["CREATE SCHEMA app"],
    sql: "SELECT nspname FROM pg_namespace WHERE nspname = 'app'",
  },
  {
    id: "SCH-qual-01",
    kind: "parity",
    setup: [
      "CREATE SCHEMA app",
      "CREATE TABLE app.items (id int, v text)",
      "INSERT INTO app.items VALUES (1, 'x')",
      "UPDATE app.items SET v = 'y' WHERE id = 1",
    ],
    sql: "SELECT * FROM app.items ORDER BY id",
  },
  {
    id: "SCH-qual-02",
    kind: "parity",
    setup: [
      "CREATE SCHEMA app",
      "CREATE TABLE app.items (id int)",
      "INSERT INTO app.items VALUES (1), (2)",
      "DELETE FROM app.items WHERE id = 1",
    ],
    sql: "SELECT * FROM app.items ORDER BY id",
  },
  {
    id: "SCH-dup-01",
    kind: "parity",
    setup: [
      "CREATE SCHEMA a",
      "CREATE SCHEMA b",
      "CREATE TABLE a.t (v text)",
      "CREATE TABLE b.t (v text)",
      "INSERT INTO a.t VALUES ('from a')",
      "INSERT INTO b.t VALUES ('from b')",
    ],
    sql: "SELECT (SELECT v FROM a.t) AS av, (SELECT v FROM b.t) AS bv",
  },
  {
    id: "SCH-join-01",
    kind: "parity",
    setup: [
      "CREATE SCHEMA a",
      "CREATE SCHEMA b",
      "CREATE TABLE a.users (id int, name text)",
      "CREATE TABLE b.orders (id int, user_id int, total int)",
      "INSERT INTO a.users VALUES (1, 'alice'), (2, 'bob')",
      "INSERT INTO b.orders VALUES (10, 1, 100), (11, 2, 200), (12, 1, 50)",
    ],
    sql: "SELECT u.name, sum(o.total) AS total FROM a.users u JOIN b.orders o ON o.user_id = u.id GROUP BY u.name ORDER BY u.name",
  },
  {
    id: "SCH-seq-01",
    kind: "parity",
    setup: ["CREATE SCHEMA app", "CREATE SEQUENCE app.seq START 7"],
    sql: "SELECT nextval('app.seq') AS v",
  },
  {
    id: "SCH-view-01",
    kind: "parity",
    setup: [
      "CREATE SCHEMA app",
      "CREATE TABLE app.t (id int)",
      "INSERT INTO app.t VALUES (1), (2)",
      "CREATE VIEW app.v AS SELECT id FROM app.t",
    ],
    sql: "SELECT * FROM app.v ORDER BY id",
  },
  {
    id: "SCH-fk-01",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA a",
      "CREATE TABLE a.parent (id int PRIMARY KEY)",
      "CREATE TABLE child (pid int REFERENCES a.parent(id))",
      "INSERT INTO a.parent VALUES (1)",
    ],
    steps: [
      { sql: "INSERT INTO child VALUES (1)" },
      { sql: "INSERT INTO child VALUES (2)" },
      { sql: "SELECT * FROM child ORDER BY pid", query: true },
    ],
  },
  {
    id: "SCH-drop-01",
    kind: "sequence",
    setup: ["CREATE SCHEMA app"],
    steps: [
      { sql: "DROP SCHEMA app" },
      { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
    ],
  },
  {
    id: "SCH-drop-02",
    kind: "error",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
    sql: "DROP SCHEMA app",
    messageTier: "A",
  },
  {
    id: "SCH-drop-03",
    kind: "sequence",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)", "INSERT INTO app.t VALUES (1)"],
    steps: [
      { sql: "DROP SCHEMA app CASCADE" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
      { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
    ],
  },
  {
    id: "SCH-drop-04",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA app",
      "CREATE TABLE app.t (id int)",
      "CREATE VIEW app.v AS SELECT id FROM app.t",
      "CREATE SEQUENCE app.s",
    ],
    steps: [
      { sql: "DROP SCHEMA app CASCADE" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname IN ('t', 'v', 's')", query: true },
    ],
  },
  {
    id: "SCH-drop-05",
    kind: "sequence",
    steps: [{ sql: "DROP SCHEMA IF EXISTS no_such_schema" }, { sql: "SELECT current_schema() AS s", query: true }],
  },
  {
    id: "SCH-drop-06",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA a",
      "CREATE SCHEMA b",
      "CREATE TABLE a.t (v text)",
      "CREATE TABLE b.t (v text)",
      "INSERT INTO b.t VALUES ('survives')",
    ],
    steps: [{ sql: "DROP SCHEMA a CASCADE" }, { sql: "SELECT v FROM b.t", query: true }],
  },
  {
    id: "SCH-path-01",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA a",
      "CREATE SCHEMA b",
      "CREATE TABLE a.t (v text)",
      "CREATE TABLE b.t (v text)",
      "INSERT INTO a.t VALUES ('a')",
      "INSERT INTO b.t VALUES ('b')",
    ],
    steps: [
      { sql: "SET search_path TO a, b" },
      { sql: "SELECT v FROM t", query: true },
      { sql: "SET search_path TO b, a" },
      { sql: "SELECT v FROM t", query: true },
    ],
  },
  {
    id: "SCH-path-02",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA a",
      "CREATE SCHEMA b",
      "CREATE TABLE b.only_b (v text)",
      "INSERT INTO b.only_b VALUES ('found')",
    ],
    steps: [{ sql: "SET search_path TO a, b" }, { sql: "SELECT v FROM only_b", query: true }],
  },
  {
    id: "SCH-path-03",
    kind: "sequence",
    setup: ["CREATE SCHEMA a"],
    steps: [
      { sql: "SET search_path TO a, public" },
      { sql: "CREATE TABLE created_here (id int)" },
      {
        sql: "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 'created_here'",
        query: true,
      },
    ],
  },
  {
    id: "SCH-path-04",
    kind: "sequence",
    setup: ["CREATE SCHEMA a"],
    steps: [
      { sql: "SELECT current_schema() AS v", query: true },
      { sql: "SET search_path TO a, public" },
      { sql: "SELECT current_schema() AS v", query: true },
    ],
  },
  {
    id: "SCH-path-05",
    kind: "sequence",
    setup: [
      "CREATE SCHEMA a",
      "CREATE TABLE a.t (v text)",
      "INSERT INTO a.t VALUES ('qualified')",
      "CREATE TABLE t (v text)",
      "INSERT INTO t VALUES ('public')",
    ],
    steps: [
      { sql: "SET search_path TO public" },
      { sql: "SELECT v FROM a.t", query: true },
      { sql: "SELECT v FROM t", query: true },
    ],
  },
  {
    id: "SCH-path-06",
    kind: "sequence",
    setup: ["CREATE SCHEMA a", "CREATE SCHEMA b"],
    steps: [{ sql: "SET search_path TO a, b, public" }, { sql: "SELECT current_schemas(false) AS v", query: true }],
  },
  {
    id: "SCH-cat-01",
    kind: "sequence",
    setup: ["CREATE SCHEMA lonely"],
    steps: [
      { sql: "SET search_path TO lonely" },
      { sql: "SELECT lower('ABC') AS lo, upper('x') AS up, length('abc') AS len", query: true },
    ],
  },
  {
    id: "SCH-cat-02",
    kind: "sequence",
    setup: ["CREATE SCHEMA lonely", "CREATE TABLE lonely.t (id int)"],
    steps: [
      { sql: "SET search_path TO lonely" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
    ],
  },
  {
    id: "SCH-alter-01",
    kind: "sequence",
    setup: ["CREATE SCHEMA app", "CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "ALTER TABLE t SET SCHEMA app" },
      { sql: "SELECT * FROM app.t", query: true },
      {
        sql: "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 't'",
        query: true,
      },
    ],
  },
  { id: "SCH-err-01", kind: "error", sql: "CREATE TABLE no_such_schema.t (id int)", messageTier: "A" },
  { id: "SCH-err-02", kind: "error", setup: ["CREATE SCHEMA app"], sql: "CREATE SCHEMA app", messageTier: "A" },
]);
