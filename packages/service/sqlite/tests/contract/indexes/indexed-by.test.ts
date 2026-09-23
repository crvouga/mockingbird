import { expect } from "bun:test";
import { expectParity, matrixBoth } from "../../harness/index.ts";
import { parity, setupBoth } from "../helpers.ts";

parity(
  "INDEXED BY an existing index does not change SELECT results",
  ["CREATE TABLE t(id INTEGER, value TEXT)", "CREATE INDEX t_id ON t(id)", "INSERT INTO t VALUES (2,'b'),(1,'a')"],
  "SELECT value FROM t INDEXED BY t_id WHERE id >= 1 ORDER BY id",
);

parity(
  "NOT INDEXED does not change join results",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES (1)"],
  "SELECT a.id FROM a NOT INDEXED JOIN b NOT INDEXED ON b.id=a.id",
);

matrixBoth("INDEXED BY a missing index is a no-op in sqlite-mem and an error in SQLite", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"]);
  const actual = memory.query("SELECT id FROM t INDEXED BY missing");
  const oracle = sqlite.query("SELECT id FROM t INDEXED BY missing");
  expect(actual.ok).toBe(true);
  expect(actual.values).toEqual([[1]]);
  expect(oracle.ok).toBe(false);
  expect(oracle.error?.message.toLowerCase()).toContain("no such index");
});

matrixBoth("INDEXED BY an index on another table is a no-op in sqlite-mem and an error in SQLite", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER)",
    "CREATE TABLE u(id INTEGER)",
    "CREATE INDEX u_id ON u(id)",
    "INSERT INTO t VALUES (1)",
  ]);
  const actual = memory.query("SELECT id FROM t INDEXED BY u_id");
  const oracle = sqlite.query("SELECT id FROM t INDEXED BY u_id");
  expect(actual.ok).toBe(true);
  expect(oracle.ok).toBe(false);
});

matrixBoth("INDEXED BY documented no-op still matches oracle when the index exists", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER)",
    "CREATE INDEX t_id ON t(id)",
    "INSERT INTO t VALUES (1),(2)",
  ]);
  expectParity(
    memory.query("SELECT id FROM t INDEXED BY t_id ORDER BY id"),
    sqlite.query("SELECT id FROM t INDEXED BY t_id ORDER BY id"),
  );
});
