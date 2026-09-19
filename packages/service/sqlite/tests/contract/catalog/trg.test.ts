import { expect } from "bun:test";
import { Snapshot } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("TRG", [
  {
    id: "TRG-bi-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE log(a TEXT)",
      "CREATE TRIGGER bi BEFORE INSERT ON t BEGIN INSERT INTO log VALUES ('bi'); END",
      "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('ai'); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT a FROM log ORDER BY rowid", query: true }],
  },
  {
    id: "TRG-of-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT, b INT)",
      "CREATE TABLE log(a TEXT)",
      "CREATE TRIGGER u AFTER UPDATE OF a ON t BEGIN INSERT INTO log VALUES ('a'); END",
      "INSERT INTO t VALUES (1,2)",
    ],
    steps: [{ sql: "UPDATE t SET b=3" }, { sql: "UPDATE t SET a=9" }, { sql: "SELECT a FROM log", query: true }],
  },
  {
    id: "TRG-when-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE log(a INT)",
      "CREATE TRIGGER g AFTER INSERT ON t WHEN NEW.a>0 BEGIN INSERT INTO log VALUES (NEW.a); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1),(-1)" }, { sql: "SELECT a FROM log", query: true }],
  },
  {
    id: "TRG-old-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE log(a INT, b INT)",
      "CREATE TRIGGER g AFTER UPDATE ON t BEGIN INSERT INTO log VALUES (OLD.a, NEW.a); END",
      "INSERT INTO t VALUES (1)",
    ],
    steps: [{ sql: "UPDATE t SET a=2" }, { sql: "SELECT a,b FROM log", query: true }],
  },
  {
    id: "TRG-ord-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE log(a TEXT)",
      "CREATE TRIGGER g1 AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('1'); END",
      "CREATE TRIGGER g2 AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('2'); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT count(*) FROM log", query: true }],
  },
  {
    id: "TRG-rec-01",
    kind: "sequence",
    setup: [
      "PRAGMA recursive_triggers=ON",
      "CREATE TABLE t(a INT)",
      "CREATE TRIGGER g AFTER INSERT ON t WHEN NEW.a<2 BEGIN INSERT INTO t VALUES (NEW.a+1); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (0)" }, { sql: "SELECT a FROM t ORDER BY a", query: true }],
  },
  {
    id: "TRG-raise-01",
    kind: "error",
    setup: ["CREATE TABLE t(a INT)", "CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'nope'); END"],
    sql: "INSERT INTO t VALUES (1)",
  },
  {
    id: "TRG-raise-02",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TRIGGER g BEFORE INSERT ON t WHEN NEW.a=1 BEGIN SELECT RAISE(IGNORE); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1),(2)" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "TRG-instead-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE VIEW v AS SELECT a FROM t",
      "CREATE TRIGGER g INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (NEW.a); END",
    ],
    steps: [{ sql: "INSERT INTO v VALUES (7)" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "TRG-fk-01",
    kind: "sequence",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT REFERENCES p(id) ON DELETE CASCADE)",
      "CREATE TABLE log(a TEXT)",
      "CREATE TRIGGER g AFTER DELETE ON c BEGIN INSERT INTO log VALUES ('c'); END",
      "INSERT INTO p VALUES (1)",
      "INSERT INTO c VALUES (1)",
    ],
    steps: [{ sql: "SELECT count(*) FROM p", query: true }],
  },
  {
    id: "TRG-chg-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t(a INT)",
      "CREATE TABLE u(a INT)",
      "CREATE TRIGGER g AFTER INSERT ON t BEGIN INSERT INTO u VALUES (1); END",
    ],
    steps: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT a FROM t", query: true }],
  },
  {
    id: "TRG-drop-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT)", "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END"],
    steps: [{ sql: "DROP TABLE t" }, { sql: "SELECT count(*) FROM sqlite_master WHERE type='trigger'", query: true }],
  },
  {
    id: "TRG-snap-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT)");
      db.exec("CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      const n = other.query<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'")[0]!.n;
      expect(n).toBe(0);
      other.close();
    },
  },
]);
