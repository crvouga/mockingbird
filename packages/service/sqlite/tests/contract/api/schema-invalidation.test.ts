import { expect } from "bun:test";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("prepared SELECT * sees columns added by ALTER TABLE", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", "INSERT INTO t(name) VALUES ('a')"]);
  const memStmt = memory.prepare("SELECT * FROM t");
  const sqlStmt = sqlite.prepare("SELECT * FROM t");
  expectParity(memStmt.all(), sqlStmt.all());
  expect(memory.exec("ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'x'").ok).toBe(true);
  expect(sqlite.exec("ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'x'").ok).toBe(true);
  expectParity(memStmt.all(), sqlStmt.all());
});

matrixBoth("prepared INSERT still works after ADD COLUMN with default", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"]);
  const memStmt = memory.prepare("INSERT INTO t(name) VALUES (?)");
  const sqlStmt = sqlite.prepare("INSERT INTO t(name) VALUES (?)");
  expectParity(memStmt.run("a"), sqlStmt.run("a"));
  expect(memory.exec("ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'x'").ok).toBe(true);
  expect(sqlite.exec("ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'x'").ok).toBe(true);
  expectParity(memStmt.run("b"), sqlStmt.run("b"));
  expectParity(
    memory.query("SELECT id,name,note FROM t ORDER BY id"),
    sqlite.query("SELECT id,name,note FROM t ORDER BY id"),
  );
});

matrixBoth("prepared statement after DROP TABLE matches oracle error", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", "INSERT INTO t(name) VALUES ('a')"]);
  const memStmt = memory.prepare("SELECT name FROM t");
  const sqlStmt = sqlite.prepare("SELECT name FROM t");
  expectParity(memStmt.all(), sqlStmt.all());
  expect(memory.exec("DROP TABLE t").ok).toBe(true);
  expect(sqlite.exec("DROP TABLE t").ok).toBe(true);
  expectParity(memStmt.all(), sqlStmt.all());
});

matrixBoth("prepared statement after DROP and recreate matches oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", "INSERT INTO t(name) VALUES ('a')"]);
  const memStmt = memory.prepare("SELECT name FROM t ORDER BY id");
  const sqlStmt = sqlite.prepare("SELECT name FROM t ORDER BY id");
  expect(memory.exec("DROP TABLE t").ok).toBe(true);
  expect(sqlite.exec("DROP TABLE t").ok).toBe(true);
  expect(memory.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)").ok).toBe(true);
  expect(sqlite.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)").ok).toBe(true);
  expect(memory.exec("INSERT INTO t(name) VALUES ('b')").ok).toBe(true);
  expect(sqlite.exec("INSERT INTO t(name) VALUES ('b')").ok).toBe(true);
  expectParity(memStmt.all(), sqlStmt.all());
});
