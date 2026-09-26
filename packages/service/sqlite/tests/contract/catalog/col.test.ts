import { runCatalog } from "./run.ts";

runCatalog("COL", [
  { id: "COL-bin-01", kind: "parity", sql: "SELECT 'A' = 'a' COLLATE BINARY, 'A' < 'a' COLLATE BINARY" },
  { id: "COL-nc-01", kind: "parity", sql: "SELECT 'A' = 'a' COLLATE NOCASE, 'Ä' = 'ä' COLLATE NOCASE" },
  { id: "COL-rt-01", kind: "parity", sql: "SELECT 'a' = 'a ' COLLATE RTRIM, 'a' = 'a ' COLLATE BINARY" },
  {
    id: "COL-eq-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT COLLATE NOCASE)", "INSERT INTO t VALUES ('A')"],
    sql: "SELECT a='a' FROM t",
  },
  {
    id: "COL-ord-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('b'),('A')"],
    sql: "SELECT a FROM t ORDER BY a COLLATE NOCASE",
  },
  {
    id: "COL-grp-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('A'),('a')"],
    sql: "SELECT a COLLATE NOCASE, count(*) FROM t GROUP BY a COLLATE NOCASE",
  },
  {
    id: "COL-dist-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('A'),('a')"],
    sql: "SELECT a FROM t ORDER BY a",
  },
  {
    id: "COL-in-01",
    kind: "parity",
    sql: "SELECT 'A' IN ('A')",
  },
  {
    id: "COL-res-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT COLLATE NOCASE)", "INSERT INTO t VALUES ('A')"],
    sql: "SELECT a='a' COLLATE BINARY FROM t",
  },
  { id: "COL-res-02", kind: "parity", sql: "SELECT ('A' COLLATE NOCASE) = 'a', 'A' = ('a' COLLATE NOCASE)" },
  {
    id: "COL-idx-01",
    kind: "error",
    setup: ["CREATE TABLE t(a TEXT)", "CREATE UNIQUE INDEX i ON t(a COLLATE NOCASE)", "INSERT INTO t VALUES ('A')"],
    sql: "INSERT INTO t VALUES ('a')",
  },
  { id: "COL-unk-01", kind: "parity", sql: "SELECT 'a' COLLATE BINARY" },
]);
