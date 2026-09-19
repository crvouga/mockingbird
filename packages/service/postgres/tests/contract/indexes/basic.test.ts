import { errorParity, parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "CREATE INDEX does not change query results",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  [
    { sql: "CREATE INDEX t_id_idx ON t (id)" },
    { sql: "SELECT id, v FROM t WHERE id = 2", query: true },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "unique index rejects duplicates",
  ["CREATE TABLE t (email text)", "CREATE UNIQUE INDEX t_email_idx ON t (email)", "INSERT INTO t VALUES ('a@x.com')"],
  "INSERT INTO t VALUES ('a@x.com')",
  "constraint_unique",
);

sequenceParity(
  "unique index allows distinct values and nulls",
  ["CREATE TABLE t (v text)", "CREATE UNIQUE INDEX t_v ON t (v)"],
  [
    { sql: "INSERT INTO t VALUES ('a'), ('b'), (NULL), (NULL)" },
    { sql: "SELECT v FROM t ORDER BY v NULLS LAST", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "multi-column unique index rejects duplicate pair",
  ["CREATE TABLE t (a int, b int)", "CREATE UNIQUE INDEX t_ab ON t (a, b)", "INSERT INTO t VALUES (1, 2)"],
  "INSERT INTO t VALUES (1, 2)",
  "constraint_unique",
);

sequenceParity(
  "DROP INDEX lifts uniqueness",
  ["CREATE TABLE t (id int)", "CREATE UNIQUE INDEX t_id ON t (id)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "DROP INDEX t_id" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "index on existing data with updates",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  [
    { sql: "CREATE INDEX t_v ON t (v)" },
    { sql: "UPDATE t SET v = 'z' WHERE id = 1" },
    { sql: "SELECT id, v FROM t WHERE v = 'z'", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "unique index enforced through upsert path",
  ["CREATE TABLE t (id int, v text)", "CREATE UNIQUE INDEX t_id ON t (id)", "INSERT INTO t VALUES (1, 'old')"],
  "INSERT INTO t VALUES (1, 'new') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v RETURNING id, v",
);

sequenceParity(
  "upsert then secondary-column equality still returns the row",
  [
    "CREATE TABLE t (id int PRIMARY KEY, user_id text, v text)",
    "CREATE INDEX t_user ON t (user_id)",
    "INSERT INTO t VALUES (1, 'bob', 'old')",
  ],
  [
    {
      sql: "INSERT INTO t VALUES (1, 'bob', 'new') ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, v = EXCLUDED.v",
    },
    { sql: "SELECT id, v FROM t WHERE user_id = $1", query: true, params: ["bob"] },
  ],
);
