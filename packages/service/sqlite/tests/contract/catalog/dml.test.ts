import { expect } from "bun:test";
import { runCatalog } from "./run.ts";

runCatalog("DML", [
  {
    id: "DML-ins-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [{ sql: "INSERT INTO t VALUES (1),(2),(3)" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  {
    id: "DML-ins-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT DEFAULT 7)"],
    steps: [{ sql: "INSERT INTO t DEFAULT VALUES" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "DML-ins-03",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "INSERT INTO t SELECT a+1 FROM t" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  { id: "DML-ins-04", kind: "error", setup: ["CREATE TABLE t(a INT, b INT)"], sql: "INSERT INTO t(a) VALUES (1,2)" },
  {
    id: "DML-ins-05",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t(rowid, a) VALUES (9, 1)"],
    sql: "SELECT rowid, a FROM t",
  },
  {
    id: "DML-ins-06",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (NULL)"],
    sql: "SELECT id FROM t",
  },
  {
    id: "DML-ins-07",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (-5)"],
    sql: "SELECT id FROM t",
  },
  {
    id: "DML-ins-08",
    kind: "sequence",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t(v) VALUES ('a'),('b'),('c')"],
    steps: [
      { sql: "DELETE FROM t WHERE id=3" },
      { sql: "INSERT INTO t(v) VALUES ('d')" },
      { sql: "SELECT id,v FROM t ORDER BY id", query: true },
    ],
  },
  {
    id: "DML-or-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY, b TEXT)", "INSERT INTO t VALUES (1,'a')"],
    steps: [{ sql: "INSERT OR IGNORE INTO t VALUES (1,'b')" }, { sql: "SELECT a,b FROM t", query: true }],
  },
  {
    id: "DML-or-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "INSERT OR IGNORE INTO t VALUES (1)" }, { sql: "SELECT count(*) FROM t", query: true }],
  },
  {
    id: "DML-or-03",
    kind: "error",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT OR ABORT INTO t VALUES (1)",
  },
  {
    id: "DML-or-04",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)"],
    steps: [{ sql: "INSERT OR FAIL INTO t VALUES (1),(1),(2)" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  {
    id: "DML-or-05",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)"],
    steps: [
      { sql: "BEGIN" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT OR ROLLBACK INTO t VALUES (1)" },
      { sql: "SELECT count(*) FROM t", query: true },
    ],
  },
  {
    id: "DML-up-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY, b TEXT)", "INSERT INTO t VALUES (1,'a')"],
    steps: [{ sql: "INSERT INTO t VALUES (1,'b') ON CONFLICT DO NOTHING" }, { sql: "SELECT b FROM t", query: true }],
  },
  {
    id: "DML-up-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY, b TEXT)", "INSERT INTO t VALUES (1,'a')"],
    steps: [
      { sql: "INSERT INTO t VALUES (1,'b') ON CONFLICT(a) DO UPDATE SET b=excluded.b" },
      { sql: "SELECT b FROM t", query: true },
    ],
  },
  {
    id: "DML-up-03",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(email TEXT, active INT)",
      "CREATE UNIQUE INDEX i ON t(email) WHERE active=1",
      "INSERT INTO t VALUES ('a',1)",
    ],
    steps: [
      { sql: "INSERT INTO t VALUES ('a',1) ON CONFLICT(email) WHERE active=1 DO UPDATE SET active=0" },
      { sql: "SELECT email, active FROM t", query: true },
    ],
  },
  {
    id: "DML-up-04",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING" }, { sql: "SELECT count(*) FROM t", query: true }],
  },
  {
    id: "DML-up-05",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY, b INT UNIQUE)", "INSERT INTO t VALUES (1,10)"],
    steps: [{ sql: "INSERT INTO t VALUES (1,11) ON CONFLICT DO NOTHING" }, { sql: "SELECT a,b FROM t", query: true }],
  },
  {
    id: "DML-up-06",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT PRIMARY KEY, b TEXT)", "INSERT INTO t VALUES (1,'a')"],
    sql: "INSERT INTO t VALUES (1,'b') ON CONFLICT(a) DO UPDATE SET b=excluded.b RETURNING a,b",
  },
  {
    id: "DML-upd-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT, b INT)", "INSERT INTO t VALUES (1,2)"],
    steps: [{ sql: "UPDATE t SET a=a+1, b=b*2" }, { sql: "SELECT a,b FROM t", query: true }],
  },
  {
    id: "DML-upd-02",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(id INT, v TEXT)",
      "CREATE TABLE s(id INT, v TEXT)",
      "INSERT INTO t VALUES (1,'a')",
      "INSERT INTO s VALUES (1,'b')",
    ],
    steps: [{ sql: "UPDATE t SET v=s.v FROM s WHERE t.id=s.id" }, { sql: "SELECT v FROM t", query: true }],
  },
  {
    id: "DML-upd-03",
    kind: "sequence",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1,'a')"],
    steps: [{ sql: "UPDATE t SET id=5, v='b'" }, { sql: "SELECT id,v FROM t", query: true }],
  },
  {
    id: "DML-del-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1),(2),(3)"],
    steps: [{ sql: "DELETE FROM t WHERE a=2" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  {
    id: "DML-del-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1),(2)"],
    steps: [{ sql: "DELETE FROM t" }, { sql: "SELECT changes()", query: true }],
  },
  {
    id: "DML-ret-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1)"],
    sql: "UPDATE t SET a=2 RETURNING a",
  },
  {
    id: "DML-ret-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      const result = db.prepare("INSERT INTO t VALUES (1) RETURNING a").run();
      expect(result.changes).toBe(1);
    },
  },
  {
    id: "DML-chg-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INTEGER PRIMARY KEY)"],
    steps: [{ sql: "INSERT INTO t VALUES (NULL)" }, { sql: "SELECT changes(), last_insert_rowid()", query: true }],
  },
  {
    id: "DML-chg-02",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2),(3)" },
      { sql: "SELECT changes()", query: true },
    ],
  },
  {
    id: "DML-chg-03",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE u(a INT)",
      "CREATE TRIGGER g AFTER INSERT ON t BEGIN INSERT INTO u VALUES (NEW.a); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "DML-chg-04",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "SELECT total_changes()", query: true },
    ],
  },
]);
