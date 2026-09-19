import { parity } from "../helpers.ts";

parity(
  "BEFORE INSERT trigger assigns a NEW column",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_set BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
    "INSERT INTO t VALUES (1, 'orig')",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "BEFORE INSERT trigger computes from another NEW column",
  [
    "CREATE TABLE t (id int, doubled int)",
    "CREATE FUNCTION dbl() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.doubled := NEW.id * 2; RETURN NEW; END $$",
    "CREATE TRIGGER trg_dbl BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION dbl()",
    "INSERT INTO t VALUES (1, NULL), (5, NULL)",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "BEFORE INSERT returning NULL suppresses the row",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION skip_neg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id < 0 THEN RETURN NULL; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_skip BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION skip_neg()",
    "INSERT INTO t VALUES (-1), (2), (-3), (4)",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "IF ELSIF ELSE chain in a trigger body",
  [
    "CREATE TABLE t (score int, grade text)",
    "CREATE FUNCTION grade_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.score >= 90 THEN NEW.grade := 'A'; ELSIF NEW.score >= 80 THEN NEW.grade := 'B'; ELSE NEW.grade := 'C'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_grade BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION grade_fn()",
    "INSERT INTO t VALUES (95, NULL), (85, NULL), (10, NULL)",
  ],
  "SELECT * FROM t ORDER BY score",
);

parity(
  "WHEN clause limits trigger firing",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION tag_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'big'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_when BEFORE INSERT ON t FOR EACH ROW WHEN (NEW.id > 10) EXECUTE FUNCTION tag_big()",
    "INSERT INTO t VALUES (1, 'small'), (11, 'was'), (5, 'tiny'), (100, 'was')",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "trigger fires for INSERT ... SELECT rows",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (1), (2)",
    "CREATE TABLE t (id int, stamp text)",
    "CREATE FUNCTION stamp_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.stamp := 'stamped'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_stamp BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION stamp_fn()",
    "INSERT INTO t SELECT id, 'raw' FROM src",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "two BEFORE INSERT triggers chain their effects",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION append_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'a'; RETURN NEW; END $$",
    "CREATE FUNCTION append_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := NEW.v || 'b'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_1_first BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_a()",
    "CREATE TRIGGER trg_2_second BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION append_b()",
    "INSERT INTO t VALUES (1, '')",
  ],
  "SELECT * FROM t",
);

parity(
  "AFTER INSERT trigger returning NULL does not suppress the row",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
    "CREATE TRIGGER trg_after AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION noop()",
    "INSERT INTO t VALUES (1), (2)",
  ],
  "SELECT * FROM t ORDER BY id",
);
