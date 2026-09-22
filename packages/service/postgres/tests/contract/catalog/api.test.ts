import { expect } from "bun:test";
import { API_SECTION } from "../../../compat/sections/api.ts";
import { Database, PostgresError, Snapshot, type Statement } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog(API_SECTION, [
  {
    id: "API-exec-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.exec("CREATE TABLE t (id int); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)")).toBeUndefined();
      expect(db.query("SELECT count(*)::int AS c FROM t")[0]).toEqual({ c: 2 });
    },
  },
  {
    id: "API-exec-02",
    kind: "divergence",
    fn: (db) => {
      expect(() => (db.exec as (sql: string, p?: unknown) => void)("SELECT 1", [1])).toThrow(
        /does not accept parameters/,
      );
    },
  },
  {
    id: "API-query-01",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.query("SELECT 1; SELECT 2")).toThrow(/single statement/);
      expect(() => db.prepare("SELECT 1; SELECT 2")).toThrow(/single statement/);
    },
  },
  {
    id: "API-query-02",
    kind: "parity",
    setup: ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (1, 'x'), (2, 'y')"],
    sql: "SELECT a, b FROM t WHERE a = $1 AND b = $2",
    params: [2, "y"],
  },
  {
    id: "API-prep-01",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.prepare("SELEC 1")).toThrow(PostgresError);
      try {
        db.prepare("SELEC 1");
      } catch (err) {
        expect((err as PostgresError).category).toBe("syntax");
      }
    },
  },
  {
    id: "API-prep-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id serial PRIMARY KEY, n int)"],
    steps: [
      { sql: "INSERT INTO t (n) VALUES ($1)", params: [10] },
      { sql: "INSERT INTO t (n) VALUES ($1)", params: [20] },
      { sql: "SELECT id, n FROM t ORDER BY id", query: true },
    ],
  },
  {
    id: "API-prep-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id serial PRIMARY KEY, name text)", "INSERT INTO t (name) VALUES ('a')"],
    steps: [
      { sql: "SELECT * FROM t", query: true },
      { sql: "ALTER TABLE t ADD COLUMN note text DEFAULT 'x'" },
      { sql: "SELECT * FROM t", query: true },
    ],
  },
  {
    id: "API-run-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id serial PRIMARY KEY, n int)");
      const stmt: Statement = db.prepare("INSERT INTO t (n) VALUES ($1), ($2)");
      expect(stmt.run(1, 2)).toEqual({ rowCount: 2, command: "INSERT" });
      expect(db.prepare("SELECT n FROM t ORDER BY id").all()).toEqual([{ n: 1 }, { n: 2 }]);
      expect(db.prepare("SELECT n FROM t ORDER BY id").get()).toEqual({ n: 1 });
      const res = db.prepare("SELECT n FROM t ORDER BY id").result();
      expect(res.columns).toEqual(["n"]);
      expect(res.columnTypes).toEqual(["int4"]);
      expect(res.rowCount).toBe(2);
    },
  },
  {
    id: "API-run-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      expect(db.prepare("SELECT id FROM t").get()).toBeUndefined();
    },
  },
  {
    id: "API-run-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int4, b text)");
      const res = db.prepare("SELECT a, b FROM t").result();
      expect(res.columns).toEqual(["a", "b"]);
      expect(res.columnTypes).toEqual(["int4", "text"]);
      expect(res.rows).toEqual([]);
    },
  },
  {
    id: "API-run-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (id serial PRIMARY KEY, n int)"],
    steps: [{ sql: "INSERT INTO t (n) VALUES (7), (8) RETURNING id, n", query: true }],
  },
  {
    id: "API-bind-01",
    kind: "parity",
    sql: "SELECT $1::int AS i, $2::text AS t, $3::bool AS b, $4::float8 AS f, $5::int8 AS big, $6::int AS z",
    params: [42, "hello", true, 1.5, 9007199254740993n, null],
  },
  {
    id: "API-bind-02",
    kind: "divergence",
    fn: (db) => {
      try {
        db.query("SELECT $1::text AS v", [Symbol("nope") as never]);
        expect.unreachable("expected bind to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(PostgresError);
        expect((err as PostgresError).category).toBe("misuse");
      }
    },
  },
  {
    id: "API-bind-03",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT $1 + 0 AS v", [9223372036854775807n])[0]).toEqual({ v: 9223372036854775807n });
      expect(() => db.query("SELECT $1 AS v", [9223372036854775808n])).toThrow(/out of int8 range/);
    },
  },
  {
    id: "API-ret-01",
    kind: "divergence",
    fn: (db) => {
      const row = db.query<{ small: number; big: bigint }>("SELECT 1::int4 AS small, 1::int8 AS big")[0]!;
      expect(row.small).toBe(1);
      expect(row.big).toBe(1n);
    },
  },
  {
    id: "API-ret-02",
    kind: "divergence",
    fn: (db) => {
      const row = db.query<{ n: string; d: string; j: string }>(
        "SELECT 1.50::numeric(10,2) AS n, date '2024-06-01' AS d, '{\"a\": 1}'::jsonb AS j",
      )[0]!;
      expect(row).toEqual({ n: "1.50", d: "2024-06-01", j: '{"a": 1}' });
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
        expect.unreachable("expected use after close to throw");
      } catch (err) {
        expect((err as PostgresError).category).toBe("misuse");
      }
    },
  },
  {
    id: "API-txn-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (n int)");
      db.transaction(() => db.exec("INSERT INTO t VALUES (1)"));
      expect(() =>
        db.transaction(() => {
          db.exec("INSERT INTO t VALUES (2)");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(db.query("SELECT n FROM t")).toEqual([{ n: 1 }]);
    },
  },
  {
    id: "API-txn-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (n int)");
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        expect(() =>
          db.transaction(() => {
            db.exec("INSERT INTO t VALUES (2)");
            throw new Error("inner");
          }),
        ).toThrow("inner");
      });
      expect(db.query("SELECT n FROM t")).toEqual([{ n: 1 }]);
    },
  },
  {
    id: "API-sync-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (n int)");
      expect(db.query("SELECT 1 AS v")).not.toBeInstanceOf(Promise);
      expect(db.prepare("INSERT INTO t VALUES (1)").run()).not.toBeInstanceOf(Promise);
      expect(db.snapshot()).toBeInstanceOf(Snapshot);
    },
  },
  {
    id: "API-copy-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      expect(db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n2\t\\N\n")).toBe(2);
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: null },
      ]);
    },
  },
  {
    id: "API-int8-01",
    kind: "divergence",
    fn: () => {
      const db = new Database({ int8: "number" });
      expect(db.query("SELECT 1::int8 AS n")[0]).toEqual({ n: 1 });
      db.close();
    },
  },
  {
    id: "API-int8-02",
    kind: "divergence",
    fn: () => {
      const db = new Database({ int8: "string" });
      expect(db.query("SELECT 9007199254740993::int8 AS n")[0]).toEqual({ n: "9007199254740993" });
      db.close();
    },
  },
  {
    id: "API-fn-01",
    kind: "divergence",
    fn: (db) => {
      db.registerFunction({
        name: "js_add",
        args: ["int4", "int4"],
        returns: "int4",
        fn: (a, b) => Number(a) + Number(b),
      });
      expect(db.query("SELECT js_add(2, 3) AS n")[0]).toEqual({ n: 5 });
      const child = db.snapshot().open();
      expect(child.query("SELECT js_add(4, 5) AS n")[0]).toEqual({ n: 9 });
      const opened = Snapshot.decode(db.snapshot().encode()).open();
      expect(() => opened.query("SELECT js_add(1, 1)")).toThrow();
      child.close();
      opened.close();
    },
  },
  {
    id: "API-dump-01",
    kind: "divergence",
    fn: (db) => {
      db.exec(`
        CREATE TABLE t (id int);
        DO $$ BEGIN RAISE NOTICE 'skip'; END $$;
        ALTER TABLE t SET (fillfactor = 70);
      `);
      expect(db.query("SELECT count(*)::int AS c FROM t")[0]).toEqual({ c: 0 });
    },
  },
  {
    id: "API-do-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("DO $$ BEGIN PERFORM 1; END $$");
      db.exec("DO LANGUAGE plpgsql $$ BEGIN NULL; END $$");
    },
  },
  {
    id: "API-set-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      db.exec("ALTER TABLE t SET (fillfactor = 70, autovacuum_enabled = false)");
      expect(db.query("SELECT count(*)::int AS c FROM t")[0]).toEqual({ c: 0 });
    },
  },
]);
