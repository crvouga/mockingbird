import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("multi-statement exec runs DDL and DML together", (memory, sqlite) => {
  const script = `
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO users(name) VALUES ('Ada');
    INSERT INTO users(name) VALUES ('Bob');
  `;
  expect(memory.exec(script).ok).toBe(true);
  expect(sqlite.exec(script).ok).toBe(true);
  expectParity(
    memory.query("SELECT id, name FROM users ORDER BY id"),
    sqlite.query("SELECT id, name FROM users ORDER BY id"),
  );
});

matrixBoth("prepare bind run all get reuse a statement", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)",
    "INSERT INTO t(name) VALUES ('a'),('b'),('c')",
  ]);
  const memStmt = memory.prepare("SELECT id, name FROM t WHERE id = ?");
  const sqlStmt = sqlite.prepare("SELECT id, name FROM t WHERE id = ?");
  expectParity(memStmt.get(2), sqlStmt.get(2));
  expectParity(memStmt.all(1), sqlStmt.all(1));
  const insertMem = memory.prepare("INSERT INTO t(name) VALUES (?)");
  const insertSql = sqlite.prepare("INSERT INTO t(name) VALUES (?)");
  expectParity(insertMem.run("d"), insertSql.run("d"));
  expectParity(memory.query("SELECT name FROM t ORDER BY id"), sqlite.query("SELECT name FROM t ORDER BY id"));
});

matrixBoth("transaction commits successful work", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"]);
  memory.transaction(() => {
    expect(memory.exec("INSERT INTO t(name) VALUES ('ok')").ok).toBe(true);
  });
  sqlite.transaction(() => {
    expect(sqlite.exec("INSERT INTO t(name) VALUES ('ok')").ok).toBe(true);
  });
  expectParity(memory.query("SELECT name FROM t"), sqlite.query("SELECT name FROM t"));
});

matrixBoth("transaction rolls back when the callback throws", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)",
    "INSERT INTO t(name) VALUES ('seed')",
  ]);
  expect(() =>
    memory.transaction(() => {
      expect(memory.exec("INSERT INTO t(name) VALUES ('x')").ok).toBe(true);
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(() =>
    sqlite.transaction(() => {
      expect(sqlite.exec("INSERT INTO t(name) VALUES ('x')").ok).toBe(true);
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expectParity(memory.query("SELECT name FROM t ORDER BY id"), sqlite.query("SELECT name FROM t ORDER BY id"));
});

describe("api memory-only", () => {
  test("lastInsertRowid and changes track writes", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO t(name) VALUES ('a'),('b')");
    expect(db.changes).toBe(2);
    expect(Number(db.lastInsertRowid)).toBe(2);
    db.exec("UPDATE t SET name='z' WHERE id=1");
    expect(db.changes).toBe(1);
    expect(db.query("SELECT changes() AS n")[0]).toEqual({ n: 1 });
  });

  test("CURRENT_DATE uses the fixed clock", () => {
    const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
    expect(db.query("SELECT CURRENT_DATE AS d")[0]).toEqual({ d: "2012-06-15" });
    expect(db.query("SELECT CURRENT_TIME AS t")[0]).toEqual({ t: "12:34:56" });
    expect(db.query("SELECT CURRENT_TIMESTAMP AS ts")[0]).toEqual({ ts: "2012-06-15 12:34:56" });
  });
});

describe("closed database", () => {
  test("rejects operations after close", () => {
    const db = new InMemoryAdapter();
    db.close();
    expect(db.exec("SELECT 1").ok).toBe(false);
    expect(db.exec("SELECT 1").error?.category).toBe("misuse");
  });
});
