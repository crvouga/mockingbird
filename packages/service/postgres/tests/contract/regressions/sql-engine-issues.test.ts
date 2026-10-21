import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

/** The SQLSTATE of the error a statement raises (the engine's syntax-error wording differs from PostgreSQL's). */
const sqlStateOf = (sql: string, setup: string[] = []): string | undefined => {
  const db = new Database();
  for (const statement of setup) db.exec(statement);
  try {
    db.exec(sql);
  } catch (error) {
    return (error as { sqlState?: string }).sqlState;
  }
  return undefined;
};

// #528 self-referencing foreign keys in CREATE TABLE
sequenceParity(
  "#528 column-form and table-form self-referencing foreign keys",
  ["CREATE SCHEMA sf"],
  [
    { sql: "CREATE TABLE sf.a (id int PRIMARY KEY, parent_id int REFERENCES sf.a (id) ON DELETE SET NULL)" },
    { sql: "CREATE TABLE sf.b (id int PRIMARY KEY, parent_id int, FOREIGN KEY (parent_id) REFERENCES sf.b (id))" },
    { sql: "CREATE TABLE sf_c (id uuid PRIMARY KEY, parent_id uuid, FOREIGN KEY (parent_id) REFERENCES sf_c (id))" },
    {
      sql: `SELECT c.relname, con.conname, con.contype
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
            WHERE con.contype = 'f' AND c.relname IN ('a', 'b', 'sf_c') ORDER BY 1, 2`,
      query: true,
    },
    { sql: "INSERT INTO sf.a VALUES (1, NULL), (2, 1)" },
    { sql: "INSERT INTO sf.a VALUES (3, 99)" },
    { sql: "DELETE FROM sf.a WHERE id = 1" },
    { sql: "SELECT id, parent_id FROM sf.a ORDER BY id", query: true },
    { sql: "INSERT INTO sf.b VALUES (1, NULL), (2, 1)" },
    { sql: "DELETE FROM sf.b WHERE id = 1" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#528 self-reference without a column list takes the primary key declared later",
  [],
  [
    { sql: "CREATE TABLE tree (parent int REFERENCES tree, id int, PRIMARY KEY (id))" },
    {
      sql: `SELECT con.conname, con.contype FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid WHERE c.relname = 'tree' AND con.contype = 'f'`,
      query: true,
    },
    { sql: "INSERT INTO tree VALUES (NULL, 1), (1, 2)" },
    { sql: "INSERT INTO tree VALUES (7, 3)" },
  ],
);

sequenceParity(
  "#528 composite self-referencing key",
  [],
  [
    {
      sql: `CREATE TABLE node (a int, b int, pa int, pb int, PRIMARY KEY (a, b),
            CONSTRAINT node_parent FOREIGN KEY (pa, pb) REFERENCES node (a, b))`,
    },
    { sql: "INSERT INTO node VALUES (1, 1, NULL, NULL), (1, 2, 1, 1)" },
    { sql: "INSERT INTO node VALUES (2, 2, 1, 3)" },
  ],
);

errorParity(
  "#528 self-reference needs a unique key",
  [],
  "CREATE TABLE loose (id int, parent int REFERENCES loose)",
  "undefined_object",
);

// #530 locking clause before LIMIT / OFFSET
for (const [label, sql] of [
  ["SKIP LOCKED then LIMIT", "SELECT id FROM fu WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"],
  ["FOR UPDATE then LIMIT", "SELECT id FROM fu ORDER BY id FOR UPDATE LIMIT 1"],
  ["FOR UPDATE then LIMIT OFFSET", "SELECT id FROM fu ORDER BY id FOR UPDATE LIMIT 1 OFFSET 1"],
  ["FOR UPDATE then OFFSET LIMIT", "SELECT id FROM fu ORDER BY id FOR UPDATE OFFSET 1 LIMIT 1"],
  ["FOR UPDATE OF then LIMIT", "SELECT id FROM fu ORDER BY id FOR UPDATE OF fu SKIP LOCKED LIMIT 2 OFFSET 1"],
  ["FOR SHARE NOWAIT then FETCH", "SELECT id FROM fu ORDER BY id FOR SHARE NOWAIT FETCH FIRST 2 ROWS ONLY"],
  ["LIMIT then FOR UPDATE", "SELECT id FROM fu ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED"],
  ["subquery lock then LIMIT", "SELECT * FROM (SELECT id FROM fu ORDER BY id FOR UPDATE LIMIT 2) s ORDER BY id"],
] as const) {
  parity(
    `#530 ${label}`,
    [
      "CREATE TABLE fu (id int PRIMARY KEY, status text)",
      "INSERT INTO fu VALUES (1, 'pending'), (2, 'pending'), (3, 'done')",
    ],
    sql,
  );
}
test("#530 a locking clause on both sides of LIMIT is a syntax error (42601, as in PostgreSQL)", () => {
  expect(sqlStateOf("SELECT id FROM fu FOR UPDATE LIMIT 1 FOR UPDATE", ["CREATE TABLE fu (id int)"])).toBe("42601");
});

// #531 ALTER TYPE ... RENAME TO
const enumSetup = [
  "CREATE SCHEMA s",
  "CREATE TYPE s.mood AS ENUM ('a', 'b')",
  "CREATE TABLE s.t (id int PRIMARY KEY, m s.mood NOT NULL DEFAULT 'a'::s.mood, ms s.mood[])",
  "INSERT INTO s.t VALUES (1, 'b', ARRAY['a', 'b']::s.mood[])",
  "CREATE TYPE mood_x AS ENUM ('x')",
  "CREATE TYPE s.mood_x AS ENUM ('x')",
];
const typeNames = `SELECT n.nspname, t.typname, t.typtype, t.typcategory FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname IN ('s', 'public') AND t.typname LIKE '%mood%' AND t.typcategory = 'E' ORDER BY 1, 2`;
sequenceParity(
  "#531 rename an enum type and keep its columns, defaults and values",
  enumSetup,
  [
    { sql: "ALTER TYPE s.mood RENAME TO mood2" },
    { sql: typeNames, query: true },
    { sql: "SELECT id, m, ms FROM s.t", query: true },
    {
      sql: "SELECT column_name, udt_name, column_default FROM information_schema.columns WHERE table_schema = 's' AND table_name = 't' ORDER BY ordinal_position",
      query: true,
    },
    { sql: "SELECT pg_typeof(m)::text AS t, 'a'::s.mood2 AS lit FROM s.t", query: true },
    { sql: "INSERT INTO s.t (id) VALUES (2)" },
    { sql: "SELECT id, m FROM s.t ORDER BY id", query: true },
    { sql: "CREATE TYPE s.mood AS ENUM ('a')" },
  ],
  { compareFinalState: true },
);
sequenceParity(
  "#531 the Alembic recipe for dropping an enum value",
  [
    "CREATE TYPE blueprintstatus AS ENUM ('PENDING', 'COMPLETED', 'APPROVED')",
    "CREATE TABLE bp (id int PRIMARY KEY, status blueprintstatus NOT NULL DEFAULT 'PENDING')",
    "INSERT INTO bp VALUES (1, 'COMPLETED')",
  ],
  [
    { sql: "ALTER TYPE blueprintstatus RENAME TO blueprintstatus_old" },
    { sql: "CREATE TYPE blueprintstatus AS ENUM ('PENDING', 'APPROVED')" },
    {
      sql: `ALTER TABLE bp ALTER COLUMN status DROP DEFAULT,
        ALTER COLUMN status TYPE blueprintstatus USING (CASE WHEN status::text = 'COMPLETED' THEN 'PENDING' ELSE status::text END)::blueprintstatus,
        ALTER COLUMN status SET DEFAULT 'PENDING'::blueprintstatus`,
    },
    { sql: "DROP TYPE blueprintstatus_old" },
    { sql: "SELECT id, status FROM bp", query: true },
  ],
  { compareFinalState: true },
);
sequenceParity(
  "#531 rename inside a rolled-back transaction",
  enumSetup,
  [
    { sql: "BEGIN" },
    { sql: "ALTER TYPE s.mood RENAME TO mood2" },
    { sql: "ROLLBACK" },
    { sql: typeNames, query: true },
  ],
);
errorParity("#531 rename onto an existing type name", enumSetup, "ALTER TYPE s.mood RENAME TO mood_x", "duplicate_object");
errorParity("#531 rename a type that does not exist", enumSetup, "ALTER TYPE s.nope RENAME TO x", "undefined_object");
test("#531 the new name never carries a schema (42601, as in PostgreSQL)", () => {
  expect(sqlStateOf("ALTER TYPE s.mood RENAME TO public.mood3", enumSetup)).toBe("42601");
});
errorParity(
  "#531 rename onto the row type of a table",
  [...enumSetup, "CREATE TABLE s.tbl (id int)"],
  "ALTER TYPE s.mood RENAME TO tbl",
  "duplicate_object",
);
sequenceParity(
  "#531 a name held only by an array type or an index is free",
  [...enumSetup, "CREATE INDEX s_t_id ON s.t (id)"],
  [{ sql: "ALTER TYPE s.mood RENAME TO _mood_x" }, { sql: "ALTER TYPE s.mood_x RENAME TO s_t_id" }],
);
