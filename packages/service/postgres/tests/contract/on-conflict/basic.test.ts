import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "DO NOTHING without target",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'keep')"],
  [
    { sql: "INSERT INTO t VALUES (1, 'dup') ON CONFLICT DO NOTHING" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO NOTHING with column target",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'keep')"],
  [
    { sql: "INSERT INTO t VALUES (1, 'dup') ON CONFLICT (id) DO NOTHING" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO NOTHING inserts non-conflicting rows",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (2, 'two')"],
  [
    { sql: "INSERT INTO t VALUES (1, 'one'), (2, 'dup'), (3, 'three') ON CONFLICT DO NOTHING" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO UPDATE SET with EXCLUDED",
  ["CREATE TABLE t (id int PRIMARY KEY, v text, n int)", "INSERT INTO t VALUES (1, 'old', 10)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'new', 20) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, n = EXCLUDED.n" },
    { sql: "SELECT id, v, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DO UPDATE referencing existing row",
  ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 100)"],
  [
    { sql: "INSERT INTO t VALUES (1, 5) ON CONFLICT (id) DO UPDATE SET n = t.n + EXCLUDED.n" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "conflict target on unique constraint column",
  ["CREATE TABLE t (id int PRIMARY KEY, email text UNIQUE, v text)", "INSERT INTO t VALUES (1, 'a@x.com', 'first')"],
  [
    { sql: "INSERT INTO t VALUES (2, 'a@x.com', 'second') ON CONFLICT (email) DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT id, email, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ON CONFLICT ON CONSTRAINT named",
  ["CREATE TABLE t (id int, v text, CONSTRAINT t_id_key UNIQUE (id))", "INSERT INTO t VALUES (1, 'old')"],
  [
    { sql: "INSERT INTO t VALUES (1, 'new') ON CONFLICT ON CONSTRAINT t_id_key DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "composite unique conflict target",
  ["CREATE TABLE t (a int, b int, v text, UNIQUE (a, b))", "INSERT INTO t VALUES (1, 1, 'old')"],
  [
    { sql: "INSERT INTO t VALUES (1, 1, 'new'), (1, 2, 'fresh') ON CONFLICT (a, b) DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT a, b, v FROM t ORDER BY a, b", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "no conflict inserts normally",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'a') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
