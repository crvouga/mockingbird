import { runCatalog } from "./run.ts";

const T = ["CREATE TABLE t(a INT, b INT, c TEXT)", "INSERT INTO t VALUES (1,10,'x'),(2,20,'y'),(2,NULL,'z')"];

runCatalog("AGG", [
  { id: "AGG-count-01", kind: "parity", setup: T, sql: "SELECT count(*), count(b) FROM t" },
  { id: "AGG-count-02", kind: "parity", setup: T, sql: "SELECT count(DISTINCT a) FROM t" },
  { id: "AGG-sum-01", kind: "parity", setup: ["CREATE TABLE t(a INT)"], sql: "SELECT sum(a) FROM t" },
  { id: "AGG-sum-02", kind: "parity", setup: ["CREATE TABLE t(a INT)"], sql: "SELECT total(a) FROM t" },
  {
    id: "AGG-sum-03",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1),(2)"],
    sql: "SELECT sum(a) FROM t",
    query: true,
  },
  {
    id: "AGG-sum-04",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1),(2)"],
    sql: "SELECT total(a) FROM t",
  },
  { id: "AGG-avg-01", kind: "parity", setup: T, sql: "SELECT typeof(avg(a)), avg(a) FROM t" },
  {
    id: "AGG-minmax-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (1),('a'),(X'00')"],
    sql: "SELECT min(a), max(a) FROM t",
  },
  {
    id: "AGG-minmax-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (NULL),(NULL)"],
    sql: "SELECT min(a), max(a) FROM t",
  },
  { id: "AGG-gconcat-01", kind: "parity", setup: T, sql: "SELECT group_concat(c) FROM t" },
  { id: "AGG-gconcat-02", kind: "parity", setup: T, sql: "SELECT group_concat(c, '|') FROM t" },
  { id: "AGG-gconcat-03", kind: "parity", setup: T, sql: "SELECT string_agg(c, ',') FROM t" },
  { id: "AGG-gconcat-04", kind: "parity", setup: T, sql: "SELECT group_concat(DISTINCT a) FROM t" },
  { id: "AGG-gconcat-05", kind: "parity", setup: T, sql: "SELECT group_concat(c ORDER BY c DESC) FROM t" },
  { id: "AGG-filter-01", kind: "parity", setup: T, sql: "SELECT count(*) FILTER (WHERE a=2) FROM t" },
  { id: "AGG-distinct-01", kind: "parity", setup: T, sql: "SELECT sum(DISTINCT a) FROM t" },
  { id: "AGG-distinct-02", kind: "parity", setup: T, sql: "SELECT group_concat(c, '|') FROM t" },
  {
    id: "AGG-empty-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT count(*), sum(a), avg(a) FROM t",
  },
  { id: "AGG-having-01", kind: "parity", setup: T, sql: "SELECT count(*) FROM t HAVING count(*)>0" },
  { id: "AGG-bare-01", kind: "parity", setup: T, sql: "SELECT max(b) FROM t" },
  { id: "AGG-nested-01", kind: "error", setup: T, sql: "SELECT sum(count(*)) FROM t", query: true },
  { id: "AGG-where-01", kind: "error", setup: T, sql: "SELECT a FROM t WHERE count(*)>0", query: true },
]);
