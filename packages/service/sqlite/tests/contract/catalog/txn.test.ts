import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("TXN", [
  {
    id: "TXN-begin-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "BEGIN DEFERRED" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "COMMIT" },
      { sql: "SELECT a FROM t", query: true },
    ],
  },
  {
    id: "TXN-commit-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "BEGIN IMMEDIATE" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "END" },
      { sql: "SELECT a FROM t", query: true },
    ],
  },
  {
    id: "TXN-rb-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "BEGIN EXCLUSIVE" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "ROLLBACK" },
      { sql: "SELECT count(*) FROM t", query: true },
    ],
  },
  { id: "TXN-nest-01", kind: "error", sql: "BEGIN; BEGIN" },
  { id: "TXN-commit-02", kind: "error", sql: "COMMIT" },
  {
    id: "TXN-sp-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "SAVEPOINT a" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "SAVEPOINT b" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "ROLLBACK TO a" },
      { sql: "SELECT count(*) FROM t", query: true },
    ],
  },
  {
    id: "TXN-sp-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "SAVEPOINT a" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "SAVEPOINT b" },
      { sql: "RELEASE a" },
      { sql: "SELECT count(*) FROM t", query: true },
    ],
  },
  {
    id: "TXN-sp-03",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "SAVEPOINT s" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "ROLLBACK TO s" },
      { sql: "RELEASE s" },
      { sql: "SELECT count(*) FROM t", query: true },
    ],
  },
  {
    id: "TXN-sp-04",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "SAVEPOINT s" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "RELEASE s" },
      { sql: "SELECT a FROM t", query: true },
    ],
  },
  {
    id: "TXN-atom-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "INSERT INTO t VALUES (2)" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  {
    id: "TXN-api-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
      });
      expect(db.query<{ n: number }>("SELECT count(*) AS n FROM t")[0]!.n).toBe(1);
    },
  },
  {
    id: "TXN-api-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      try {
        db.transaction(() => {
          db.exec("INSERT INTO t VALUES (1)");
          throw new Error("boom");
        });
      } catch {
        /* expected */
      }
      expect(db.query<{ n: number }>("SELECT count(*) AS n FROM t")[0]!.n).toBe(0);
    },
  },
  {
    id: "TXN-api-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        db.transaction(() => {
          db.exec("INSERT INTO t VALUES (2)");
        });
      });
      expect(db.query<{ n: number }>("SELECT count(*) AS n FROM t")[0]!.n).toBe(2);
    },
  },
  {
    id: "TXN-api-04",
    kind: "divergence",
    fn: (db) => {
      try {
        db.transaction(() => {
          db.close();
        });
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("misuse");
      }
    },
  },
  {
    id: "TXN-rb-02",
    kind: "sequence",
    steps: [
      { sql: "BEGIN" },
      { sql: "CREATE TABLE t(a INT)" },
      { sql: "ROLLBACK" },
      { sql: "SELECT name FROM sqlite_master WHERE name='t'", query: true },
    ],
  },
  {
    id: "TXN-rb-03",
    kind: "divergence",
    fn: (db) => {
      const first = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      db.exec("BEGIN");
      db.query("SELECT random()");
      db.exec("ROLLBACK");
      const again = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      expect(again).not.toBe(first);
    },
  },
  {
    id: "TXN-close-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (1)");
      db.close();
    },
  },
]);
