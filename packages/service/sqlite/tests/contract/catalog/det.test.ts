import { expect } from "bun:test";
import { Database } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("DET", [
  {
    id: "DET-seed-01",
    kind: "divergence",
    fn: () => {
      const a = new Database({ seed: 42 });
      const b = new Database({ seed: 42 });
      expect(String(a.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v)).toBe(
        String(b.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v),
      );
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
      expect(String(a.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v)).not.toBe(
        String(b.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v),
      );
      a.close();
      b.close();
    },
  },
  {
    id: "DET-os-01",
    kind: "divergence",
    fn: () => {
      const db = new Database({ random: "os" });
      expect(db.query<{ t: string }>("SELECT typeof(random()) AS t")[0]!.t).toBe("integer");
      db.close();
    },
  },
  {
    id: "DET-eval-01",
    kind: "divergence",
    fn: (db) => {
      db.query("SELECT CASE WHEN 0 THEN random() ELSE 1 END");
      const after = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      const baseline = new Database();
      baseline.query("SELECT CASE WHEN 0 THEN random() ELSE 1 END");
      expect(String(baseline.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v)).toBe(after);
      baseline.close();
    },
  },
  {
    id: "DET-rb-01",
    kind: "divergence",
    fn: (db) => {
      const baseline = new Database();
      const expected = String(baseline.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      baseline.close();
      db.exec("BEGIN");
      db.query("SELECT random()");
      db.exec("ROLLBACK");
      expect(String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v)).toBe(expected);
    },
  },
  {
    id: "DET-rb-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("BEGIN");
      const inner = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      db.exec("COMMIT");
      const after = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      expect(after).not.toBe(inner);
    },
  },
  {
    id: "DET-scan-01",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t(id,v) VALUES (3,'c'),(1,'a'),(2,'b')"],
    sql: "SELECT id FROM t",
  },
  {
    id: "DET-negzero-01",
    kind: "divergence",
    fn: (db) => {
      expect(Object.is(db.query<{ v: number }>("SELECT -1.0*0.0 AS v")[0]!.v, -0)).toBe(false);
    },
  },
]);
