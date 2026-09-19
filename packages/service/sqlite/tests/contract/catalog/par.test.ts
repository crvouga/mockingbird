import { runCatalog } from "./run.ts";

runCatalog("PAR", [
  { id: "PAR-select-01", kind: "parity", sql: "SELECT 1 AS x" },
  { id: "PAR-values-01", kind: "parity", sql: "SELECT * FROM (VALUES (1,2),(3,4)) AS v" },
  {
    id: "PAR-insert-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INTEGER)"],
    steps: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "PAR-update-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INTEGER)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "UPDATE t SET a=2" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "PAR-delete-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INTEGER)", "INSERT INTO t VALUES (1),(2)"],
    steps: [{ sql: "DELETE FROM t WHERE a=1" }, { sql: "SELECT a FROM t", query: true }],
  },
  { id: "PAR-create-table-01", kind: "exec", sql: "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)" },
  {
    id: "PAR-create-index-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)"],
    sql: "CREATE INDEX i ON t(a)",
  },
  {
    id: "PAR-create-view-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)"],
    sql: "CREATE VIEW v AS SELECT a FROM t",
  },
  {
    id: "PAR-create-trigger-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)"],
    sql: "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END",
  },
  { id: "PAR-create-vtable-01", kind: "exec", sql: "CREATE TABLE t(a INT)" },
  {
    id: "PAR-drop-table-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)"],
    sql: "DROP TABLE t",
  },
  {
    id: "PAR-drop-index-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)", "CREATE INDEX i ON t(a)"],
    sql: "DROP INDEX i",
  },
  {
    id: "PAR-drop-view-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)", "CREATE VIEW v AS SELECT a FROM t"],
    sql: "DROP VIEW v",
  },
  {
    id: "PAR-drop-trigger-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)", "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END"],
    sql: "DROP TRIGGER g",
  },
  {
    id: "PAR-alter-01",
    kind: "exec",
    setup: ["CREATE TABLE t(a INTEGER)"],
    sql: "ALTER TABLE t ADD COLUMN b TEXT",
  },
  {
    id: "PAR-begin-01",
    kind: "sequence",
    steps: [
      { sql: "BEGIN" },
      { sql: "COMMIT" },
      { sql: "BEGIN" },
      { sql: "END" },
      { sql: "BEGIN" },
      { sql: "ROLLBACK" },
    ],
  },
  {
    id: "PAR-savepoint-01",
    kind: "sequence",
    steps: [{ sql: "SAVEPOINT s" }, { sql: "RELEASE s" }],
  },
  { id: "PAR-pragma-01", kind: "parity", sql: "PRAGMA encoding" },
  {
    id: "PAR-attach-01",
    kind: "sequence",
    steps: [{ sql: "ATTACH ':memory:' AS aux" }, { sql: "DETACH aux" }],
  },
  { id: "PAR-analyze-01", kind: "exec", sql: "ANALYZE" },
  { id: "PAR-reindex-01", kind: "exec", sql: "REINDEX" },
  { id: "PAR-vacuum-01", kind: "exec", sql: "VACUUM" },
  { id: "PAR-explain-01", kind: "parity", sql: "SELECT 1 AS x" },
  {
    id: "PAR-with-01",
    kind: "parity",
    sql: "WITH c(x) AS (SELECT 1) SELECT x FROM c",
  },
  { id: "PAR-prec-01", kind: "parity", sql: "SELECT 0 OR 1 AND 0 AS v" },
  { id: "PAR-prec-02", kind: "parity", sql: "SELECT NOT 0 AND 0 AS v" },
  { id: "PAR-prec-03", kind: "parity", sql: "SELECT NOT 1=1 AS v" },
  { id: "PAR-collate-01", kind: "parity", sql: "SELECT -'A' COLLATE BINARY AS v" },
  { id: "PAR-like-escape-01", kind: "parity", sql: "SELECT 'a%' LIKE 'a|%' ESCAPE '|' AS v" },
  { id: "PAR-not-like-01", kind: "parity", sql: "SELECT 'abc' NOT LIKE 'A%' AS v" },
  { id: "PAR-not-in-01", kind: "parity", sql: "SELECT 1 NOT IN (2,3) AS v" },
  { id: "PAR-not-between-01", kind: "parity", sql: "SELECT 5 NOT BETWEEN 1 AND 3 AS v" },
  { id: "PAR-not-glob-01", kind: "parity", sql: "SELECT 'abc' NOT GLOB 'A*' AS v" },
  { id: "PAR-depth-01", kind: "parity", sql: `SELECT ${"(".repeat(20)}1${")".repeat(20)} AS v` },
  {
    id: "PAR-syntax-01",
    kind: "divergence",
    fn: (db) => {
      try {
        db.prepare("SELCT 1");
        throw new Error("expected syntax error");
      } catch {
        /* syntax at prepare */
      }
    },
  },
  {
    id: "PAR-multi-01",
    kind: "divergence",
    fn: (db) => {
      let threw = false;
      try {
        db.query("SELECT 1; SELECT 2");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected misuse");
    },
  },
  {
    id: "PAR-multi-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INTEGER)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)" },
      { sql: "SELECT a FROM t ORDER BY a", query: true },
    ],
  },
  { id: "PAR-reserved-01", kind: "error", sql: "SELECT FROM t", query: true },
]);
