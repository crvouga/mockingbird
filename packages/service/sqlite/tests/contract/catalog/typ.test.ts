import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("TYP", [
  {
    id: "TYP-aff-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT, b INTEGER, c BIGINT)", "INSERT INTO t VALUES ('1','2','3')"],
    sql: "SELECT typeof(a), typeof(b), typeof(c) FROM t",
  },
  {
    id: "TYP-aff-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a CHAR, b CLOB, c TEXT)", "INSERT INTO t VALUES (1,2,3)"],
    sql: "SELECT typeof(a), typeof(b), typeof(c) FROM t",
  },
  {
    id: "TYP-aff-03",
    kind: "parity",
    setup: ["CREATE TABLE t(a BLOB, b)", "INSERT INTO t VALUES (1,'x')"],
    sql: "SELECT typeof(a), typeof(b) FROM t",
  },
  {
    id: "TYP-aff-04",
    kind: "parity",
    setup: ["CREATE TABLE t(a REAL, b FLOAT, c DOUBLE)", "INSERT INTO t VALUES (1,1,1)"],
    sql: "SELECT typeof(a), typeof(b), typeof(c) FROM t",
  },
  {
    id: "TYP-aff-05",
    kind: "parity",
    setup: ["CREATE TABLE t(a NUMERIC, b DECIMAL, c BOOLEAN)", "INSERT INTO t VALUES ('1','1.5','1')"],
    sql: "SELECT typeof(a), typeof(b), typeof(c) FROM t",
  },
  {
    id: "TYP-aff-06",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES ('1')"],
    sql: "SELECT typeof(a) FROM t",
  },
  {
    id: "TYP-aff-07",
    kind: "parity",
    setup: ["CREATE TABLE t(a STRING)", "INSERT INTO t VALUES ('1')"],
    sql: "SELECT typeof(a) FROM t",
  },
  {
    id: "TYP-ins-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INTEGER)", "INSERT INTO t VALUES ('123')"],
    sql: "SELECT a, typeof(a) FROM t",
  },
  {
    id: "TYP-ins-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a INTEGER)", "INSERT INTO t VALUES ('123abc')"],
    sql: "SELECT a, typeof(a) FROM t",
  },
  {
    id: "TYP-ins-03",
    kind: "parity",
    setup: ["CREATE TABLE t(a INTEGER)", "INSERT INTO t VALUES ('1.0')"],
    sql: "SELECT a, typeof(a) FROM t",
  },
  {
    id: "TYP-ins-04",
    kind: "parity",
    setup: ["CREATE TABLE t(a BLOB)", "INSERT INTO t VALUES (X'31')"],
    sql: "SELECT typeof(a), hex(a) FROM t",
  },
  {
    id: "TYP-typeof-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (1),('x'),(NULL)"],
    sql: "SELECT typeof(a) FROM t ORDER BY rowid",
  },
  { id: "TYP-typeof-02", kind: "parity", sql: "SELECT typeof(1.0) AS t, 1.0 AS v" },
  { id: "TYP-cast-01", kind: "parity", sql: "SELECT typeof(CAST('12' AS INTEGER)) AS t" },
  { id: "TYP-cast-02", kind: "parity", sql: "SELECT CAST('  12' AS INTEGER) AS v" },
  { id: "TYP-cast-03", kind: "parity", sql: "SELECT CAST('abc' AS INTEGER) AS v" },
  { id: "TYP-cast-04", kind: "parity", sql: "SELECT CAST(-1.9 AS INTEGER) AS v" },
  { id: "TYP-cast-05", kind: "parity", sql: "SELECT CAST(12 AS TEXT) AS v" },
  { id: "TYP-cast-06", kind: "parity", sql: "SELECT hex(CAST('A' AS BLOB)) AS v" },
  { id: "TYP-cast-07", kind: "parity", sql: "SELECT CAST(NULL AS INTEGER) AS v, typeof(CAST(NULL AS INTEGER)) AS t" },
  { id: "TYP-cast-08", kind: "parity", sql: "SELECT CAST(9e18 AS INTEGER) AS v" },
  { id: "TYP-cast-09", kind: "parity", sql: "SELECT CAST('0x10' AS INTEGER) AS v" },
  {
    id: "TYP-cmp-01",
    kind: "parity",
    setup: ["CREATE TABLE t(i INTEGER)", "INSERT INTO t VALUES (1)"],
    sql: "SELECT i = '1' AS v FROM t",
  },
  { id: "TYP-cmp-02", kind: "parity", sql: "SELECT '10' < 9 AS v" },
  {
    id: "TYP-sort-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (NULL),(1)"],
    sql: "SELECT a FROM t ORDER BY a",
  },
  {
    id: "TYP-sort-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (1),(1.5),(2)"],
    sql: "SELECT a FROM t ORDER BY a",
  },
  {
    id: "TYP-sort-03",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (1),('a')"],
    sql: "SELECT typeof(a) FROM t ORDER BY a",
  },
  {
    id: "TYP-sort-04",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES ('a'),(X'00')"],
    sql: "SELECT typeof(a) FROM t ORDER BY a",
  },
  { id: "TYP-int-01", kind: "parity", sql: "SELECT typeof(-9223372036854775808) AS t" },
  { id: "TYP-int-02", kind: "parity", sql: "SELECT typeof(9223372036854775807) AS t" },
  {
    id: "TYP-int-03",
    kind: "parity",
    sql: "SELECT typeof(1+1) AS t",
  },
  {
    id: "TYP-int-04",
    kind: "parity",
    sql: "SELECT typeof(9007199254740993) AS t",
  },
  {
    id: "TYP-negzero-01",
    kind: "divergence",
    fn: (db) => {
      expect(Object.is(db.query<{ v: number }>("SELECT ? AS v", [-0])[0]!.v, -0)).toBe(false);
    },
  },
  {
    id: "TYP-negzero-02",
    kind: "divergence",
    fn: (db) => {
      expect(Object.is(db.query<{ v: number }>("SELECT -1.0 * 0.0 AS v")[0]!.v, -0)).toBe(false);
    },
  },
  {
    id: "TYP-negzero-03",
    kind: "divergence",
    fn: (db) => {
      expect(Object.is(db.query<{ v: number }>("SELECT min(-0.0, 0.0) AS v")[0]!.v, -0)).toBe(false);
    },
  },
  { id: "TYP-blob-01", kind: "parity", sql: "SELECT X'00' < X'01' AS v" },
  { id: "TYP-blob-02", kind: "parity", sql: "SELECT X'00' < X'0000' AS v" },
  { id: "TYP-blob-03", kind: "parity", sql: "SELECT length(X'') AS v" },
  { id: "TYP-text-01", kind: "parity", sql: "SELECT 'A' < 'a' AS v, 'B' < 'a' AS w" },
  { id: "TYP-nan-01", kind: "parity", sql: "SELECT 0.0/0.0 AS v, typeof(0.0/0.0) AS t" },
  { id: "TYP-nan-02", kind: "parity", sql: "SELECT 9e999 AS v, typeof(9e999) AS t" },
  { id: "TYP-nan-03", kind: "parity", sql: "SELECT 1e308*10 AS v, typeof(1e308*10) AS t" },
  {
    id: "TYP-nan-04",
    kind: "divergence",
    fn: (db) => {
      try {
        db.query("SELECT ?", [Number.NaN]);
        throw new Error("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("datatype_mismatch");
      }
    },
  },
  {
    id: "TYP-nan-05",
    kind: "divergence",
    fn: (db) => {
      try {
        db.query("SELECT ?", [Number.POSITIVE_INFINITY]);
        throw new Error("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("datatype_mismatch");
      }
    },
  },
]);
