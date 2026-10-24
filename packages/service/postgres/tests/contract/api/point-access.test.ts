import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { parity, sequenceParity } from "../helpers.ts";

const setup = [
  "CREATE TABLE t (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  "INSERT INTO t VALUES (1,10),(2,20),(3,30)",
];

for (const predicate of ["id = $1", "t.id = $1", "$1 = id", "id = $1::int", "id = ($1 + 0)"]) {
  sequenceParity(`point update preserves rows, counters and RETURNING: ${predicate}`, setup, [
    { sql: `UPDATE t SET value = value + 1 WHERE ${predicate} RETURNING id, value`, params: [2], query: true },
    { sql: "SELECT id, value FROM t ORDER BY id", query: true },
    { sql: `SELECT * FROM t WHERE ${predicate}`, params: [2], query: true },
    { sql: `SELECT COUNT(*) AS n FROM t WHERE ${predicate}`, params: [99], query: true },
  ]);
}

test("point updates preserve wider numeric and NULL bind behavior of the existing full path", () => {
  const fast = new Database();
  const full = new Database();
  for (const sql of setup) {
    fast.exec(sql);
    full.exec(sql);
  }
  for (const value of [2147483648n, 1.5, null]) {
    expect(fast.prepare("UPDATE t SET value = 7 WHERE id = $1").run(value)).toEqual(
      full.prepare("UPDATE t SET value = 7 WHERE (id + 0) = $1").run(value),
    );
    expect(fast.query("SELECT * FROM t ORDER BY id")).toEqual(full.query("SELECT * FROM t ORDER BY id"));
  }
  fast.close();
  full.close();
});

parity(
  "point reads preserve source aliases and whole-row projection",
  setup,
  "SELECT t, t.* FROM t AS t WHERE t.id = $1",
  [2],
);
parity(
  "point reads preserve CTE column metadata",
  setup,
  "WITH rows AS (SELECT id, value FROM t) SELECT * FROM rows WHERE id = $1",
  [2],
);
parity(
  "point reads preserve explicit column aliases",
  setup,
  "SELECT source.* FROM t AS source(id, value) WHERE source.id = $1",
  [2],
);

test("DML tuple sharing preserves historical values and xmin through later in-place DDL", () => {
  const seed = new Database();
  for (const sql of setup) seed.exec(sql);
  const template = seed.snapshot();
  for (const db of [template.open(), Snapshot.decode(template.encode().slice()).open()]) {
    const before = db.snapshot();
    const expected = before.open().query("SELECT id, value, xmin::text FROM t ORDER BY id");
    db.transaction(() => {
      db.prepare("UPDATE t SET value = value + 100 WHERE id = $1").run(1);
      db.exec("INSERT INTO t VALUES (4,40); DELETE FROM t WHERE id = 3");
    });
    // Table is now writable but unchanged tuple arrays can still belong to the checkpoint.
    db.exec("ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 9");
    db.exec("ALTER TABLE t ALTER COLUMN value TYPE BIGINT");
    db.exec("ALTER TABLE t DROP COLUMN extra");
    const historical = before.open();
    expect(historical.query("SELECT id, value, xmin::text FROM t ORDER BY id")).toEqual(expected);
    expect(db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
    historical.close();
    db.close();
  }
  seed.close();
});

test("shared tuples survive nested savepoints, schema rollback and sibling branches", () => {
  const db = new Database();
  for (const sql of setup) db.exec(sql);
  const before = db.snapshot();
  const sibling = before.open();
  db.exec("BEGIN; UPDATE t SET value = 11 WHERE id = 1; SAVEPOINT inner_work");
  db.exec("UPDATE t SET value = 22 WHERE id = 2; ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'added'");
  db.exec("ROLLBACK TO inner_work; RELEASE inner_work; COMMIT");
  expect(db.query("SELECT * FROM t ORDER BY id")).toEqual([
    { id: 1, value: 11 },
    { id: 2, value: 20 },
    { id: 3, value: 30 },
  ]);
  sibling.exec("UPDATE t SET value = 99 WHERE id = 3; ALTER TABLE t DROP COLUMN value");
  expect(db.query("SELECT value FROM t WHERE id = 3")).toEqual([{ value: 30 }]);
  const historical = before.open();
  expect(historical.query("SELECT value FROM t WHERE id = 3")).toEqual([{ value: 30 }]);
  historical.close();
  sibling.close();
  db.close();
});

test("RETURN OLD trigger preserves the checkpoint's tuple and xmin", () => {
  const db = new Database();
  for (const sql of setup) db.exec(sql);
  db.exec("CREATE FUNCTION keep_old() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$");
  db.exec("CREATE TRIGGER keep_old BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION keep_old()");
  const before = db.snapshot();
  const historical = before.open();
  const expected = historical.query("SELECT id, value, xmin::text FROM t ORDER BY id");
  db.exec("UPDATE t SET value = 999 WHERE id = 2");
  expect(historical.query("SELECT id, value, xmin::text FROM t ORDER BY id")).toEqual(expected);
  expect(db.query("SELECT value FROM t WHERE id = 2")).toEqual([{ value: 20 }]);
  historical.close();
  db.close();
});

test("optimized SELECT records exactly one index scan and UPDATE keeps its existing counters", () => {
  const db = new Database();
  for (const sql of setup) db.exec(sql);
  const scans = () =>
    Number(db.query("SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 't_pkey'")[0]?.idx_scan);
  const before = scans();
  db.prepare("SELECT value FROM t WHERE id = $1").get(2);
  expect(scans()).toBe(before + 1);
  db.prepare("UPDATE t SET value = value + 1 WHERE id = $1").run(2);
  expect(scans()).toBe(before + 1);
  db.close();
});
