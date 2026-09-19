import { expect, test } from "bun:test";
import { Database, Snapshot, SqliteError } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { expectStateParity } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("SQL behavior matches before snapshot", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER,name TEXT)", "INSERT INTO t VALUES (1,'a'),(2,'b')"]);
  expectParity(memory.query("SELECT * FROM t ORDER BY id"), sqlite.query("SELECT * FROM t ORDER BY id"));
});

/**
 * Behavioral A/B: both engines run the same ops; memory snapshot/restore must stay
 * lockstep with the live oracle under identical post-restore SQL (SQLM ≠ serialize()).
 */
matrixBoth("post-restore DML stays in lockstep with oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INT DEFAULT 0)",
    "CREATE INDEX t_n ON t(n)",
    "INSERT INTO t(name, n) VALUES ('a', 1),('b', 0)",
  ]);
  expectStateParity(memory, sqlite);

  const snap = memory.snapshot();
  memory.exec("INSERT INTO t(name, n) VALUES ('gone', 9)");
  memory.restore(snap);

  const ops = [
    "INSERT INTO t(name, n) VALUES ('c', 2)",
    "UPDATE t SET n = n + 1 WHERE name = 'b'",
    "DELETE FROM t WHERE name = 'a'",
  ];
  for (const sql of ops) {
    expectParity(memory.exec(sql), sqlite.exec(sql));
  }
  expectParity(
    memory.query("SELECT id, name, n FROM t ORDER BY id"),
    sqlite.query("SELECT id, name, n FROM t ORDER BY id"),
  );
  expectStateParity(memory, sqlite);
});

test("memory snapshot restores into a new adapter", () => {
  const source = new InMemoryAdapter();
  const restored = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT)");
    source.exec("INSERT INTO t(name) VALUES ('a'),('b')");
    restored.restore(source.snapshot());
    expectParity(restored.query("SELECT * FROM t ORDER BY id"), source.query("SELECT * FROM t ORDER BY id"));
  } finally {
    source.close();
    restored.close();
  }
});

test("memory snapshot roundtrip discards later mutations", () => {
  const db = new InMemoryAdapter();
  try {
    db.exec("CREATE TABLE t(id INTEGER)");
    db.exec("INSERT INTO t VALUES (1),(2)");
    const bytes = db.snapshot();
    db.exec("INSERT INTO t VALUES (3)");
    db.restore(bytes);
    const result = db.query("SELECT id FROM t ORDER BY id");
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  } finally {
    db.close();
  }
});

test("snapshot preserves schema constraints and defaults", () => {
  const source = new InMemoryAdapter();
  const restored = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT NOT NULL DEFAULT 'x')");
    restored.restore(source.snapshot());
    expect(restored.exec("INSERT INTO t DEFAULT VALUES").ok).toBe(true);
    expect(restored.query("SELECT * FROM t").rows).toEqual([{ id: 1, label: "x" }]);
    expect(restored.exec("INSERT INTO t(label) VALUES (NULL)").error?.category).toBe("constraint_notnull");
  } finally {
    source.close();
    restored.close();
  }
});

test("snapshot clone stays in lockstep under identical ops", () => {
  const source = new InMemoryAdapter();
  const clone = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INT DEFAULT 0)");
    source.exec("CREATE INDEX t_n ON t(n)");
    source.exec("CREATE VIEW v AS SELECT id, name FROM t WHERE n > 0");
    source.exec("INSERT INTO t(name, n) VALUES ('a', 1),('b', 0)");
    clone.restore(source.snapshot());

    const ops = [
      "INSERT INTO t(name, n) VALUES ('c', 2)",
      "UPDATE t SET n = n + 1 WHERE name = 'b'",
      "DELETE FROM t WHERE name = 'a'",
    ];
    for (const sql of ops) {
      expectParity(source.exec(sql), clone.exec(sql));
    }
    expectParity(
      source.query("SELECT id, name, n FROM t ORDER BY id"),
      clone.query("SELECT id, name, n FROM t ORDER BY id"),
    );
    expectParity(source.query("SELECT * FROM v ORDER BY id"), clone.query("SELECT * FROM v ORDER BY id"));
    expectParity(
      source.query("SELECT name FROM sqlite_master WHERE type IN ('index','view') ORDER BY name"),
      clone.query("SELECT name FROM sqlite_master WHERE type IN ('index','view') ORDER BY name"),
    );
  } finally {
    source.close();
    clone.close();
  }
});

test("snapshot preserves rowids across restore and further inserts", () => {
  const source = new InMemoryAdapter();
  const clone = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    source.exec("INSERT INTO t(id, name) VALUES (10, 'x')");
    source.exec("INSERT INTO t(name) VALUES ('y')");
    clone.restore(source.snapshot());
    expectParity(source.query("SELECT id, name FROM t ORDER BY id"), clone.query("SELECT id, name FROM t ORDER BY id"));
    expectParity(source.exec("INSERT INTO t(name) VALUES ('z')"), clone.exec("INSERT INTO t(name) VALUES ('z')"));
    expectParity(source.query("SELECT id, name FROM t ORDER BY id"), clone.query("SELECT id, name FROM t ORDER BY id"));
  } finally {
    source.close();
    clone.close();
  }
});

test("decode rejects newer snapshot format version", () => {
  const db = new Database();
  db.exec("CREATE TABLE t(id INTEGER)");
  const snap = db.snapshot().encode();
  // SQLM + little-endian u32 version at offset 4
  const bumped = new Uint8Array(snap);
  const view = new DataView(bumped.buffer, bumped.byteOffset, bumped.byteLength);
  const current = view.getUint32(4, true);
  view.setUint32(4, current + 1, true);
  try {
    Snapshot.decode(bumped);
    expect.unreachable("expected decode to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(SqliteError);
    expect((err as SqliteError).category).toBe("snapshot_version");
    expect((err as SqliteError).sqliteCode).toBe("SQLITE_FORMAT");
    expect((err as SqliteError).code).toBe("SQLITE_FORMAT");
  }
  db.close();
});

test("decode rejects corrupt magic with a distinct error", () => {
  const db = new Database();
  db.exec("CREATE TABLE t(id INTEGER)");
  const snap = db.snapshot().encode();
  const corrupt = new Uint8Array(snap);
  corrupt[0] = "X".charCodeAt(0);
  try {
    Snapshot.decode(corrupt);
    expect.unreachable("expected decode to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(SqliteError);
    expect((err as SqliteError).category).toBe("other");
    expect((err as SqliteError).message).toMatch(/magic/);
    expect((err as SqliteError).category).not.toBe("snapshot_version");
  }
  db.close();
});

test("current snapshot version round-trips", () => {
  const a = new Database({ seed: 7 });
  a.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  a.prepare("INSERT INTO t(name) VALUES (?)").run("Ada");
  const snap = a.snapshot();
  const bytes = snap.encode();
  expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe("SQLM");
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  expect(version).toBe(5);
  const b = snap.open();
  expect(b.query("SELECT name FROM t")).toEqual([{ name: "Ada" }]);
  a.close();
  b.close();
});

test("decode rejects legacy SQLM v4 blobs", () => {
  const legacy = new Uint8Array(8);
  legacy.set([0x53, 0x51, 0x4c, 0x4d]); // SQLM
  new DataView(legacy.buffer).setUint32(4, 4, true);
  try {
    Snapshot.decode(legacy);
    expect.unreachable("expected decode to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(SqliteError);
    expect((err as SqliteError).category).toBe("snapshot_version");
  }
});

test("SQLM v5 round-trips index stores and is byte-stable", () => {
  const a = new Database({ seed: 3 });
  a.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  a.exec("INSERT INTO t(name) VALUES ('a'), ('b')");
  const snap = a.snapshot();
  const bytes = snap.encode();
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(5);
  const b = snap.open();
  expect([...b.snapshot().encode()]).toEqual([...bytes]);
  expect(() => b.exec("INSERT INTO t(name) VALUES ('a')")).toThrow(/UNIQUE/);
  a.close();
  b.close();
});

test("open isolates writes and preserves encode bytes", () => {
  const parent = new Database();
  parent.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  parent.exec("INSERT INTO t(name) VALUES ('a')");
  const child = parent.snapshot().open();
  expect([...child.snapshot().encode()]).toEqual([...parent.snapshot().encode()]);
  child.exec("INSERT INTO t(name) VALUES ('b')");
  expect(parent.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "a" }]);
  expect(child.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "a" }, { name: "b" }]);
  parent.close();
  child.close();
});

test("decode hydrates independently and does not mutate input bytes", () => {
  const source = new Database();
  source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  source.exec("INSERT INTO t(name) VALUES ('a')");
  const snap = source.snapshot();
  const original = Uint8Array.from(snap.encode());
  const opened = snap.open();
  expect([...snap.encode()]).toEqual([...original]);
  expect(opened.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
  opened.exec("INSERT INTO t(name) VALUES ('b')");
  expect(source.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
  source.close();
  opened.close();
});

test("Snapshot.open is copy-on-write isolated from the template", () => {
  const template = new Database();
  template.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  template.exec("INSERT INTO t(name) VALUES ('a')");
  const seed = template.snapshot();
  const a = seed.open();
  const b = seed.open();
  a.exec("INSERT INTO t(name) VALUES ('b')");
  expect(b.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "a" }]);
  expect(template.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "a" }]);
  template.close();
  a.close();
  b.close();
});

test("decode reuses the same Uint8Array via WeakMap", () => {
  const source = new Database();
  source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  source.exec("INSERT INTO t(name) VALUES ('a')");
  const bytes = source.snapshot().encode();
  const first = Snapshot.decode(bytes).open();
  first.exec("INSERT INTO t(name) VALUES ('b')");
  const second = Snapshot.decode(bytes).open();
  expect(second.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "a" }]);
  source.close();
  first.close();
  second.close();
});

test("snapshot rejects an open transaction", () => {
  const db = new Database();
  db.exec("BEGIN");
  expect(() => db.snapshot()).toThrow(SqliteError);
  db.exec("ROLLBACK");
  db.close();
});
