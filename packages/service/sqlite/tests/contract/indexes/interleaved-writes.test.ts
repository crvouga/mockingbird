import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

// An index keeps its key order through inserts and deletes instead of sorting every key again,
// and a table hands its equality hashes to a transaction's copy instead of rebuilding them. Both
// must stay exact through interleaved writes, lookups and rolled-back savepoints.

const steps = (): Array<{ sql: string; query?: boolean }> => {
  const out: Array<{ sql: string; query?: boolean }> = [];
  for (let i = 0; i < 40; i++) {
    const collection = ["b", "a", "c"][i % 3];
    out.push({ sql: `INSERT INTO records VALUES ('ns','${collection}','id${i}',${40 - i},'v${i}')` });
    if (i % 5 === 0) out.push({ sql: `DELETE FROM records WHERE id = 'id${i - 2}'` });
    if (i % 7 === 0) {
      out.push({ sql: "SAVEPOINT s" });
      out.push({ sql: `INSERT INTO records VALUES ('ns','a','gone${i}',${i},'gone')` });
      out.push({ sql: `DELETE FROM records WHERE id = 'id${i - 1}'` });
      out.push({ sql: "SELECT id FROM records WHERE namespace = 'ns' AND collection = 'a' ORDER BY seq", query: true });
      out.push({ sql: "ROLLBACK TO s" });
      out.push({ sql: "RELEASE s" });
    }
    out.push({ sql: "SELECT id, seq FROM records WHERE namespace = 'ns' AND collection = 'a' ORDER BY seq", query: true });
    out.push({ sql: "SELECT id FROM records WHERE value = 'v3'", query: true });
  }
  out.push({ sql: "SELECT id FROM records WHERE namespace = 'ns' AND seq BETWEEN 5 AND 25 ORDER BY seq", query: true });
  return out;
};

sequenceParity(
  "prefix, equality and range lookups stay exact through interleaved writes and rolled-back savepoints",
  [
    "CREATE TABLE records (namespace TEXT, collection TEXT, id TEXT, seq INTEGER, value TEXT, PRIMARY KEY(namespace, collection, id))",
    "CREATE INDEX records_seq ON records(namespace, collection, seq)",
    "CREATE INDEX records_ns_seq ON records(namespace, seq)",
  ],
  steps(),
);

test("a rolled-back transaction leaves the table's lookups as they were", () => {
  const db = new Database();
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, v TEXT)");
  db.exec("CREATE INDEX t_k ON t(k)");
  for (let i = 0; i < 64; i++) db.prepare("INSERT INTO t VALUES (?, ?, ?)").run(i, `k${i % 8}`, `v${i}`);
  const before = db.prepare("SELECT id FROM t WHERE v = 'v9'").all();
  const prefix = db.prepare("SELECT id FROM t WHERE k = 'k1' ORDER BY id").all();
  expect(() =>
    db.transaction(() => {
      db.exec("DELETE FROM t WHERE v = 'v9'");
      db.exec("INSERT INTO t VALUES (100, 'k1', 'v9')");
      expect(db.prepare("SELECT id FROM t WHERE v = 'v9'").all()).toEqual([{ id: 100 }]);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(db.prepare("SELECT id FROM t WHERE v = 'v9'").all()).toEqual(before);
  expect(db.prepare("SELECT id FROM t WHERE k = 'k1' ORDER BY id").all()).toEqual(prefix);
});
