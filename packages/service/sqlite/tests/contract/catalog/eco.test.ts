import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("ECO", [
  {
    id: "ECO-kysely-01",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"],
    sql: "SELECT p.name FROM pragma_table_list() AS tl, pragma_table_info(tl.name) AS p WHERE tl.name='t' ORDER BY p.cid",
  },
  {
    id: "ECO-drizzle-01",
    kind: "sequence",
    setup: ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)"],
    steps: [{ sql: "INSERT INTO users(name) VALUES ('ada')" }, { sql: "SELECT id, name FROM users", query: true }],
  },
  {
    id: "ECO-knex-01",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, n INT)", "INSERT INTO t(n) VALUES (1),(2)"],
    sql: "SELECT * FROM t WHERE n > 1 ORDER BY id",
  },
  {
    id: "ECO-prisma-01",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"],
    sql: "SELECT name, type FROM pragma_table_info('t') ORDER BY cid",
  },
  {
    id: "ECO-mig-01",
    kind: "sequence",
    steps: [
      { sql: "BEGIN" },
      { sql: "CREATE TABLE _migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE)" },
      { sql: "CREATE TABLE t(a INT)" },
      { sql: "INSERT INTO _migrations(name) VALUES ('001')" },
      { sql: "COMMIT" },
      { sql: "SELECT name FROM _migrations", query: true },
    ],
  },
  {
    id: "ECO-b3-01",
    kind: "divergence",
    fn: (db) => {
      const stmt = db.prepare("SELECT 1") as { bind?: unknown; iterate?: unknown; pluck?: unknown };
      expect(stmt.bind).toBeUndefined();
      expect(stmt.iterate).toBeUndefined();
      expect(stmt.pluck).toBeUndefined();
      try {
        (db as { pragma?: (s: string) => unknown }).pragma?.("encoding");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
      }
    },
  },
  {
    id: "ECO-readme-01",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.query("SELECT 1; SELECT 2")).toThrow(SqliteError);
    },
  },
  { id: "ECO-node-01", kind: "parity", sql: "SELECT 1 AS ok" },
]);
