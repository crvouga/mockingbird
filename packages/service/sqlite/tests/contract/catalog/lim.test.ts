import { runCatalog } from "./run.ts";

runCatalog("LIM", [
  { id: "LIM-depth-01", kind: "parity", sql: `SELECT ${"(".repeat(50)}1${")".repeat(50)}` },
  {
    id: "LIM-cmpd-01",
    kind: "parity",
    sql: "SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5",
  },
  {
    id: "LIM-cols-01",
    kind: "exec",
    sql: `CREATE TABLE t(${Array.from({ length: 32 }, (_, i) => `c${i} INT`).join(",")})`,
  },
  {
    id: "LIM-vals-01",
    kind: "parity",
    sql: "SELECT count(*) AS n FROM (VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')) AS v",
  },
  {
    id: "LIM-in-01",
    kind: "parity",
    sql: `SELECT 1 IN (${Array.from({ length: 50 }, (_, i) => String(i)).join(",")})`,
  },
  {
    id: "LIM-ident-01",
    kind: "parity",
    setup: [`CREATE TABLE t("${"x".repeat(80)}" INT)`, "INSERT INTO t VALUES (1)"],
    sql: `SELECT "${"x".repeat(80)}" FROM t`,
  },
  { id: "LIM-like-01", kind: "parity", sql: `SELECT '${"a".repeat(100)}' LIKE '%a%'` },
  {
    id: "LIM-zero-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT PRIMARY KEY)", "INSERT INTO t VALUES ('')"],
    sql: "SELECT a FROM t",
  },
  { id: "LIM-zero-02", kind: "parity", sql: "SELECT 1+1 WHERE 1" },
  { id: "LIM-fuzz-01", kind: "parity", sql: "SELECT 1 UNION ALL SELECT 1 ORDER BY 1" },
]);
