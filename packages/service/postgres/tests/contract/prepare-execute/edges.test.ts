import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "DEALLOCATE ALL removes every prepared statement",
  [],
  [
    { sql: "PREPARE p1 AS SELECT 1 AS v" },
    { sql: "PREPARE p2 AS SELECT 2 AS v" },
    { sql: "DEALLOCATE ALL" },
    { sql: "EXECUTE p1", query: true },
    { sql: "EXECUTE p2", query: true },
  ],
);

sequenceParity(
  "multiple prepared statements coexist",
  [],
  [
    { sql: "PREPARE one AS SELECT 1 AS v" },
    { sql: "PREPARE two AS SELECT 2 AS v" },
    { sql: "EXECUTE two", query: true },
    { sql: "EXECUTE one", query: true },
  ],
);

sequenceParity(
  "parameter reused twice in one prepared statement",
  [],
  [{ sql: "PREPARE dbl (int) AS SELECT $1 + $1 AS v" }, { sql: "EXECUTE dbl(21)", query: true }],
);

sequenceParity(
  "prepared statement sees rows inserted after PREPARE",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "PREPARE cnt AS SELECT count(*) AS n FROM t" },
    { sql: "EXECUTE cnt", query: true },
    { sql: "INSERT INTO t VALUES (1), (2)" },
    { sql: "EXECUTE cnt", query: true },
  ],
);

sequenceParity(
  "prepared statement with bool and null parameters",
  [],
  [
    { sql: "PREPARE p1 (boolean, int) AS SELECT $1 AS b, $2 IS NULL AS n" },
    { sql: "EXECUTE p1(true, NULL)", query: true },
  ],
);

sequenceParity(
  "EXECUTE inside a transaction",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "PREPARE ins (int) AS INSERT INTO t VALUES ($1)" },
    { sql: "BEGIN" },
    { sql: "EXECUTE ins(1)" },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

sequenceParity(
  "EXECUTE rolled back with the transaction",
  ["CREATE TABLE t (id int)"],
  [
    { sql: "PREPARE ins (int) AS INSERT INTO t VALUES ($1)" },
    { sql: "BEGIN" },
    { sql: "EXECUTE ins(1)" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

sequenceParity(
  "prepared statement with an expression over parameters",
  [],
  [
    { sql: "PREPARE expr (int, int) AS SELECT $1 * $2 AS product, $1 % $2 AS remainder" },
    { sql: "EXECUTE expr(17, 5)", query: true },
  ],
);
