import { expect } from "bun:test";
import { expectParity, matrixBoth } from "../../harness/index.ts";
import { parity } from "../helpers.ts";

matrixBoth("rtree create insert query", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE demo USING rtree(id, minX, maxX, minY, maxY)").ok).toBe(true);
    expect(db.exec("INSERT INTO demo VALUES(1, -80.604739, -80.604739, 39.659575, 39.659575)").ok).toBe(true);
    expect(db.exec("INSERT INTO demo VALUES(2, -81.0, -79.0, 38.0, 40.0)").ok).toBe(true);
  }
  expectParity(
    memory.query(
      "SELECT id FROM demo WHERE maxX >= -80.7 AND minX <= -80.5 AND maxY >= 39.5 AND minY <= 39.8 ORDER BY id",
    ),
    sqlite.query(
      "SELECT id FROM demo WHERE maxX >= -80.7 AND minX <= -80.5 AND maxY >= 39.5 AND minY <= 39.8 ORDER BY id",
    ),
  );
});

matrixBoth("fts3 MATCH", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE t3 USING fts3(content)").ok).toBe(true);
    expect(db.exec("INSERT INTO t3(content) VALUES ('hello sqlite world')").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT content FROM t3 WHERE t3 MATCH 'sqlite'"),
    sqlite.query("SELECT content FROM t3 WHERE t3 MATCH 'sqlite'"),
  );
});

matrixBoth("fts4 MATCH", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE t4 USING fts4(content)").ok).toBe(true);
    expect(db.exec("INSERT INTO t4(content) VALUES ('hello sqlite world')").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT content FROM t4 WHERE content MATCH 'sqlite'"),
    sqlite.query("SELECT content FROM t4 WHERE content MATCH 'sqlite'"),
  );
});

matrixBoth("dbstat virtual table", (memory, sqlite) => {
  expect(memory.exec("CREATE TABLE t(x)").ok).toBe(true);
  expect(memory.exec("INSERT INTO t VALUES (1)").ok).toBe(true);
  expect(memory.exec("CREATE VIRTUAL TABLE temp.stat USING dbstat").ok).toBe(true);
  const memRows = memory.query("SELECT name FROM temp.stat WHERE name = 't' LIMIT 1");
  expect(memRows.ok).toBe(true);
  expect(memRows.rows.length).toBeGreaterThan(0);

  expect(sqlite.exec("CREATE TABLE t(x)").ok).toBe(true);
  expect(sqlite.exec("INSERT INTO t VALUES (1)").ok).toBe(true);
  const sqliteMod = sqlite.exec("CREATE VIRTUAL TABLE temp.stat USING dbstat");
  if (!sqliteMod.ok) {
    // bun:sqlite is often built without SQLITE_ENABLE_DBSTAT_VTAB (Linux CI).
    return;
  }
  expectParity(memRows, sqlite.query("SELECT name FROM temp.stat WHERE name = 't' LIMIT 1"));
});

parity(
  "rtreecheck ok",
  ["CREATE VIRTUAL TABLE demo USING rtree(id, minX, maxX, minY, maxY)", "INSERT INTO demo VALUES(1,0,1,0,1)"],
  "SELECT rtreecheck('demo') AS v",
);

parity("fts5_source_id present", [], "SELECT length(fts5_source_id()) > 5 AS ok");

matrixBoth("dbstat columns match oracle when the module exists; pages are synthetic", (memory, sqlite) => {
  expect(memory.exec("CREATE TABLE t(x)").ok).toBe(true);
  expect(memory.exec("INSERT INTO t VALUES (1)").ok).toBe(true);
  expect(memory.exec("CREATE VIRTUAL TABLE temp.stat USING dbstat").ok).toBe(true);
  const mem = memory.query("SELECT * FROM temp.stat WHERE name = 't' LIMIT 1");
  expect(mem.ok).toBe(true);
  expect(mem.rows.length).toBeGreaterThan(0);
  expect(mem.rows[0]?.name).toBe("t");

  expect(sqlite.exec("CREATE TABLE t(x)").ok).toBe(true);
  expect(sqlite.exec("INSERT INTO t VALUES (1)").ok).toBe(true);
  const created = sqlite.exec("CREATE VIRTUAL TABLE temp.stat USING dbstat");
  if (!created.ok) return;
  const ora = sqlite.query("SELECT * FROM temp.stat WHERE name = 't' LIMIT 1");
  expect(ora.ok).toBe(true);
  expect(mem.columns).toEqual(ora.columns);
});

matrixBoth("bytecode virtual table is an empty cursor with oracle columns", (memory, sqlite) => {
  const memCreate = memory.exec("CREATE VIRTUAL TABLE bc USING bytecode");
  const oraCreate = sqlite.exec("CREATE VIRTUAL TABLE bc USING bytecode");
  expect(memCreate.ok).toBe(true);
  if (!oraCreate.ok) return;
  const actual = memory.query("SELECT * FROM bc");
  const oracle = sqlite.query("SELECT * FROM bc");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.rows).toEqual([]);
});

matrixBoth("tables_used virtual table is an empty cursor with oracle columns", (memory, sqlite) => {
  const memCreate = memory.exec("CREATE VIRTUAL TABLE tu USING tables_used");
  const oraCreate = sqlite.exec("CREATE VIRTUAL TABLE tu USING tables_used");
  expect(memCreate.ok).toBe(true);
  if (!oraCreate.ok) return;
  const actual = memory.query("SELECT * FROM tu");
  const oracle = sqlite.query("SELECT * FROM tu");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.rows).toEqual([]);
});
