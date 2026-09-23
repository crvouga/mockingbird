import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("API", [
  {
    id: "API-exec-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.exec("CREATE TABLE t(a INT); INSERT INTO t VALUES (1);")).toBeUndefined();
      expect(db.query<{ a: number }>("SELECT a FROM t")[0]!.a).toBe(1);
    },
  },
  {
    id: "API-exec-02",
    kind: "divergence",
    fn: (db) => {
      try {
        (db.exec as (sql: string, v: unknown) => void)("SELECT ?", 1);
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("misuse");
      }
    },
  },
  {
    id: "API-exec-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT PRIMARY KEY)");
      try {
        db.exec("INSERT INTO t VALUES (1); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)");
      } catch {
        /* expected */
      }
      expect(db.query<{ n: number }>("SELECT count(*) AS n FROM t")[0]!.n).toBe(1);
    },
  },
  {
    id: "API-query-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT 1 AS a;")).toEqual([{ a: 1 }]);
      try {
        db.query("SELECT 1; SELECT 2");
        throw new Error("expected");
      } catch (error) {
        expect((error as SqliteError).category).toBe("misuse");
      }
    },
  },
  {
    id: "API-query-02",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT ? AS a, ? AS b", [1, "x"])).toEqual([{ a: 1, b: "x" }]);
    },
  },
  {
    id: "API-prep-01",
    kind: "divergence",
    fn: (db) => {
      try {
        db.prepare("SELCT 1");
        throw new Error("expected");
      } catch (error) {
        expect((error as SqliteError).category).toBe("syntax");
      }
    },
  },
  {
    id: "API-prep-02",
    kind: "divergence",
    fn: (db) => {
      const stmt = db.prepare("SELECT ? AS a");
      expect(stmt.get(1)).toEqual({ a: 1 });
      expect(stmt.get(2)).toEqual({ a: 2 });
    },
  },
  {
    id: "API-prep-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      const stmt = db.prepare("SELECT a FROM t");
      db.exec("ALTER TABLE t ADD COLUMN b INT");
      db.exec("INSERT INTO t(a) VALUES (1)");
      expect(stmt.all()).toEqual([{ a: 1 }]);
    },
  },
  {
    id: "API-run-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      const stmt = db.prepare("INSERT INTO t VALUES (?)");
      const run = stmt.run(1);
      expect(run.changes).toBe(1);
      expect(stmt.all(2).length).toBeGreaterThanOrEqual(0);
      expect(db.prepare("SELECT a FROM t WHERE a=1").get()).toEqual({ a: 1 });
      expect(db.prepare("SELECT a FROM t").result().columns).toEqual(["a"]);
    },
  },
  {
    id: "API-run-02",
    kind: "divergence",
    fn: (db) => {
      expect(db.prepare("SELECT 1 WHERE 0").get()).toBeUndefined();
    },
  },
  {
    id: "API-run-03",
    kind: "divergence",
    fn: (db) => {
      const result = db.prepare("SELECT 1 AS a WHERE 0").result();
      expect(result.columns).toEqual(["a"]);
      expect(result.values).toEqual([]);
    },
  },
  {
    id: "API-run-04",
    kind: "divergence",
    fn: (db) => {
      const result = db.prepare("SELECT 1 AS a").run();
      expect(result.changes).toBe(0);
    },
  },
  {
    id: "API-run-05",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      expect(db.prepare("INSERT INTO t VALUES (1) RETURNING a").all()).toEqual([{ a: 1 }]);
    },
  },
  {
    id: "API-bind-01",
    kind: "divergence",
    fn: (db) => {
      const stmt = db.prepare("SELECT typeof(?) AS t");
      expect(stmt.get(null)).toEqual({ t: "null" });
      expect(stmt.get("x")).toEqual({ t: "text" });
      expect(stmt.get(1)).toEqual({ t: "integer" });
      expect(stmt.get(true)).toEqual({ t: "integer" });
      expect(stmt.get(new Uint8Array([1]))).toEqual({ t: "blob" });
    },
  },
  {
    id: "API-bind-02",
    kind: "divergence",
    fn: (db) => {
      const stmt = db.prepare("SELECT ?");
      for (const value of [undefined, new Date(), {}, Number.NaN]) {
        try {
          stmt.get(value as never);
          throw new Error("expected");
        } catch (error) {
          expect(error).toBeInstanceOf(SqliteError);
        }
      }
    },
  },
  {
    id: "API-bind-03",
    kind: "divergence",
    fn: (db) => {
      const buf = new Uint8Array([1, 2]);
      db.exec("CREATE TABLE t(a BLOB)");
      db.prepare("INSERT INTO t VALUES (?)").run(buf);
      buf[0] = 9;
      const got = db.query<{ a: Uint8Array }>("SELECT a FROM t")[0]!.a;
      expect(got[0]).toBe(1);
    },
  },
  {
    id: "API-named-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.prepare("SELECT :a AS a, :b AS b").get(1, 2)).toEqual({ a: 1, b: 2 });
    },
  },
  {
    id: "API-named-02",
    kind: "divergence",
    fn: (db) => {
      expect(db.prepare("SELECT @x AS a, $x AS b, :x AS c").get(1, 2, 3)).toEqual({ a: 1, b: 2, c: 3 });
    },
  },
  {
    id: "API-named-03",
    kind: "divergence",
    fn: (db) => {
      expect(db.prepare("SELECT ?2 AS a, ?1 AS b").get(10, 20)).toEqual({ a: 20, b: 10 });
    },
  },
  {
    id: "API-ret-01",
    kind: "divergence",
    fn: (db) => {
      const n = db.query<{ v: number | bigint }>("SELECT 9007199254740993 AS v")[0]!.v;
      expect(typeof n === "bigint" || typeof n === "number").toBe(true);
    },
  },
  {
    id: "API-ret-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a BLOB)");
      db.exec("INSERT INTO t VALUES (X'01')");
      expect(db.query<{ a: Uint8Array }>("SELECT a FROM t")[0]!.a).toBeInstanceOf(Uint8Array);
    },
  },
  {
    id: "API-ret-03",
    kind: "divergence",
    fn: (db) => {
      expect(db.query<{ x: number }>("SELECT 1 AS x, 2 AS x")[0]!.x).toBe(2);
    },
  },
  {
    id: "API-close-01",
    kind: "divergence",
    fn: (db) => {
      db.close();
      db.close();
      try {
        db.query("SELECT 1");
        throw new Error("expected");
      } catch (error) {
        expect((error as SqliteError).category).toBe("misuse");
      }
    },
  },
  {
    id: "API-close-02",
    kind: "divergence",
    fn: (db) => {
      expect(typeof db[Symbol.dispose]).toBe("function");
      db[Symbol.dispose]();
    },
  },
  {
    id: "API-txn-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        expect(db.query<{ n: number }>("SELECT count(*) AS n FROM t")[0]!.n).toBe(1);
      });
    },
  },
  {
    id: "API-sync-01",
    kind: "divergence",
    fn: (db) => {
      const result = db.query("SELECT 1 AS a");
      expect(result).not.toBeInstanceOf(Promise);
    },
  },
]);
