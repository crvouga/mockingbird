import { sequenceParity } from "../helpers.ts";

// #677: READ ONLY transactions and the transaction_read_only / default_transaction_read_only settings

sequenceParity(
  "transaction_read_only and default_transaction_read_only read off outside a transaction",
  [],
  [
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "SELECT current_setting('transaction_read_only') AS v", query: true },
    { sql: "SHOW default_transaction_read_only", query: true },
    { sql: "SET default_transaction_read_only = off" },
    {
      sql: "SELECT pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS ro",
      query: true,
    },
  ],
);

sequenceParity(
  "BEGIN READ ONLY refuses writes to permanent tables",
  ["CREATE TABLE ro_t (x int)"],
  [
    { sql: "BEGIN TRANSACTION READ ONLY" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "INSERT INTO ro_t VALUES (1)" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN READ ONLY" },
    { sql: "UPDATE ro_t SET x = 2" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN READ ONLY" },
    { sql: "DELETE FROM ro_t" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN READ ONLY" },
    { sql: "WITH a AS (INSERT INTO ro_t VALUES (1) RETURNING x) SELECT * FROM a", query: true },
    { sql: "ROLLBACK" },
    { sql: "BEGIN READ ONLY" },
    { sql: "SELECT * FROM ro_t FOR UPDATE", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*)::int AS n FROM ro_t", query: true },
  ],
);

sequenceParity(
  "SET TRANSACTION READ ONLY and SET LOCAL transaction_read_only make the transaction read-only",
  ["CREATE TABLE ro_t (x int)"],
  [
    { sql: "BEGIN" },
    { sql: "SET TRANSACTION READ ONLY" },
    { sql: "INSERT INTO ro_t VALUES (2)" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN" },
    { sql: "SET LOCAL transaction_read_only = on" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "INSERT INTO ro_t VALUES (3)" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN READ ONLY" },
    { sql: "SET TRANSACTION READ WRITE" },
    { sql: "INSERT INTO ro_t VALUES (4)" },
    { sql: "COMMIT" },
    { sql: "SELECT x FROM ro_t", query: true },
  ],
);

sequenceParity(
  "read-write mode must be chosen before the first query",
  [],
  [
    { sql: "BEGIN READ ONLY" },
    { sql: "SELECT 1 AS one", query: true },
    { sql: "SET TRANSACTION READ WRITE" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN" },
    { sql: "SELECT 1 AS one", query: true },
    { sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE" },
    { sql: "ROLLBACK" },
    { sql: "BEGIN" },
    { sql: "SELECT 1 AS one", query: true },
    { sql: "SET TRANSACTION READ ONLY" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "SET outside a transaction block leaves the transaction settings alone",
  [],
  [
    { sql: "SET TRANSACTION READ ONLY" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "SET transaction_read_only = on" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "SET transaction_isolation = 'serializable'" },
    { sql: "SHOW transaction_isolation", query: true },
  ],
);

sequenceParity(
  "default_transaction_read_only = on makes single statements read-only; BEGIN READ WRITE overrides it",
  ["CREATE TABLE ro_t (x int)", "CREATE SEQUENCE ro_s"],
  [
    { sql: "SET default_transaction_read_only = on" },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "INSERT INTO ro_t VALUES (5)" },
    { sql: "SELECT nextval('ro_s')", query: true },
    { sql: "CREATE TABLE ro_t2 (x int)" },
    { sql: "CREATE TEMP TABLE ro_tmp (x int)" },
    { sql: "BEGIN READ WRITE" },
    { sql: "INSERT INTO ro_t VALUES (6)" },
    { sql: "COMMIT" },
    { sql: "RESET default_transaction_read_only" },
    { sql: "SELECT x FROM ro_t", query: true },
  ],
);

sequenceParity(
  "DDL is refused in a read-only transaction",
  ["CREATE TABLE ro_t (x int)", "CREATE SEQUENCE ro_s", "CREATE MATERIALIZED VIEW ro_mv AS SELECT 1 AS a"],
  [
    { sql: "SET default_transaction_read_only = on" },
    { sql: "CREATE INDEX ON ro_t (x)" },
    { sql: "ALTER TABLE ro_t ADD COLUMN y int" },
    { sql: "DROP TABLE ro_t" },
    { sql: "TRUNCATE ro_t" },
    { sql: "COMMENT ON TABLE ro_t IS 'x'" },
    { sql: "CREATE VIEW ro_v AS SELECT 1 AS a" },
    { sql: "CREATE SCHEMA ro_schema" },
    { sql: "CREATE FUNCTION ro_f() RETURNS int LANGUAGE sql AS 'SELECT 1'" },
    { sql: "REFRESH MATERIALIZED VIEW ro_mv" },
    { sql: "ALTER SEQUENCE ro_s RESTART" },
    { sql: "SELECT setval('ro_s', 5)", query: true },
    { sql: "CREATE TABLE ro_ctas AS SELECT 1 AS a" },
    { sql: "CREATE TYPE ro_e AS ENUM ('a')" },
    { sql: "CREATE DOMAIN ro_d AS int" },
    { sql: "RESET default_transaction_read_only" },
  ],
);

sequenceParity(
  "temporary tables and sequences stay writable in a read-only transaction",
  ["CREATE TEMP TABLE ro_tt (x int)", "CREATE TEMP SEQUENCE ro_ts"],
  [
    { sql: "BEGIN READ ONLY" },
    { sql: "INSERT INTO ro_tt VALUES (1)" },
    { sql: "UPDATE ro_tt SET x = 2" },
    { sql: "SELECT nextval('ro_ts') AS n", query: true },
    { sql: "WITH a AS (INSERT INTO ro_tt VALUES (3) RETURNING x) SELECT * FROM a", query: true },
    { sql: "SELECT x FROM ro_tt ORDER BY x", query: true },
    { sql: "COMMIT" },
    // the oracle's temporary schema outlives the test
    { sql: "DROP TABLE ro_tt" },
    { sql: "DROP SEQUENCE ro_ts" },
  ],
);

sequenceParity(
  "a function or prepared statement cannot write in a read-only transaction either",
  ["CREATE TABLE ro_t (x int)", "PREPARE ro_p AS INSERT INTO ro_t VALUES (1)"],
  [
    { sql: "SET default_transaction_read_only = on" },
    { sql: "EXECUTE ro_p" },
    { sql: "DO $$ BEGIN INSERT INTO ro_t VALUES (1); END $$" },
    { sql: "EXPLAIN ANALYZE INSERT INTO ro_t VALUES (1)" },
    { sql: "RESET default_transaction_read_only" },
    { sql: "SELECT count(*)::int AS n FROM ro_t", query: true },
  ],
);

sequenceParity(
  "BEGIN modes and SET SESSION CHARACTERISTICS set the transaction characteristics",
  [],
  [
    { sql: "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY" },
    { sql: "SHOW transaction_isolation", query: true },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "ROLLBACK" },
    { sql: "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY" },
    { sql: "SHOW default_transaction_isolation", query: true },
    { sql: "SHOW default_transaction_read_only", query: true },
    { sql: "BEGIN" },
    { sql: "SHOW transaction_isolation", query: true },
    { sql: "SHOW transaction_read_only", query: true },
    { sql: "COMMIT" },
    { sql: "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE" },
    { sql: "SET default_transaction_read_only = maybe" },
    { sql: "RESET ALL" },
    { sql: "SHOW default_transaction_isolation", query: true },
  ],
);
