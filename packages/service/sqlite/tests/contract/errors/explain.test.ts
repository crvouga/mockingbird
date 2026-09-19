import { expect } from "bun:test";
import { matrixBoth } from "../../harness/index.ts";
import { parity, setupBoth } from "../helpers.ts";

matrixBoth("EXPLAIN exposes SQLite bytecode column shape with a documented stub row", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER)"]);
  const actual = memory.query("EXPLAIN SELECT id FROM t");
  const oracle = sqlite.query("EXPLAIN SELECT id FROM t");

  expect(actual.ok).toBe(true);
  expect(oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.values).toEqual([[0, "Execute", 0, 0, 0, "select", 0, null]]);
});

matrixBoth("EXPLAIN QUERY PLAN exposes SQLite plan column shape with a documented stub row", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER)"]);
  const actual = memory.query("EXPLAIN QUERY PLAN SELECT id FROM t");
  const oracle = sqlite.query("EXPLAIN QUERY PLAN SELECT id FROM t");

  expect(actual.ok).toBe(true);
  expect(oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.values).toEqual([[0, 0, 0, "EXECUTE SELECT"]]);
  expect(JSON.stringify(oracle.values)).not.toEqual(JSON.stringify(actual.values));
});

matrixBoth("EXPLAIN INSERT uses the same bytecode columns and a statement-type stub", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER)"]);
  const actual = memory.query("EXPLAIN INSERT INTO t VALUES (1)");
  const oracle = sqlite.query("EXPLAIN INSERT INTO t VALUES (1)");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.values).toEqual([[0, "Execute", 0, 0, 0, "insert", 0, null]]);
  expect((oracle.values?.length ?? 0) > 1).toBe(true);
});

matrixBoth("EXPLAIN QUERY PLAN CREATE TABLE is a stub, not a SQLite plan tree", (memory, sqlite) => {
  const actual = memory.query("EXPLAIN QUERY PLAN CREATE TABLE t(id INTEGER)");
  const oracle = sqlite.query("EXPLAIN QUERY PLAN CREATE TABLE t(id INTEGER)");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.values).toEqual([[0, 0, 0, "EXECUTE CREATE_TABLE"]]);
});

parity(
  "INDEXED BY accepts an existing index without changing query results",
  ["CREATE TABLE t(id INTEGER, value TEXT)", "CREATE INDEX t_id ON t(id)", "INSERT INTO t VALUES (2,'b'),(1,'a')"],
  "SELECT value FROM t INDEXED BY t_id WHERE id >= 1 ORDER BY id",
);

parity(
  "NOT INDEXED is accepted on joined tables",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES (1)"],
  "SELECT a.id FROM a NOT INDEXED JOIN b NOT INDEXED ON b.id=a.id",
);
