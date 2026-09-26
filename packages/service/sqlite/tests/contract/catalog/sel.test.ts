import { expect } from "bun:test";
import { runCatalog } from "./run.ts";

const T = ["CREATE TABLE t(a INT, b TEXT)", "INSERT INTO t VALUES (1,'x'),(2,'y'),(2,'z')"];

runCatalog("SEL", [
  { id: "SEL-proj-01", kind: "parity", setup: T, sql: "SELECT * FROM t ORDER BY a, b" },
  { id: "SEL-proj-02", kind: "parity", setup: T, sql: "SELECT t.* FROM t ORDER BY a, b" },
  { id: "SEL-alias-01", kind: "parity", setup: T, sql: "SELECT a AS z FROM t ORDER BY z" },
  { id: "SEL-alias-02", kind: "parity", setup: T, sql: "SELECT a AS z, count(*) FROM t GROUP BY z ORDER BY z" },
  { id: "SEL-alias-03", kind: "parity", setup: T, sql: "SELECT a AS z FROM t WHERE a=1" },
  {
    id: "SEL-dup-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT, b INT)");
      db.exec("INSERT INTO t VALUES (1,2)");
      const rows = db.query<{ a: number }>("SELECT a, a FROM t");
      expect(rows[0]!.a).toBe(1);
      const result = db.prepare("SELECT a, a FROM t").result();
      expect(result.values[0]).toEqual([1, 1]);
    },
  },
  {
    id: "SEL-distinct-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (NULL),(NULL),(1)"],
    sql: "SELECT DISTINCT a FROM t ORDER BY a",
  },
  {
    id: "SEL-distinct-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('A'),('a')"],
    sql: "SELECT DISTINCT a FROM t ORDER BY a",
  },
  { id: "SEL-group-01", kind: "parity", setup: T, sql: "SELECT a+0, count(*) FROM t GROUP BY a+0 ORDER BY 1" },
  { id: "SEL-group-02", kind: "parity", setup: T, sql: "SELECT a, count(*) FROM t GROUP BY 1 ORDER BY 1" },
  { id: "SEL-group-03", kind: "parity", setup: T, sql: "SELECT a AS z, count(*) FROM t GROUP BY z ORDER BY z" },
  {
    id: "SEL-group-04",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (NULL),(NULL),(1)"],
    sql: "SELECT a, count(*) FROM t GROUP BY a ORDER BY a",
  },
  { id: "SEL-group-05", kind: "error", setup: T, sql: "SELECT a FROM t GROUP BY 9", query: true },
  {
    id: "SEL-having-01",
    kind: "parity",
    setup: T,
    sql: "SELECT a, count(*) FROM t GROUP BY a HAVING count(*)>1 ORDER BY a",
  },
  { id: "SEL-order-01", kind: "parity", setup: T, sql: "SELECT b, a FROM t ORDER BY 1, a" },
  {
    id: "SEL-order-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('b'),('A')"],
    sql: "SELECT a FROM t ORDER BY a COLLATE NOCASE ASC",
  },
  {
    id: "SEL-order-03",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (NULL),(1)"],
    sql: "SELECT a FROM t ORDER BY a NULLS FIRST",
  },
  { id: "SEL-limit-01", kind: "parity", setup: T, sql: "SELECT a FROM t ORDER BY a, b LIMIT -1" },
  { id: "SEL-limit-02", kind: "parity", setup: T, sql: "SELECT a FROM t ORDER BY a, b LIMIT 1, 1" },
  { id: "SEL-limit-03", kind: "parity", setup: T, sql: "SELECT a FROM t ORDER BY a, b LIMIT 1+1 OFFSET 1-1" },
  { id: "SEL-union-01", kind: "parity", sql: "SELECT 1 AS v UNION ALL SELECT 1 AS v" },
  { id: "SEL-union-02", kind: "parity", sql: "SELECT 1 AS v UNION SELECT 2 AS v" },
  { id: "SEL-union-03", kind: "error", sql: "SELECT 1 UNION SELECT 1,2", query: true },
  { id: "SEL-union-04", kind: "parity", sql: "SELECT 2 UNION SELECT 1 UNION SELECT 3 ORDER BY 1 LIMIT 2" },
  { id: "SEL-values-01", kind: "parity", sql: "SELECT 1 AS column1, 2 AS column2" },
  { id: "SEL-sub-01", kind: "parity", setup: T, sql: "SELECT * FROM (SELECT a FROM t) AS s ORDER BY a" },
  {
    id: "SEL-sub-02",
    kind: "parity",
    setup: T,
    sql: "SELECT a, (SELECT count(*) FROM t t2 WHERE t2.a=t.a) FROM t ORDER BY a, b",
  },
]);
