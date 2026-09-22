import { runCatalog } from "./run.ts";

runCatalog("CTE", [
  { id: "CTE-basic-01", kind: "parity", sql: "WITH c(x) AS (SELECT 1) SELECT x FROM c" },
  { id: "CTE-multi-01", kind: "parity", sql: "WITH a(x) AS (SELECT 1), b(y) AS (SELECT 2) SELECT x,y FROM a, b" },
  { id: "CTE-cols-01", kind: "parity", sql: "WITH c(a,b) AS (SELECT 1,2) SELECT a,b FROM c" },
  {
    id: "CTE-shadow-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (9)"],
    sql: "WITH t(a) AS (SELECT 1) SELECT a FROM t",
  },
  {
    id: "CTE-multi-ref-01",
    kind: "parity",
    sql: "WITH c(x) AS (SELECT 1 UNION ALL SELECT 2) SELECT a.x, b.x FROM c a, c b ORDER BY 1,2",
  },
  { id: "CTE-chain-01", kind: "parity", sql: "WITH a(x) AS (SELECT 1), b(y) AS (SELECT x+1 FROM a) SELECT y FROM b" },
  {
    id: "CTE-fwd-01",
    kind: "parity",
    sql: "WITH a(x) AS (SELECT 1) SELECT x FROM a",
  },
  {
    id: "CTE-rec-01",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION SELECT x+1 FROM c WHERE x<3) SELECT x FROM c ORDER BY x",
  },
  {
    id: "CTE-rec-02",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT x FROM c ORDER BY x",
  },
  {
    id: "CTE-rec-03",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2) SELECT x FROM c",
  },
  {
    id: "CTE-rec-04",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT x FROM c ORDER BY x",
  },
  {
    id: "CTE-rec-05",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT x FROM c ORDER BY x",
  },
  {
    id: "CTE-rec-06",
    kind: "parity",
    sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5) SELECT x FROM c ORDER BY x",
  },
  {
    id: "CTE-mat-01",
    kind: "parity",
    sql: "WITH c(x) AS MATERIALIZED (SELECT 1) SELECT x FROM c UNION ALL SELECT x FROM c",
  },
  {
    id: "CTE-view-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t(a INT)",
      "INSERT INTO t VALUES (1)",
      "CREATE VIEW v AS WITH c(x) AS (SELECT a FROM t) SELECT x FROM c",
    ],
    sql: "SELECT * FROM v",
  },
  {
    id: "CTE-dml-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "WITH c(x) AS (SELECT 1) INSERT INTO t SELECT x FROM c" },
      { sql: "WITH c(x) AS (SELECT 1) UPDATE t SET a=a+x FROM c" },
      { sql: "SELECT a FROM t", query: true },
    ],
  },
]);
