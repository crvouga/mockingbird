import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "DML schema sharing preserves virtual/stored generated column order and RETURNING",
  ["CREATE TABLE t(a INT, v INT GENERATED ALWAYS AS (a + 1) VIRTUAL, b INT, s INT GENERATED ALWAYS AS (b + 2) STORED)"],
  [
    { sql: "INSERT INTO t(a,b) VALUES (1,10) RETURNING *", query: true },
    { sql: "UPDATE t SET a = a + 1, b = b + 1 RETURNING *", query: true },
    { sql: "DELETE FROM t RETURNING *", query: true },
  ],
);

for (const hydrated of [false, true]) {
  test(`DML forks isolate schema metadata through ALTER, indexes and nested rollback (hydrated=${hydrated})`, () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT DEFAULT 'before', k INT CHECK(k > 0))");
    db.exec("INSERT INTO t(id,k) VALUES (1,1)");
    db.exec("CREATE INDEX idx_k ON t(k)");
    const snapshot = db.snapshot();
    const original = hydrated ? Snapshot.decode(snapshot.encode()) : snapshot;
    const left = original.open();
    const right = original.open();
    right.exec("UPDATE t SET value = 'right', k = 2 WHERE id = 1");
    left.exec("UPDATE t SET value = 'left' WHERE id = 1");
    left.exec("ALTER TABLE t ADD COLUMN added TEXT DEFAULT 'extra'");
    left.exec("CREATE INDEX idx_value ON t(value)");
    left.exec("ALTER TABLE t RENAME COLUMN value TO renamed");
    left.exec("ALTER TABLE t RENAME COLUMN k TO positive");
    expect(left.query("SELECT renamed, added FROM t")).toEqual([{ renamed: "left", added: "extra" }]);
    expect(() =>
      right.transaction(() => {
        right.exec("UPDATE t SET value = 'temporary' WHERE id = 1");
        right.exec("SAVEPOINT nested; ALTER TABLE t ADD COLUMN lost INT; ROLLBACK TO nested; RELEASE nested");
        right.exec("ALTER TABLE t RENAME COLUMN value TO lost");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    right.exec("INSERT INTO t(id,k) VALUES (2,2)");
    expect(right.query("SELECT id, value, k FROM t ORDER BY id")).toEqual([
      { id: 1, value: "right", k: 2 },
      { id: 2, value: "before", k: 2 },
    ]);
    expect(() => right.exec("INSERT INTO t(id,k) VALUES (3,-1)")).toThrow();
    const historical = original.open();
    expect(historical.query("SELECT * FROM t")).toEqual([{ id: 1, value: "before", k: 1 }]);
    expect(historical.query("SELECT value FROM t WHERE k = 1")).toEqual([{ value: "before" }]);
    expect(historical.query("SELECT name FROM sqlite_master WHERE type = 'index'")).toEqual([{ name: "idx_k" }]);
    const reencoded = Snapshot.decode(right.snapshot().encode()).open();
    expect(reencoded.query("SELECT * FROM t ORDER BY id")).toEqual(right.query("SELECT * FROM t ORDER BY id"));
    reencoded.close();
    historical.close();
    left.close();
    right.close();
    db.close();
  });
}
