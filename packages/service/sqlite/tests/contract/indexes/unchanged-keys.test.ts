import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "updating only payload preserves composite index lookups and failed-write rollback",
  [
    "CREATE TABLE records (namespace TEXT, id TEXT, seq INTEGER, value TEXT NOT NULL, PRIMARY KEY(namespace, id))",
    "CREATE INDEX records_seq ON records(namespace, seq)",
    "INSERT INTO records VALUES ('a','one',1,'before'),('a','two',2,'other')",
  ],
  [
    { sql: "UPDATE records SET value = 'after' WHERE namespace = 'a' AND id = 'one'" },
    { sql: "SELECT id, value FROM records WHERE namespace = 'a' AND seq = 1", query: true },
    { sql: "UPDATE records SET value = NULL WHERE namespace = 'a' AND id = 'one'" },
    { sql: "SELECT * FROM records ORDER BY seq", query: true },
    { sql: "UPDATE records SET seq = 3, value = 'moved' WHERE namespace = 'a' AND id = 'one'" },
    { sql: "SELECT * FROM records WHERE namespace = 'a' ORDER BY seq", query: true },
  ],
);

test("unchanged singleton indexes remain isolated across snapshots and transaction rollback", () => {
  const db = new Database();
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, key TEXT UNIQUE, value TEXT NOT NULL)");
  db.exec("INSERT INTO t VALUES (1,'one','before'),(2,'two','other')");
  const original = db.snapshot();
  db.prepare("UPDATE t SET value = ? WHERE key = ?").run("after", "one");
  expect(() =>
    db.transaction(() => {
      db.exec("UPDATE t SET value = 'temporary' WHERE key = 'one'");
      db.exec("UPDATE t SET value = NULL WHERE key = 'two'");
    }),
  ).toThrow();
  expect(db.query("SELECT value FROM t WHERE key = 'one'")).toEqual([{ value: "after" }]);
  const historical = original.open();
  expect(historical.query("SELECT value FROM t WHERE key = 'one'")).toEqual([{ value: "before" }]);
  historical.close();
  db.close();
});

test("duplicate and NULL index buckets preserve their established remove/append ordering", () => {
  for (const key of ["7", "NULL"]) {
    const db = new Database();
    db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, key INT, value INT); CREATE INDEX idx_key ON t(key);
      INSERT INTO t VALUES (1,${key},10),(2,${key},20)`);
    db.exec("UPDATE t SET value = value + 1 WHERE id = 1");
    const entries = db.state.indexes.get("idx_key")?.store.snapshotEntries();
    expect(entries?.[0]?.rowids).toEqual([2, 1]);
    db.close();
  }
});
