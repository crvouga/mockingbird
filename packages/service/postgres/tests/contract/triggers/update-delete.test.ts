import { parity, sequenceParity } from "../helpers.ts";

parity(
  "BEFORE UPDATE trigger reads OLD and writes NEW",
  [
    "CREATE TABLE t (id int, v text, prev text)",
    "CREATE FUNCTION keep_prev() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.prev := OLD.v; RETURN NEW; END $$",
    "CREATE TRIGGER trg_prev BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION keep_prev()",
    "INSERT INTO t VALUES (1, 'first', NULL)",
    "UPDATE t SET v = 'second' WHERE id = 1",
  ],
  "SELECT * FROM t",
);

parity(
  "BEFORE UPDATE returning NULL suppresses the update",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION lock_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.v = 'locked' THEN RETURN NULL; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_lock BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION lock_rows()",
    "INSERT INTO t VALUES (1, 'locked'), (2, 'open')",
    "UPDATE t SET v = 'changed'",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "BEFORE UPDATE trigger can override the assigned value",
  [
    "CREATE TABLE t (id int, v int)",
    "CREATE FUNCTION clamp_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.v > 100 THEN NEW.v := 100; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_clamp BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION clamp_v()",
    "INSERT INTO t VALUES (1, 5), (2, 6)",
    "UPDATE t SET v = 999 WHERE id = 1",
    "UPDATE t SET v = 50 WHERE id = 2",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "BEFORE DELETE returning NULL suppresses the delete",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION no_delete_one() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = 1 THEN RETURN NULL; END IF; RETURN OLD; END $$",
    "CREATE TRIGGER trg_nodel BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION no_delete_one()",
    "INSERT INTO t VALUES (1), (2), (3)",
    "DELETE FROM t",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "BEFORE DELETE returning OLD allows the delete",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION allow_del() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$",
    "CREATE TRIGGER trg_del BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION allow_del()",
    "INSERT INTO t VALUES (1), (2)",
    "DELETE FROM t WHERE id = 1",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "WHEN clause comparing OLD and NEW on update",
  [
    "CREATE TABLE t (id int, v int, note text)",
    "CREATE FUNCTION mark_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := 'changed'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_mark BEFORE UPDATE ON t FOR EACH ROW WHEN (OLD.v IS DISTINCT FROM NEW.v) EXECUTE FUNCTION mark_change()",
    "INSERT INTO t VALUES (1, 10, NULL), (2, 20, NULL)",
    "UPDATE t SET v = 11 WHERE id = 1",
    "UPDATE t SET v = 20 WHERE id = 2",
  ],
  "SELECT * FROM t ORDER BY id",
);

sequenceParity(
  "one trigger function attached to INSERT and UPDATE",
  [
    "CREATE TABLE t (id int, marks int)",
    "CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.marks := coalesce(NEW.marks, 0) + 1; RETURN NEW; END $$",
    "CREATE TRIGGER trg_bump BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION bump()",
  ],
  [
    { sql: "INSERT INTO t VALUES (1, NULL)" },
    { sql: "SELECT * FROM t", query: true },
    { sql: "UPDATE t SET id = 1 WHERE id = 1" },
    { sql: "SELECT * FROM t", query: true },
  ],
);

parity(
  "update trigger fires once per affected row",
  [
    "CREATE TABLE t (id int, touched text)",
    "CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.touched := 'yes'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch()",
    "INSERT INTO t VALUES (1, 'no'), (2, 'no'), (3, 'no')",
    "UPDATE t SET id = id WHERE id > 1",
  ],
  "SELECT * FROM t ORDER BY id",
);
