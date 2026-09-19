import { expect } from "bun:test";
import { DET_SECTION } from "../../../compat/sections/det.ts";
import { Database } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

function firstRandom(db: Database): string {
  return String(db.query<{ v: number }>("SELECT random() AS v")[0]!.v);
}

runCatalog(DET_SECTION, [
  {
    id: "DET-seed-01",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 42 });
      const b = new Database({ seed: 42 });
      expect(firstRandom(a)).toBe(firstRandom(b));
      a.close();
      b.close();
    },
  },
  {
    id: "DET-seed-02",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 1 });
      const b = new Database({ seed: 2 });
      expect(firstRandom(a)).not.toBe(firstRandom(b));
      a.close();
      b.close();
    },
  },
  {
    id: "DET-now-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT current_date::text AS d")[0]).toEqual({ d: "2000-01-01" });
    },
  },
  {
    id: "DET-now-02",
    kind: "divergence",
    fn: () => {
      const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
      expect(db.query("SELECT localtimestamp::text AS ts")[0]).toEqual({ ts: "2012-06-15 12:34:56" });
      db.close();
    },
  },
  {
    id: "DET-uuid-01",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 7 });
      const b = new Database({ seed: 7 });
      expect(a.query("SELECT gen_random_uuid()::text AS u")).toEqual(b.query("SELECT gen_random_uuid()::text AS u"));
      a.close();
      b.close();
    },
  },
  {
    id: "DET-rb-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("BEGIN");
      const inside = firstRandom(db);
      db.exec("ROLLBACK");
      expect(firstRandom(db)).toBe(inside);
    },
  },
  {
    id: "DET-snap-01",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 5 });
      firstRandom(a);
      const clone = a.snapshot().open();
      expect(firstRandom(clone)).toBe(firstRandom(a));
      a.close();
      clone.close();
    },
  },
  {
    id: "DET-setseed-01",
    kind: "divergence",
    fn: (db) => {
      db.query("SELECT setseed(0.5)");
      const first = firstRandom(db);
      db.query("SELECT setseed(0.5)");
      expect(firstRandom(db)).toBe(first);
    },
  },
  {
    id: "DET-scan-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (n int)");
      db.exec("INSERT INTO t VALUES (3), (1), (2)");
      const scan = db.query("SELECT n FROM t");
      const agg = db.query("SELECT string_agg(n::text, ',') AS s FROM t");
      const clone = db.snapshot().open();
      expect(clone.query("SELECT n FROM t")).toEqual(scan);
      expect(clone.query("SELECT string_agg(n::text, ',') AS s FROM t")).toEqual(agg);
      clone.close();
    },
  },
  {
    id: "DET-negzero-01",
    kind: "parity",
    sql: "SELECT (-0::float8)::text AS neg, ((-0::float8) = 0::float8) AS eq",
  },
]);
