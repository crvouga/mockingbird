import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "CREATE TABLE rolled back",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TABLE ddl_t (id int)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'ddl_t'", query: true },
  ],
);

sequenceParity(
  "CREATE TABLE committed",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TABLE ddl_t (id int)" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'ddl_t'", query: true },
  ],
);

sequenceParity(
  "DROP TABLE rolled back restores table and data",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [{ sql: "BEGIN" }, { sql: "DROP TABLE t" }, { sql: "ROLLBACK" }, { sql: "SELECT * FROM t ORDER BY id", query: true }],
);

sequenceParity(
  "CREATE VIEW rolled back",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "CREATE VIEW txn_v AS SELECT id FROM t" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'txn_v'", query: true },
  ],
);

sequenceParity(
  "CREATE SEQUENCE rolled back",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE SEQUENCE txn_s" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'txn_s'", query: true },
  ],
);

sequenceParity(
  "CREATE SCHEMA rolled back",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE SCHEMA txn_schema" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'txn_schema'", query: true },
  ],
);

sequenceParity(
  "ALTER TABLE ADD COLUMN rolled back",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE t ADD COLUMN extra text" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 't'", query: true },
  ],
);

sequenceParity(
  "CREATE TABLE plus INSERT committed together",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TABLE both_t (id int, v text)" },
    { sql: "INSERT INTO both_t VALUES (1, 'a')" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM both_t", query: true },
  ],
);

sequenceParity(
  "CREATE TABLE plus INSERT rolled back together",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TABLE gone_t (id int)" },
    { sql: "INSERT INTO gone_t VALUES (1)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'gone_t'", query: true },
  ],
);

sequenceParity(
  "DDL and DML mixed rollback leaves prior state intact",
  ["CREATE TABLE keep_t (id int)", "INSERT INTO keep_t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "CREATE TABLE new_t (id int)" },
    { sql: "INSERT INTO keep_t VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM keep_t ORDER BY id", query: true },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'new_t'", query: true },
  ],
  { compareFinalState: true },
);
