import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("ERR", [
  {
    id: "ERR-cat-01",
    kind: "error",
    sql: "SELCT 1",
    query: true,
    messageTier: "B",
    notes: "sqlite-mem IDENT vs sqlite near SELCT",
  },
  { id: "ERR-cat-02", kind: "error", sql: "SELECT * FROM nosuch", query: true, messageTier: "A" },
  {
    id: "ERR-cat-03",
    kind: "error",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT b FROM t",
    query: true,
    messageTier: "A",
  },
  {
    id: "ERR-cat-04",
    kind: "error",
    setup: ["CREATE TABLE t(a INT UNIQUE)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT INTO t VALUES (1)",
    messageTier: "B",
    notes: "UNIQUE column list wording",
  },
  {
    id: "ERR-cat-05",
    kind: "divergence",
    fn: (db) => {
      try {
        db.query("SELECT ?", [Number.NaN]);
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("datatype_mismatch");
      }
    },
  },
  { id: "ERR-cat-06", kind: "error", sql: "SELECT FROM", query: true, messageTier: "B", notes: "syntax wording" },
  {
    id: "ERR-time-01",
    kind: "error",
    sql: "SELCT 1",
    query: true,
    messageTier: "B",
    notes: "prepare-phase syntax wording",
  },
  { id: "ERR-time-02", kind: "error", sql: "SELECT * FROM nosuch", query: true, messageTier: "A" },
  {
    id: "ERR-time-03",
    kind: "error",
    setup: ["CREATE TABLE t(a INT UNIQUE)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT INTO t VALUES (1)",
    messageTier: "B",
    notes: "constraint message column list",
  },
  {
    id: "ERR-state-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT UNIQUE)", "INSERT INTO t VALUES (1)"],
    compareFinalState: true,
    steps: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "SELECT a FROM t ORDER BY a", query: true },
    ],
  },
  {
    id: "ERR-inst-01",
    kind: "divergence",
    fn: (db) => {
      try {
        db.exec("SELECT * FROM nosuch");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).code).toBe((error as SqliteError).sqliteCode);
      }
    },
  },
]);
