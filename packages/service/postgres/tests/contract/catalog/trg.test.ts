import { expect } from "bun:test";
import { TRG_SECTION } from "../../../compat/sections/trg.ts";
import { runCatalog } from "./run.ts";

runCatalog(TRG_SECTION, [
  {
    id: "TRG-bi-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_set BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
      "INSERT INTO t VALUES (1, 'orig')",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bi-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, doubled int)",
      "CREATE FUNCTION dbl() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.doubled := NEW.id * 2; RETURN NEW; END $$",
      "CREATE TRIGGER trg_dbl BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION dbl()",
      "INSERT INTO t VALUES (1, NULL), (5, NULL)",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bi-03",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION skip_neg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id < 0 THEN RETURN NULL; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_skip BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION skip_neg()",
      "INSERT INTO t VALUES (-1), (2), (-3), (4)",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bi-04",
    kind: "parity",
    setup: [
      "CREATE TABLE t (score int, grade text)",
      "CREATE FUNCTION grade_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.score >= 90 THEN NEW.grade := 'A'; ELSIF NEW.score >= 80 THEN NEW.grade := 'B'; ELSE NEW.grade := 'C'; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_grade BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION grade_fn()",
      "INSERT INTO t VALUES (95, NULL), (85, NULL), (10, NULL)",
    ],
    sql: "SELECT * FROM t ORDER BY score",
  },
  {
    id: "TRG-when-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION tag_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'big'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_when BEFORE INSERT ON t FOR EACH ROW WHEN (NEW.id > 10) EXECUTE FUNCTION tag_big()",
      "INSERT INTO t VALUES (1, 'small'), (11, 'was'), (5, 'tiny'), (100, 'was')",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-when-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v int, note text)",
      "CREATE FUNCTION mark_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := 'changed'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_mark BEFORE UPDATE ON t FOR EACH ROW WHEN (OLD.v IS DISTINCT FROM NEW.v) EXECUTE FUNCTION mark_change()",
      "INSERT INTO t VALUES (1, 10, NULL), (2, 20, NULL)",
      "UPDATE t SET v = 11 WHERE id = 1",
      "UPDATE t SET v = 20 WHERE id = 2",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bu-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text, prev text)",
      "CREATE FUNCTION keep_prev() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.prev := OLD.v; RETURN NEW; END $$",
      "CREATE TRIGGER trg_prev BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION keep_prev()",
      "INSERT INTO t VALUES (1, 'first', NULL)",
      "UPDATE t SET v = 'second' WHERE id = 1",
    ],
    sql: "SELECT * FROM t",
  },
  {
    id: "TRG-bu-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION lock_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.v = 'locked' THEN RETURN NULL; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_lock BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION lock_rows()",
      "INSERT INTO t VALUES (1, 'locked'), (2, 'open')",
      "UPDATE t SET v = 'changed'",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bu-03",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v int)",
      "CREATE FUNCTION clamp_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.v > 100 THEN NEW.v := 100; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_clamp BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION clamp_v()",
      "INSERT INTO t VALUES (1, 5), (2, 6)",
      "UPDATE t SET v = 999 WHERE id = 1",
      "UPDATE t SET v = 50 WHERE id = 2",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bd-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION no_delete_one() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = 1 THEN RETURN NULL; END IF; RETURN OLD; END $$",
      "CREATE TRIGGER trg_nodel BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION no_delete_one()",
      "INSERT INTO t VALUES (1), (2), (3)",
      "DELETE FROM t",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-bd-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION allow_del() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$",
      "CREATE TRIGGER trg_del BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION allow_del()",
      "INSERT INTO t VALUES (1), (2)",
      "DELETE FROM t WHERE id = 1",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-ai-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
      "CREATE TRIGGER trg_after AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION noop()",
      "INSERT INTO t VALUES (1), (2)",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-multi-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, marks int)",
      "CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.marks := coalesce(NEW.marks, 0) + 1; RETURN NEW; END $$",
      "CREATE TRIGGER trg_bump BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION bump()",
    ],
    steps: [
      { sql: "INSERT INTO t VALUES (1, NULL)" },
      { sql: "SELECT * FROM t", query: true },
      { sql: "UPDATE t SET id = 1 WHERE id = 1" },
      { sql: "SELECT * FROM t", query: true },
    ],
  },
  {
    id: "TRG-sel-01",
    kind: "parity",
    setup: [
      "CREATE TABLE src (id int)",
      "INSERT INTO src VALUES (1), (2)",
      "CREATE TABLE t (id int, stamp text)",
      "CREATE FUNCTION stamp_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.stamp := 'stamped'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_stamp BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION stamp_fn()",
      "INSERT INTO t SELECT id, 'raw' FROM src",
    ],
    sql: "SELECT * FROM t ORDER BY id",
  },
  {
    id: "TRG-chain-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION append_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'a'; RETURN NEW; END $$",
      "CREATE FUNCTION append_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'b'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_1_first BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_a()",
      "CREATE TRIGGER trg_2_second BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_b()",
      "INSERT INTO t VALUES (1, '')",
    ],
    sql: "SELECT * FROM t",
  },
  {
    id: "TRG-raise-01",
    kind: "error",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denied'; END $$",
      "CREATE TRIGGER trg_deny BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny()",
    ],
    sql: "INSERT INTO t VALUES (1)",
    messageTier: "A",
  },
  {
    id: "TRG-raise-02",
    kind: "error",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION deny_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id > 10 THEN RAISE EXCEPTION 'too big'; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_big BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny_big()",
      "INSERT INTO t VALUES (5)",
    ],
    sql: "INSERT INTO t VALUES (11)",
    messageTier: "A",
  },
  {
    id: "TRG-raise-03",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION deny_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id > 10 THEN RAISE EXCEPTION 'too big'; END IF; RETURN NEW; END $$",
      "CREATE TRIGGER trg_big BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny_big()",
    ],
    steps: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (10)" },
      { sql: "SELECT * FROM t ORDER BY id", query: true },
    ],
  },
  {
    id: "TRG-raise-04",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denied'; END $$",
      "CREATE TRIGGER trg_deny BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny()",
    ],
    steps: [
      { sql: "BEGIN" },
      { sql: "SAVEPOINT sp" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "ROLLBACK TO sp" },
      { sql: "COMMIT" },
      { sql: "SELECT count(*) AS n FROM t", query: true },
    ],
  },
  {
    id: "TRG-drop-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_set BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
    ],
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'orig')" },
      { sql: "DROP TRIGGER trg_set ON t" },
      { sql: "INSERT INTO t VALUES (2, 'orig')" },
      { sql: "SELECT * FROM t ORDER BY id", query: true },
    ],
  },
  {
    id: "TRG-drop-02",
    kind: "error",
    setup: ["CREATE TABLE t (id int)"],
    sql: "DROP TRIGGER no_such_trigger ON t",
    messageTier: "A",
  },
  {
    id: "TRG-drop-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "DROP TRIGGER IF EXISTS no_such_trigger ON t" },
      { sql: "SELECT count(*) AS n FROM t", query: true },
    ],
  },
  {
    id: "TRG-life-01",
    kind: "error",
    setup: [
      "CREATE TABLE t (id int)",
      "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
      "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
    ],
    sql: "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
    messageTier: "A",
  },
  {
    id: "TRG-life-02",
    kind: "sequence",
    setup: [
      "CREATE TABLE t1 (id int, v text)",
      "CREATE TABLE t2 (id int, v text)",
      "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
      "CREATE TRIGGER trg BEFORE INSERT ON t1 FOR EACH ROW EXECUTE FUNCTION set_v()",
      "CREATE TRIGGER trg BEFORE INSERT ON t2 FOR EACH ROW EXECUTE FUNCTION set_v()",
    ],
    steps: [
      { sql: "INSERT INTO t1 VALUES (1, 'orig')" },
      { sql: "INSERT INTO t2 VALUES (1, 'orig')" },
      { sql: "SELECT v FROM t1", query: true },
      { sql: "SELECT v FROM t2", query: true },
    ],
  },
  {
    id: "TRG-life-03",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
      "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
    ],
    steps: [
      { sql: "DROP TABLE t" },
      { sql: "CREATE TABLE t (id int, v text)" },
      { sql: "INSERT INTO t VALUES (1, 'orig')" },
      { sql: "SELECT v FROM t", query: true },
    ],
  },
  {
    id: "TRG-event-01",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'ins'; RETURN NEW; END $$",
      "CREATE TRIGGER trg_ins BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
    ],
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'orig')" },
      { sql: "UPDATE t SET v = 'updated' WHERE id = 1" },
      { sql: "SELECT * FROM t", query: true },
    ],
  },
  {
    id: "TRG-order-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int, v text)");
      db.exec(
        "CREATE FUNCTION append_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'a'; RETURN NEW; END $$",
      );
      db.exec(
        "CREATE FUNCTION append_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'b'; RETURN NEW; END $$",
      );
      db.exec("CREATE TRIGGER trg_zz BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_b()");
      db.exec("CREATE TRIGGER trg_aa BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_a()");
      db.exec("INSERT INTO t VALUES (1, '')");
      // PostgreSQL fires in name order (trg_aa first => 'ab'); memory fires in creation order.
      expect(db.query("SELECT v FROM t")[0]).toEqual({ v: "ba" });
    },
  },
  {
    id: "TRG-updof-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE u (a int, b int)");
      db.exec("INSERT INTO u VALUES (1, 2)");
      db.exec("CREATE FUNCTION bump_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.b := 99; RETURN NEW; END $$");
      db.exec("CREATE TRIGGER trg_a BEFORE UPDATE OF a ON u FOR EACH ROW EXECUTE FUNCTION bump_b()");
      db.exec("UPDATE u SET b = 5");
      // PostgreSQL would not fire the trigger (b stays 5); memory ignores the column list.
      expect(db.query("SELECT a, b FROM u")[0]).toEqual({ a: 1, b: 99 });
    },
  },
  {
    id: "TRG-instead-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int, v text)");
      db.exec("CREATE VIEW tv AS SELECT id, v FROM t");
      db.exec(
        "CREATE FUNCTION tv_ins() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (NEW.id, NEW.v); RETURN NEW; END $$",
      );
      expect(() =>
        db.exec("CREATE TRIGGER trg_tv INSTEAD OF INSERT ON tv FOR EACH ROW EXECUTE FUNCTION tv_ins()"),
      ).toThrow();
    },
  },
]);
