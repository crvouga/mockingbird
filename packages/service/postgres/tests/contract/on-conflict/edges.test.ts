import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "WHERE on DO UPDATE action filters update",
  ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 10), (2, 100)"],
  [
    {
      sql: "INSERT INTO t VALUES (1, 50), (2, 50) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n WHERE t.n < 50",
    },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO UPDATE partial column update",
  ["CREATE TABLE t (id int PRIMARY KEY, a int, b int)", "INSERT INTO t VALUES (1, 10, 20)"],
  [
    { sql: "INSERT INTO t VALUES (1, 99, 99) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a" },
    { sql: "SELECT id, a, b FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO UPDATE with expression over both rows",
  ["CREATE TABLE t (id int PRIMARY KEY, hits int, last text)", "INSERT INTO t VALUES (1, 1, 'a')"],
  [
    {
      sql: "INSERT INTO t VALUES (1, 1, 'b') ON CONFLICT (id) DO UPDATE SET hits = t.hits + 1, last = EXCLUDED.last",
    },
    {
      sql: "INSERT INTO t VALUES (1, 1, 'c') ON CONFLICT (id) DO UPDATE SET hits = t.hits + 1, last = EXCLUDED.last",
    },
    { sql: "SELECT id, hits, last FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "conflict on unique partial index target",
  [
    "CREATE TABLE t (id int, active boolean, v text)",
    "CREATE UNIQUE INDEX t_active_id ON t (id) WHERE active",
    "INSERT INTO t VALUES (1, true, 'live'), (1, false, 'archived')",
  ],
  [
    { sql: "INSERT INTO t VALUES (1, true, 'updated') ON CONFLICT (id) WHERE active DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT id, active, v FROM t ORDER BY id, active", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "upsert loop over multiple statements",
  ["CREATE TABLE counters (key text PRIMARY KEY, n int)"],
  [
    { sql: "INSERT INTO counters VALUES ('a', 1) ON CONFLICT (key) DO UPDATE SET n = counters.n + 1" },
    { sql: "INSERT INTO counters VALUES ('a', 1) ON CONFLICT (key) DO UPDATE SET n = counters.n + 1" },
    { sql: "INSERT INTO counters VALUES ('b', 1) ON CONFLICT (key) DO UPDATE SET n = counters.n + 1" },
    { sql: "SELECT key, n FROM counters ORDER BY key", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO NOTHING with DEFAULT values in conflict row",
  ["CREATE TABLE t (id int PRIMARY KEY, v text DEFAULT 'dv')", "INSERT INTO t VALUES (1, 'keep')"],
  [
    { sql: "INSERT INTO t (id) VALUES (1), (2) ON CONFLICT DO NOTHING" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO UPDATE on serial primary key with explicit id",
  ["CREATE TABLE t (id serial PRIMARY KEY, v text)", "INSERT INTO t (v) VALUES ('first')"],
  [
    { sql: "INSERT INTO t (id, v) VALUES (1, 'updated') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
