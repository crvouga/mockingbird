import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { DEFAULT_NOW, Prng } from "../../../src/unstable.ts";

describe("determinism", () => {
  test("identical seeds produce identical random() streams", () => {
    const a = new Database({ seed: 42 });
    const b = new Database({ seed: 42 });
    const sql = "SELECT random() AS v UNION ALL SELECT random() UNION ALL SELECT random()";
    const left = a.query<{ v: number }>(sql);
    const right = b.query<{ v: number }>(sql);
    expect(left.map((row) => String(row.v))).toEqual(right.map((row) => String(row.v)));
  });

  test("different seeds diverge", () => {
    const a = new Database({ seed: 1 });
    const b = new Database({ seed: 2 });
    const left = a.query<{ v: number }>("SELECT random() AS v")[0]!.v;
    const right = b.query<{ v: number }>("SELECT random() AS v")[0]!.v;
    expect(String(left)).not.toEqual(String(right));
  });

  test("now() is fixed to 2000-01-01 by default", () => {
    const db = new Database();
    const row = db.query<{ d: string }>("SELECT current_date::text AS d")[0]!;
    expect(row.d).toBe("2000-01-01");
    expect(DEFAULT_NOW.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  test("injectable clock overrides now", () => {
    const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
    expect(db.query<{ d: string }>("SELECT current_date::text AS d")[0]!.d).toBe("2012-06-15");
    expect(db.query<{ t: string }>("SELECT now()::time::text AS t")[0]!.t).toBe("12:34:56");
  });

  test("gen_random_uuid is deterministic under a seed", () => {
    const a = new Database({ seed: 55 });
    const b = new Database({ seed: 55 });
    const left = a.query<{ u: string }>("SELECT gen_random_uuid()::text AS u")[0]!.u;
    const right = b.query<{ u: string }>("SELECT gen_random_uuid()::text AS u")[0]!.u;
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("snapshots are byte-identical for equivalent logical state", () => {
    const setup = (db: Database) => {
      db.exec("CREATE TABLE z (id serial PRIMARY KEY, name text)");
      db.exec("CREATE TABLE a (id serial PRIMARY KEY, name text)");
      db.exec("INSERT INTO z (name) VALUES ('z')");
      db.exec("INSERT INTO a (name) VALUES ('a')");
      db.exec("CREATE INDEX idx_z ON z (name)");
      db.exec("CREATE INDEX idx_a ON a (name)");
    };
    const left = new Database({ seed: 7 });
    const right = new Database({ seed: 7 });
    setup(left);
    setup(right);
    expect([...left.snapshot().encode()]).toEqual([...right.snapshot().encode()]);
  });

  test("Prng streams repeat for equal seeds", () => {
    const p = new Prng(99);
    const q = new Prng(99);
    const values = [p.nextFloat(), p.nextFloat(), p.nextFloat()].map(String);
    expect([q.nextFloat(), q.nextFloat(), q.nextFloat()].map(String)).toEqual(values);
  });

  test("float8 -0 round-trips as -0 (PostgreSQL keeps the sign)", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x float8)");
    db.prepare("INSERT INTO t (x) VALUES ($1)").run(-0);
    expect(db.query<{ x: string }>("SELECT x::text AS x FROM t")[0]!.x).toBe("-0");
  });

  test("random() continues after snapshot restore on a fresh database", () => {
    const source = new Database({ seed: 42 });
    const first = String(source.query<{ v: number }>("SELECT random() AS v")[0]!.v);
    const snap = source.snapshot();
    const secondOnSource = String(source.query<{ v: number }>("SELECT random() AS v")[0]!.v);

    const restored = snap.open({ seed: 999 });
    const secondOnRestored = String(restored.query<{ v: number }>("SELECT random() AS v")[0]!.v);
    expect(secondOnRestored).toBe(secondOnSource);
    expect(secondOnRestored).not.toBe(first);
  });

  test("ROLLBACK restores the random() stream", () => {
    const db = new Database({ seed: 11 });
    const baseline = new Database({ seed: 11 });
    const expectedFirst = String(baseline.query<{ v: number }>("SELECT random() AS v")[0]!.v);

    db.exec("BEGIN");
    db.query("SELECT random() AS v");
    db.exec("ROLLBACK");

    const afterRollback = String(db.query<{ v: number }>("SELECT random() AS v")[0]!.v);
    expect(afterRollback).toBe(expectedFirst);
  });

  test("string_agg and unordered scans are stable across restore", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id int PRIMARY KEY, v text)");
    db.exec("INSERT INTO t VALUES (3, 'c'), (1, 'a'), (2, 'b')");

    const idsBefore = db.query<{ id: number }>("SELECT id FROM t").map((row) => row.id);
    const concatBefore = db.query<{ c: string }>("SELECT string_agg(v, ',') AS c FROM t")[0]!.c;

    const restored = db.snapshot().open();
    expect(restored.query<{ id: number }>("SELECT id FROM t").map((row) => row.id)).toEqual(idsBefore);
    expect(restored.query<{ c: string }>("SELECT string_agg(v, ',') AS c FROM t")[0]!.c).toBe(concatBefore);
  });

  test("snapshot restores clock instant", () => {
    const source = new Database({ now: new Date("2019-04-01T00:00:00.000Z") });
    const snap = source.snapshot();
    const restored = snap.open({ now: new Date("1999-01-01T00:00:00.000Z") });
    expect(restored.query<{ d: string }>("SELECT current_date::text AS d")[0]!.d).toBe("2019-04-01");
  });

  test("setseed + random() is repeatable", () => {
    const a = new Database({ seed: 1 });
    const b = new Database({ seed: 2 });
    a.exec("SELECT setseed(0.5)");
    b.exec("SELECT setseed(0.5)");
    const left = a.query<{ v: number }>("SELECT random() AS v")[0]!.v;
    const right = b.query<{ v: number }>("SELECT random() AS v")[0]!.v;
    expect(String(left)).toBe(String(right));
  });
});
