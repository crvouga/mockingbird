import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { DEFAULT_NOW, Prng } from "../../../src/unstable.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";

describe("determinism", () => {
  test("identical seeds produce identical random() streams", () => {
    const a = new Database({ seed: 42 });
    const b = new Database({ seed: 42 });
    const left = a.query<{ v: bigint | number }>(
      "SELECT random() AS v UNION ALL SELECT random() AS v UNION ALL SELECT random() AS v",
    );
    const right = b.query<{ v: bigint | number }>(
      "SELECT random() AS v UNION ALL SELECT random() AS v UNION ALL SELECT random() AS v",
    );
    expect(left.map((row) => String(row.v))).toEqual(right.map((row) => String(row.v)));
  });

  test("different seeds diverge", () => {
    const a = new Database({ seed: 1 });
    const b = new Database({ seed: 2 });
    const left = a.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v;
    const right = b.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v;
    expect(String(left)).not.toEqual(String(right));
  });

  test("date('now') is fixed by default", () => {
    const db = new Database();
    const row = db.query<{ d: string }>("SELECT date('now') AS d")[0]!;
    expect(row.d).toBe("2000-01-01");
    expect(DEFAULT_NOW.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  test("injectable clock overrides now", () => {
    const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
    expect(db.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2012-06-15");
    expect(db.query<{ t: string }>("SELECT time('now') AS t")[0]!.t).toBe("12:34:56");
  });

  test("snapshots are byte-identical for equivalent logical state", () => {
    const setup = (db: Database) => {
      db.exec("CREATE TABLE z(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO z(name) VALUES ('z')");
      db.exec("INSERT INTO a(name) VALUES ('a')");
      db.exec("CREATE INDEX idx_z ON z(name)");
      db.exec("CREATE INDEX idx_a ON a(name)");
    };
    const left = new Database({ seed: 7 });
    const right = new Database({ seed: 7 });
    setup(left);
    setup(right);
    expect([...left.snapshot().encode()]).toEqual([...right.snapshot().encode()]);
  });

  test("Prng is deterministic across clones of state", () => {
    const p = new Prng(99);
    const values = [p.nextSqliteRandom(), p.nextSqliteRandom(), p.nextSqliteRandom()].map(String);
    const q = new Prng(99);
    expect([q.nextSqliteRandom(), q.nextSqliteRandom(), q.nextSqliteRandom()].map(String)).toEqual(values);
  });

  test("bound -0 becomes +0", () => {
    const db = new InMemoryAdapter();
    db.exec("CREATE TABLE t(x REAL)");
    db.exec("INSERT INTO t(x) VALUES (?)", [-0]);
    const result = db.query("SELECT x, typeof(x) AS t FROM t");
    expect(result.ok).toBe(true);
    expect(Object.is(result.rows[0]!.x, -0)).toBe(false);
    expect(result.rows[0]!.x).toBe(0);
    db.close();
  });

  test("expression -0 is canonicalized like bind", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(x)");
    db.exec("INSERT INTO t(x) VALUES (-1.0 * 0.0)");
    const before = db.query<{ x: number }>("SELECT x FROM t")[0]!.x;
    expect(Object.is(before, -0)).toBe(false);
    expect(before).toBe(0);
    const snap = db.snapshot();
    const restored = snap.open();
    const after = restored.query<{ x: number }>("SELECT x FROM t")[0]!.x;
    expect(Object.is(after, -0)).toBe(false);
    expect(after).toBe(0);
  });

  test("random() continues after snapshot restore on a fresh database", () => {
    const source = new Database({ seed: 42 });
    const first = String(source.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);
    const snap = source.snapshot();
    const secondOnSource = String(source.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);

    const restored = snap.open({ seed: 999 });
    const secondOnRestored = String(restored.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);
    expect(secondOnRestored).toBe(secondOnSource);
    expect(secondOnRestored).not.toBe(first);
  });

  test("ROLLBACK restores random() stream", () => {
    const db = new Database({ seed: 11 });
    const baseline = new Database({ seed: 11 });
    const expectedFirst = String(baseline.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);

    db.exec("BEGIN");
    db.query("SELECT random() AS v");
    db.exec("ROLLBACK");

    const afterRollback = String(db.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);
    expect(afterRollback).toBe(expectedFirst);
  });

  test("unordered SELECT and group_concat are stable across restore", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("INSERT INTO t(id, v) VALUES (3, 'c')");
    db.exec("INSERT INTO t(id, v) VALUES (1, 'a')");
    db.exec("INSERT INTO t(id, v) VALUES (2, 'b')");

    const idsBefore = db.query<{ id: number }>("SELECT id FROM t").map((row) => row.id);
    const concatBefore = db.query<{ c: string }>("SELECT group_concat(v) AS c FROM t")[0]!.c;
    expect(idsBefore).toEqual([1, 2, 3]);
    expect(concatBefore).toBe("a,b,c");

    const restored = db.snapshot().open();
    expect(restored.query<{ id: number }>("SELECT id FROM t").map((row) => row.id)).toEqual(idsBefore);
    expect(restored.query<{ c: string }>("SELECT group_concat(v) AS c FROM t")[0]!.c).toBe(concatBefore);
  });

  test("identical seeds produce identical randomblob streams", () => {
    const a = new Database({ seed: 55 });
    const b = new Database({ seed: 55 });
    const left = a.query<{ h: string }>("SELECT hex(randomblob(8)) AS h")[0]!.h;
    const right = b.query<{ h: string }>("SELECT hex(randomblob(8)) AS h")[0]!.h;
    expect(left).toBe(right);
    expect(left.length).toBe(16);
  });

  test("snapshot restores clock instant", () => {
    const source = new Database({ now: new Date("2019-04-01T00:00:00.000Z") });
    const snap = source.snapshot();
    const restored = snap.open({ now: new Date("1999-01-01T00:00:00.000Z") });
    expect(restored.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2019-04-01");
  });
});
