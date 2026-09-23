import { expect } from "bun:test";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

/** Empty result sets must still expose prepared column names (not []). */

matrixBoth("empty SELECT preserves column names", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER, name TEXT)", "INSERT INTO t VALUES (1,'a')"]);
  const a = memory.query("SELECT id, name FROM t WHERE 0");
  const b = sqlite.query("SELECT id, name FROM t WHERE 0");
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(a.rows).toEqual([]);
  expect(b.rows).toEqual([]);
  expect(a.columns).toEqual(b.columns);
  expect(a.columns).toEqual(["id", "name"]);
});

matrixBoth("empty aggregate SELECT preserves alias names", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(v INTEGER)"]);
  const a = memory.query("SELECT count(*) AS c, sum(v) AS s FROM t WHERE 0");
  const b = sqlite.query("SELECT count(*) AS c, sum(v) AS s FROM t WHERE 0");
  expect(a.ok && b.ok).toBe(true);
  expect(a.columns).toEqual(b.columns);
  expect(a.columns).toEqual(["c", "s"]);
});

matrixBoth("unaliased aggregate column names match oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2)"]);
  const a = memory.query("SELECT sum(v), count(*), avg(v) FROM t");
  const b = sqlite.query("SELECT sum(v), count(*), avg(v) FROM t");
  expect(a.ok && b.ok).toBe(true);
  expect(a.columns).toEqual(b.columns);
  expect(a.columns).toEqual(["sum(v)", "count(*)", "avg(v)"]);
});
