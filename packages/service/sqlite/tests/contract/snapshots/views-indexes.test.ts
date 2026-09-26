import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { expectStateParity } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

// SNP-obj-02: view + index probes after restore
matrixBoth("view and covering index queries match oracle after restore", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)",
    "CREATE INDEX t_a ON t(a)",
    "CREATE VIEW active AS SELECT id, a, b FROM t WHERE a IS NOT NULL",
    "INSERT INTO t VALUES (1, 10, 'alpha'), (2, 20, 'beta'), (3, NULL, 'gamma')",
  ]);

  const probes = [
    "SELECT id, a, b FROM active ORDER BY id",
    "SELECT id, a FROM t WHERE a = 10 ORDER BY id",
    "SELECT name, origin FROM pragma_index_list('t') ORDER BY name",
  ];
  const before = Object.fromEntries(probes.map((sql) => [sql, memory.query(sql)]));

  const snap = memory.snapshot();
  memory.exec("DROP INDEX t_a");
  memory.exec("DELETE FROM t");
  memory.restore(snap);

  expectStateParity(memory, sqlite);
  for (const sql of probes) {
    expect(memory.query(sql).rows).toEqual(sqlite.query(sql).rows);
    expect(memory.query(sql).rows).toEqual(before[sql]!.rows);
  }
});

test("Snapshot.open preserves view-backed aggregates", () => {
  const db = new Database({ seed: 11 });
  try {
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, grp TEXT, n INT)");
    db.exec("CREATE VIEW sums AS SELECT grp, sum(n) AS total FROM t GROUP BY grp");
    db.exec("INSERT INTO t VALUES (1, 'a', 1), (2, 'a', 2), (3, 'b', 3)");
    const before = db.query("SELECT grp, total FROM sums ORDER BY grp");
    const child = db.snapshot().open();
    expect(child.query("SELECT grp, total FROM sums ORDER BY grp")).toEqual(before);
    child.exec("INSERT INTO t VALUES (4, 'b', 4)");
    expect(db.query("SELECT grp, total FROM sums ORDER BY grp")).toEqual(before);
    child.close();
  } finally {
    db.close();
  }
});

test("cross-adapter restore keeps index metadata and view rows", () => {
  const source = new InMemoryAdapter();
  const target = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
    source.exec("CREATE INDEX t_a ON t(a)");
    source.exec("CREATE VIEW v AS SELECT id, a FROM t");
    source.exec("INSERT INTO t VALUES (1, 5), (2, 6)");
    target.restore(source.snapshot());
    expect(target.query("SELECT id, a FROM v ORDER BY id").rows).toEqual([
      { id: 1, a: 5 },
      { id: 2, a: 6 },
    ]);
    expect(target.query("SELECT id FROM t WHERE a = 5 ORDER BY id").rows).toEqual([{ id: 1 }]);
  } finally {
    source.close();
    target.close();
  }
});
