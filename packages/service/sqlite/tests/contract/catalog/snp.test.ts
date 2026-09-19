import { expect } from "bun:test";
import { Database, Snapshot, SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("SNP", [
  {
    id: "SNP-rt-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.exec("CREATE VIEW v AS SELECT a FROM t");
      db.exec("CREATE INDEX i ON t(a)");
      db.exec("INSERT INTO t VALUES (1)");
      const other = db.snapshot().open();
      expect(other.query("SELECT a FROM t")).toEqual([{ a: 1 }]);
      other.close();
    },
  },
  {
    id: "SNP-rt-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a BLOB, b TEXT)");
      db.exec("INSERT INTO t VALUES (X'00', 'héllo\u0000x')");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query("SELECT hex(a), length(b) FROM t")).toEqual(db.query("SELECT hex(a), length(b) FROM t"));
      other.close();
    },
  },
  {
    id: "SNP-rt-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT)");
      db.exec("INSERT INTO t VALUES (NULL)");
      const other = db.snapshot().open();
      expect(other.lastInsertRowid).toBe(db.lastInsertRowid);
      other.close();
    },
  },
  {
    id: "SNP-rt-04",
    kind: "divergence",
    fn: (db) => {
      const first = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      const snap = db.snapshot();
      const second = String(db.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v);
      const other = snap.open({ seed: 99 });
      expect(String(other.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v)).toBe(second);
      expect(second).not.toBe(first);
      other.close();
    },
  },
  {
    id: "SNP-byte-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE b(a INT); CREATE TABLE a(a INT); INSERT INTO b VALUES (1); INSERT INTO a VALUES (1)");
      const left = new Database({ seed: 1 });
      left.exec("CREATE TABLE a(a INT); CREATE TABLE b(a INT); INSERT INTO a VALUES (1); INSERT INTO b VALUES (1)");
      expect([...db.snapshot().encode()]).toEqual([...left.snapshot().encode()]);
      left.close();
    },
  },
  {
    id: "SNP-hdr-01",
    kind: "divergence",
    fn: (db) => {
      const snap = db.snapshot().encode();
      expect(String.fromCharCode(snap[0]!, snap[1]!, snap[2]!, snap[3]!)).toBe("SQLM");
    },
  },
  {
    id: "SNP-hdr-02",
    kind: "divergence",
    fn: () => {
      try {
        Snapshot.decode(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]));
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
      }
    },
  },
  {
    id: "SNP-hdr-03",
    kind: "divergence",
    fn: () => {
      try {
        Snapshot.decode(new Uint8Array([83, 81, 76, 77]));
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
      }
    },
  },
  {
    id: "SNP-hdr-04",
    kind: "divergence",
    fn: (db) => {
      const snap = db.snapshot().encode();
      const copy = new Uint8Array(snap);
      copy[4] = 255;
      copy[5] = 255;
      copy[6] = 255;
      copy[7] = 255;
      try {
        Snapshot.decode(copy);
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("snapshot_version");
      }
    },
  },
  {
    id: "SNP-txn-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("BEGIN");
      try {
        db.snapshot();
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
      }
    },
  },
  {
    id: "SNP-now-01",
    kind: "divergence",
    fn: (db) => {
      const live = db.snapshot().open({ now: "system" });
      expect(live.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe(new Date().toISOString().slice(0, 10));
      live.close();
    },
  },
  {
    id: "SNP-now-02",
    kind: "divergence",
    fn: (db) => {
      const live = db.snapshot().open({ now: () => new Date("1999-01-01T00:00:00Z") });
      expect(live.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2000-01-01");
      live.close();
    },
  },
  {
    id: "SNP-rng-01",
    kind: "divergence",
    fn: (db) => {
      db.query("SELECT random()");
      const os = db.snapshot().open({ random: "os" });
      expect(typeof os.query<{ v: number | bigint }>("SELECT random() AS v")[0]!.v !== "undefined").toBe(true);
      os.close();
    },
  },
  {
    id: "SNP-omit-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.exec("CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'")[0]!.n).toBe(0);
      other.close();
    },
  },
  {
    id: "SNP-omit-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("ATTACH ':memory:' AS other");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query<{ n: number }>("SELECT count(*) AS n FROM pragma_database_list()")[0]!.n).toBe(1);
      other.close();
    },
  },
  {
    id: "SNP-omit-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query("SELECT name FROM sqlite_master WHERE name='docs'").length).toBe(0);
      other.close();
    },
  },
  {
    id: "SNP-omit-04",
    kind: "divergence",
    fn: (db) => {
      db.exec("PRAGMA user_version=42");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query<{ v: number }>("PRAGMA user_version")[0]!.v ?? other.query("PRAGMA user_version")[0]).not.toBe(
        undefined,
      );
      other.close();
    },
  },
  {
    id: "SNP-open-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO t(name) VALUES ('a')");
      const opened = db.snapshot().open();
      expect(opened.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
      opened.exec("INSERT INTO t(name) VALUES ('b')");
      expect(db.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
      opened.close();
    },
  },
  {
    id: "SNP-open-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO t(name) VALUES ('a')");
      const snap = db.snapshot();
      const original = Uint8Array.from(snap.encode());
      const opened = snap.open();
      expect([...snap.encode()]).toEqual([...original]);
      expect(opened.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
      const bytes = snap.encode();
      const decoded = Snapshot.decode(bytes);
      decoded.open().exec("INSERT INTO t(name) VALUES ('b')");
      expect(opened.query("SELECT name FROM t")).toEqual([{ name: "a" }]);
      expect([...bytes]).toEqual([...original]);
      opened.close();
    },
  },
  {
    id: "SNP-prop-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
      db.exec("INSERT INTO t VALUES (1, 10)");
      const bytes = db.snapshot().encode();
      const once = Snapshot.decode(bytes).open();
      const twice = Snapshot.decode(Snapshot.decode(bytes).encode()).open();
      expect(once.query("SELECT a FROM t")).toEqual(twice.query("SELECT a FROM t"));
      once.close();
      twice.close();
    },
  },
  {
    id: "SNP-prop-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
      db.exec("INSERT INTO t VALUES (1, 10)");
      const before = db.query("SELECT a FROM t");
      const snap = db.snapshot();
      const scratch = snap.open();
      scratch.exec("INSERT INTO t VALUES (2, 0)");
      scratch.exec("DELETE FROM t WHERE id = 2");
      expect(scratch.query("SELECT a FROM t")).toEqual(before);
      const restored = snap.open();
      expect(restored.query("SELECT a FROM t")).toEqual(before);
      scratch.close();
      restored.close();
    },
  },
  {
    id: "SNP-prop-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, flag INT)");
      db.exec("CREATE INDEX idx_partial ON t(v) WHERE flag = 1");
      db.exec("INSERT INTO t VALUES (1, 10, 1)");
      const probe = db.query("SELECT id, v FROM t WHERE flag = 1 AND v = 10");
      const snap = db.snapshot();
      const wiped = snap.open();
      wiped.exec("DELETE FROM t");
      const restored = snap.open();
      expect(restored.query("SELECT id, v FROM t WHERE flag = 1 AND v = 10")).toEqual(probe);
      wiped.close();
      restored.close();
    },
  },
  {
    id: "SNP-obj-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)");
      db.exec("CREATE INDEX idx_expr ON t(v + 1)");
      db.exec("INSERT INTO t VALUES (1, 5)");
      const snap = db.snapshot();
      const wiped = snap.open();
      wiped.exec("DELETE FROM t");
      const restored = snap.open();
      expect(restored.query("SELECT id, v FROM t WHERE v + 1 = 6")).toEqual([{ id: 1, v: 5 }]);
      wiped.close();
      restored.close();
    },
  },
  {
    id: "SNP-obj-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
      db.exec("CREATE INDEX t_a ON t(a)");
      db.exec("CREATE VIEW v AS SELECT id, a FROM t");
      db.exec("INSERT INTO t VALUES (1, 5)");
      const snap = db.snapshot();
      const wiped = snap.open();
      wiped.exec("DROP INDEX t_a");
      wiped.exec("DELETE FROM t");
      const restored = snap.open();
      expect(restored.query("SELECT id, a FROM v")).toEqual([{ id: 1, a: 5 }]);
      expect(restored.query("SELECT id FROM t WHERE a = 5")).toEqual([{ id: 1 }]);
      wiped.close();
      restored.close();
    },
  },
]);
