import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "ALTER DROP DEFAULT reverts to null",
  ["CREATE TABLE t (id int, v text DEFAULT 'dflt')"],
  [
    { sql: "INSERT INTO t (id) VALUES (1)" },
    { sql: "ALTER TABLE t ALTER COLUMN v DROP DEFAULT" },
    { sql: "INSERT INTO t (id) VALUES (2)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DROP DEFAULT on column without default is a no-op",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN v DROP DEFAULT" },
    { sql: "INSERT INTO t (id) VALUES (1)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DROP DEFAULT leaves prior rows intact",
  ["CREATE TABLE t (id int, n int DEFAULT 5)"],
  [
    { sql: "INSERT INTO t (id) VALUES (1)" },
    { sql: "ALTER TABLE t ALTER COLUMN n DROP DEFAULT" },
    { sql: "INSERT INTO t (id) VALUES (2)" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DEFAULT keyword after DROP DEFAULT inserts null",
  ["CREATE TABLE t (id int, v text DEFAULT 'x')"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN v DROP DEFAULT" },
    { sql: "INSERT INTO t VALUES (1, DEFAULT)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DROP DEFAULT twice is idempotent",
  ["CREATE TABLE t (id int, n int DEFAULT 1)"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN n DROP DEFAULT" },
    { sql: "ALTER TABLE t ALTER COLUMN n DROP DEFAULT" },
    { sql: "INSERT INTO t (id) VALUES (1)" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ADD COLUMN with expression default",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN n int DEFAULT 6 * 7" },
    { sql: "INSERT INTO t (id) VALUES (2)" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DEFAULT VALUES after DROP DEFAULT inserts nulls",
  ["CREATE TABLE t (a int DEFAULT 1, b int DEFAULT 2)"],
  [
    { sql: "ALTER TABLE t ALTER COLUMN a DROP DEFAULT" },
    { sql: "INSERT INTO t DEFAULT VALUES" },
    { sql: "SELECT a, b FROM t", query: true },
  ],
  { compareFinalState: true },
);
