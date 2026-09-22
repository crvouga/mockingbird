import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "RAISE EXCEPTION in BEFORE INSERT blocks the insert",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denied'; END $$",
    "CREATE TRIGGER trg_deny BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny()",
  ],
  "INSERT INTO t VALUES (1)",
);

sequenceParity(
  "table is unchanged after a trigger exception on a single-row insert",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denied'; END $$",
    "CREATE TRIGGER trg_deny BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny()",
  ],
  [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "SELECT count(*) AS n FROM t", query: true }],
);

errorParity(
  "conditional RAISE EXCEPTION only fires for matching rows",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION deny_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id > 10 THEN RAISE EXCEPTION 'too big'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_big BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny_big()",
    "INSERT INTO t VALUES (5)",
  ],
  "INSERT INTO t VALUES (11)",
);

sequenceParity(
  "rows below the RAISE threshold insert normally",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION deny_big() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id > 10 THEN RAISE EXCEPTION 'too big'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_big BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny_big()",
  ],
  [
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "INSERT INTO t VALUES (10)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

errorParity(
  "RAISE EXCEPTION in BEFORE UPDATE blocks a single-row update",
  [
    "CREATE TABLE t (id int, v int)",
    "CREATE FUNCTION no_decrease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.v < OLD.v THEN RAISE EXCEPTION 'cannot decrease'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_dec BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION no_decrease()",
    "INSERT INTO t VALUES (1, 10)",
  ],
  "UPDATE t SET v = 5 WHERE id = 1",
);

sequenceParity(
  "value is unchanged after the update trigger exception",
  [
    "CREATE TABLE t (id int, v int)",
    "CREATE FUNCTION no_decrease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.v < OLD.v THEN RAISE EXCEPTION 'cannot decrease'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER trg_dec BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION no_decrease()",
    "INSERT INTO t VALUES (1, 10)",
  ],
  [
    { sql: "UPDATE t SET v = 5 WHERE id = 1" },
    { sql: "SELECT v FROM t WHERE id = 1", query: true },
    { sql: "UPDATE t SET v = 20 WHERE id = 1" },
    { sql: "SELECT v FROM t WHERE id = 1", query: true },
  ],
);

errorParity(
  "RAISE EXCEPTION in BEFORE DELETE blocks a single-row delete",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION no_del() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'protected'; END $$",
    "CREATE TRIGGER trg_prot BEFORE DELETE ON t FOR EACH ROW EXECUTE FUNCTION no_del()",
    "INSERT INTO t VALUES (1)",
  ],
  "DELETE FROM t WHERE id = 1",
);

sequenceParity(
  "trigger exception inside a transaction can be rolled back past",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denied'; END $$",
    "CREATE TRIGGER trg_deny BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION deny()",
  ],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT sp" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "ROLLBACK TO sp" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);
