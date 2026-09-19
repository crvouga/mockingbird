import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "partial unique index only constrains matching rows",
  ["CREATE TABLE t (id int, active boolean)", "CREATE UNIQUE INDEX t_active ON t (id) WHERE active"],
  [
    { sql: "INSERT INTO t VALUES (1, false), (1, false)" },
    { sql: "INSERT INTO t VALUES (1, true)" },
    { sql: "SELECT id, active FROM t ORDER BY id, active", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "partial unique index rejects duplicate in scope",
  [
    "CREATE TABLE t (id int, active boolean)",
    "CREATE UNIQUE INDEX t_active ON t (id) WHERE active",
    "INSERT INTO t VALUES (1, true)",
  ],
  "INSERT INTO t VALUES (1, true)",
  "constraint_unique",
);

errorParity(
  "expression unique index enforces case-insensitive uniqueness",
  ["CREATE TABLE t (name text)", "CREATE UNIQUE INDEX t_lower ON t (lower(name))", "INSERT INTO t VALUES ('Alice')"],
  "INSERT INTO t VALUES ('ALICE')",
  "constraint_unique",
);

sequenceParity(
  "expression unique index allows distinct lowered values",
  ["CREATE TABLE t (name text)", "CREATE UNIQUE INDEX t_lower ON t (lower(name))"],
  [{ sql: "INSERT INTO t VALUES ('Alice'), ('Bob')" }, { sql: "SELECT name FROM t ORDER BY name", query: true }],
  { compareFinalState: true },
);

errorParity(
  "arithmetic expression index uniqueness",
  ["CREATE TABLE t (a int, b int)", "CREATE UNIQUE INDEX t_sum ON t ((a + b))", "INSERT INTO t VALUES (1, 3)"],
  "INSERT INTO t VALUES (2, 2)",
  "constraint_unique",
);

sequenceParity(
  "partial index update moves row into scope",
  [
    "CREATE TABLE t (id int, active boolean)",
    "CREATE UNIQUE INDEX t_active ON t (id) WHERE active",
    "INSERT INTO t VALUES (1, true), (1, false)",
  ],
  [{ sql: "SELECT id, active FROM t ORDER BY active", query: true }],
  { compareFinalState: true },
);

errorParity(
  "update violating partial unique index",
  [
    "CREATE TABLE t (id int, active boolean)",
    "CREATE UNIQUE INDEX t_active ON t (id) WHERE active",
    "INSERT INTO t VALUES (1, true), (1, false)",
  ],
  "UPDATE t SET active = true WHERE NOT active",
  "constraint_unique",
);
