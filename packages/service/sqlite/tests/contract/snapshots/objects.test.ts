import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { expectStateParity } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

// SNP-obj-01: partial/expr/unique indexes, FK, WITHOUT ROWID, STRICT, GENERATED
const cases = [
  {
    name: "partial index",
    setup: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, flag INT)",
      "CREATE INDEX idx_partial ON t(v) WHERE flag = 1",
      "INSERT INTO t VALUES (1, 10, 1), (2, 20, 0)",
    ],
    probes: [
      "SELECT id, v, flag FROM t WHERE flag = 1 AND v = 10 ORDER BY id",
      "SELECT name, partial FROM pragma_index_list('t') ORDER BY name",
    ],
  },
  {
    name: "expression index",
    setup: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)",
      "CREATE INDEX idx_expr ON t(v + 1)",
      "INSERT INTO t VALUES (1, 5), (2, 9)",
    ],
    probes: ["SELECT id, v FROM t WHERE v + 1 = 6 ORDER BY id"],
  },
  {
    name: "unique index",
    setup: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)",
      "CREATE UNIQUE INDEX t_label ON t(label)",
      "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
    ],
    probes: ["SELECT id, label FROM t ORDER BY label"],
  },
  {
    name: "FK parent/child",
    setup: [
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
      "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)",
      "INSERT INTO parent VALUES (1)",
      "INSERT INTO child VALUES (1, 1)",
    ],
    probes: [
      "SELECT id FROM parent ORDER BY id",
      "SELECT id, parent_id FROM child ORDER BY id",
      "SELECT c.id FROM child c JOIN parent p ON c.parent_id = p.id ORDER BY c.id",
    ],
  },
  {
    name: "WITHOUT ROWID",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, a INT) WITHOUT ROWID", "INSERT INTO t VALUES (1, 10), (2, 20)"],
    probes: ["SELECT id, a FROM t ORDER BY id"],
  },
  {
    name: "STRICT",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT) STRICT", "INSERT INTO t VALUES (1, 10, 'x')"],
    probes: ["SELECT id, a, b FROM t ORDER BY id"],
  },
  {
    name: "GENERATED STORED",
    setup: [
      "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, g INT GENERATED ALWAYS AS (a + 1) STORED)",
      "INSERT INTO t(id, a) VALUES (1, 10)",
    ],
    probes: ["SELECT id, a, g FROM t ORDER BY id"],
  },
] as const;

for (const c of cases) {
  test(`snapshot round-trip preserves ${c.name}`, () => {
    const source = new Database({ seed: 7 });
    try {
      for (const sql of c.setup) source.exec(sql);
      const before = Object.fromEntries(c.probes.map((sql) => [sql, source.query(sql)]));
      const restored = source.snapshot().open();
      for (const sql of c.probes) {
        expect(restored.query(sql)).toEqual(before[sql]);
      }
      restored.close();
    } finally {
      source.close();
    }
  });
}

matrixBoth("snapshot preserves view + index queries vs oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)",
    "CREATE INDEX t_a ON t(a)",
    "CREATE VIEW v AS SELECT id, a FROM t WHERE a > 0",
    "INSERT INTO t VALUES (1, 5, 'x'), (2, 0, 'y'), (3, 9, 'z')",
  ]);
  const snap = memory.snapshot();
  memory.exec("DELETE FROM t");
  memory.restore(snap);
  expectStateParity(memory, sqlite);
  const probes = ["SELECT id, a FROM v ORDER BY id", "SELECT id, a, b FROM t WHERE a > 0 ORDER BY id"];
  for (const sql of probes) {
    expect(memory.query(sql).rows).toEqual(sqlite.query(sql).rows);
  }
});

test("restore into a fresh adapter preserves indexed lookups", () => {
  const source = new InMemoryAdapter();
  const target = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
    source.exec("CREATE INDEX t_a ON t(a)");
    source.exec("INSERT INTO t VALUES (1, 10), (2, 20)");
    target.restore(source.snapshot());
    expect(target.query("SELECT id FROM t WHERE a = 10 ORDER BY id").rows).toEqual([{ id: 1 }]);
    expect(target.query("SELECT name FROM pragma_index_list('t') ORDER BY name").rows.length).toBeGreaterThan(0);
  } finally {
    source.close();
    target.close();
  }
});
