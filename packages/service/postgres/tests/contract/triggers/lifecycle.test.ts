import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "DROP TRIGGER stops the trigger from firing",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_set BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
  ],
  [
    { sql: "INSERT INTO t VALUES (1, 'orig')" },
    { sql: "DROP TRIGGER trg_set ON t" },
    { sql: "INSERT INTO t VALUES (2, 'orig')" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

errorParity(
  "DROP TRIGGER of a missing trigger fails",
  ["CREATE TABLE t (id int)"],
  "DROP TRIGGER no_such_trigger ON t",
  "undefined_object",
);

sequenceParity(
  "DROP TRIGGER IF EXISTS on a missing trigger is a no-op",
  ["CREATE TABLE t (id int)"],
  [{ sql: "DROP TRIGGER IF EXISTS no_such_trigger ON t" }, { sql: "SELECT 1 AS v", query: true }],
);

errorParity(
  "CREATE TRIGGER on a missing table fails with 42P01",
  ["CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"],
  "CREATE TRIGGER trg BEFORE INSERT ON missing_table FOR EACH ROW EXECUTE FUNCTION f()",
  "undefined_table",
);

errorParity(
  "duplicate trigger name on the same table fails",
  [
    "CREATE TABLE t (id int)",
    "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
  ],
  "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
  "duplicate_object",
);

sequenceParity(
  "same trigger name on different tables is allowed",
  [
    "CREATE TABLE t1 (id int, v text)",
    "CREATE TABLE t2 (id int, v text)",
    "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
    "CREATE TRIGGER trg BEFORE INSERT ON t1 FOR EACH ROW EXECUTE FUNCTION set_v()",
    "CREATE TRIGGER trg BEFORE INSERT ON t2 FOR EACH ROW EXECUTE FUNCTION set_v()",
  ],
  [
    { sql: "INSERT INTO t1 VALUES (1, 'orig')" },
    { sql: "INSERT INTO t2 VALUES (1, 'orig')" },
    { sql: "SELECT v FROM t1", query: true },
    { sql: "SELECT v FROM t2", query: true },
  ],
);

sequenceParity(
  "dropping the table removes its triggers implicitly",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'set'; RETURN NEW; END $$",
    "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
  ],
  [
    { sql: "DROP TABLE t" },
    { sql: "CREATE TABLE t (id int, v text)" },
    { sql: "INSERT INTO t VALUES (1, 'orig')" },
    { sql: "SELECT v FROM t", query: true },
  ],
);

sequenceParity(
  "trigger only fires for its declared event",
  [
    "CREATE TABLE t (id int, v text)",
    "CREATE FUNCTION set_v() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 'ins'; RETURN NEW; END $$",
    "CREATE TRIGGER trg_ins BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION set_v()",
  ],
  [
    { sql: "INSERT INTO t VALUES (1, 'orig')" },
    { sql: "UPDATE t SET v = 'updated' WHERE id = 1" },
    { sql: "SELECT * FROM t", query: true },
  ],
);
