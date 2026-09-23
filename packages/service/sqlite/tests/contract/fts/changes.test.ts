import { expect } from "bun:test";
import { expectParity, matrixBoth } from "../../harness/index.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("FTS5 MATCH rows match oracle after INSERT", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE VIRTUAL TABLE docs USING fts5(body)"]);
  expect(memory.exec("INSERT INTO docs(body) VALUES ('hello sqlite'), ('goodbye moon')").ok).toBe(true);
  expect(sqlite.exec("INSERT INTO docs(body) VALUES ('hello sqlite'), ('goodbye moon')").ok).toBe(true);
  expectParity(
    memory.query("SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid"),
    sqlite.query("SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid"),
  );
});

matrixBoth("FTS5 shadow tables exist in SQLite sqlite_master but not sqlite-mem", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE VIRTUAL TABLE docs USING fts5(body)", "INSERT INTO docs(body) VALUES ('hello')"]);
  const sql = "SELECT name FROM sqlite_master WHERE name LIKE 'docs_%' ORDER BY name";
  const actual = memory.query(sql);
  const oracle = sqlite.query(sql);
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.rows.length).toBe(0);
  expect(oracle.rows.length).toBeGreaterThan(0);
});

matrixBoth("FTS3 MATCH rows match oracle after INSERT", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE VIRTUAL TABLE t USING fts3(c)"]);
  expect(memory.exec("INSERT INTO t(c) VALUES ('alpha beta')").ok).toBe(true);
  expect(sqlite.exec("INSERT INTO t(c) VALUES ('alpha beta')").ok).toBe(true);
  expectParity(
    memory.query("SELECT rowid FROM t WHERE t MATCH 'alpha'"),
    sqlite.query("SELECT rowid FROM t WHERE t MATCH 'alpha'"),
  );
});
