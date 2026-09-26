import { ECO_SECTION } from "../../../compat/sections/eco.ts";
import { runCatalog } from "./run.ts";

const USERS = "CREATE TABLE users (id int PRIMARY KEY, email text UNIQUE, name text NOT NULL, age int)";

runCatalog(ECO_SECTION, [
  {
    id: "ECO-prisma-01",
    kind: "parity",
    setup: [USERS],
    sql: "SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position",
  },
  {
    id: "ECO-drizzle-01",
    kind: "parity",
    setup: [USERS],
    sql: "SELECT a.attname AS column_name, ty.typname AS type_name, a.attnotnull AS not_null FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid WHERE n.nspname = 'public' AND c.relname = 'users' AND a.attnum > 0 ORDER BY a.attnum",
  },
  {
    id: "ECO-kysely-01",
    kind: "parity",
    setup: [
      USERS,
      "CREATE TABLE posts (id int PRIMARY KEY, author_id int)",
      "CREATE VIEW adults AS SELECT * FROM users WHERE age >= 18",
    ],
    sql: "SELECT c.relname AS name, n.nspname AS schema, c.relkind = 'v' AS is_view FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'v') AND n.nspname = 'public' ORDER BY c.relname",
  },
  {
    id: "ECO-knex-01",
    kind: "sequence",
    setup: [USERS],
    steps: [
      {
        sql: "INSERT INTO users (id, email, name, age) VALUES ($1, $2, $3, $4) RETURNING *",
        params: [1, "a@x.com", "alice", 30],
        query: true,
      },
      {
        sql: "INSERT INTO users (id, email, name, age) VALUES ($1, $2, $3, $4) RETURNING id",
        params: [2, "b@x.com", "bob", 25],
        query: true,
      },
      { sql: "SELECT * FROM users WHERE age > $1 ORDER BY id", params: [20], query: true },
      { sql: "UPDATE users SET age = age + 1 WHERE id = $1 RETURNING id, age", params: [1], query: true },
      { sql: "DELETE FROM users WHERE id = $1", params: [2] },
      { sql: "SELECT count(*) AS n FROM users", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "ECO-typeorm-01",
    kind: "parity",
    setup: [USERS],
    sql: "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name WHERE tc.table_name = 'users' AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') ORDER BY tc.constraint_name, kcu.column_name",
  },
  {
    id: "ECO-mig-01",
    kind: "sequence",
    steps: [
      { sql: "BEGIN" },
      { sql: "CREATE TABLE migrations (id int PRIMARY KEY, name text NOT NULL)" },
      { sql: "CREATE TABLE accounts (id serial PRIMARY KEY, owner text NOT NULL)" },
      { sql: "INSERT INTO migrations VALUES (1, '0001_create_accounts')" },
      { sql: "COMMIT" },
      {
        sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        query: true,
      },
      { sql: "SELECT * FROM migrations", query: true },
    ],
  },
  {
    id: "ECO-crud-01",
    kind: "sequence",
    setup: ["CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL, done boolean DEFAULT false)"],
    steps: [
      { sql: "INSERT INTO items (label) VALUES ($1) RETURNING id, label, done", params: ["first"], query: true },
      { sql: "INSERT INTO items (label) VALUES ($1) RETURNING id", params: ["second"], query: true },
      { sql: "UPDATE items SET done = true WHERE id = $1 RETURNING *", params: [1], query: true },
      { sql: "SELECT id, label, done FROM items ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "ECO-intro-01",
    kind: "parity",
    setup: [USERS, "CREATE TABLE posts (id int)"],
    sql: "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  },
  {
    id: "ECO-intro-02",
    kind: "parity",
    setup: ["CREATE TABLE items (id serial PRIMARY KEY)"],
    sql: "SELECT schemaname, sequencename FROM pg_sequences ORDER BY sequencename",
  },
  {
    id: "ECO-param-01",
    kind: "parity",
    setup: ["CREATE TABLE t (a int, b text, c boolean)", "INSERT INTO t VALUES (1, 'x', true), (2, 'y', false)"],
    sql: "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3",
    params: [1, "x", true],
  },
]);
