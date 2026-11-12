import { errorParity, sequenceParity } from "../helpers.ts";

// #679: trigger bodies run on the same PL/pgSQL interpreter as functions and DO blocks.
sequenceParity(
  "BEFORE DELETE trigger reads OLD in an embedded INSERT",
  [
    "CREATE TABLE d (a int)",
    "CREATE TABLE log (v text)",
    "INSERT INTO d VALUES (7)",
    "CREATE FUNCTION t_old() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (OLD.a::text); RETURN OLD; END $$",
    "CREATE TRIGGER d_old BEFORE DELETE ON d FOR EACH ROW EXECUTE FUNCTION t_old()",
  ],
  [
    { sql: "DELETE FROM d RETURNING a", query: true },
    { sql: "SELECT v FROM log", query: true },
    { sql: "SELECT count(*)::int AS n FROM d", query: true },
  ],
);

sequenceParity(
  "trigger body with a DECLARE section",
  [
    "CREATE TABLE c (a int)",
    "CREATE FUNCTION t_declare() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n int := 1; BEGIN NEW.a := NEW.a + n; RETURN NEW; END $$",
    "CREATE TRIGGER c_declare BEFORE INSERT ON c FOR EACH ROW EXECUTE FUNCTION t_declare()",
  ],
  [{ sql: "INSERT INTO c VALUES (1) RETURNING a", query: true }],
);

sequenceParity(
  "TG_OP, TG_TABLE_NAME, TG_TABLE_SCHEMA, TG_WHEN, TG_LEVEL, TG_NAME, TG_NARGS and TG_ARGV",
  [
    "CREATE TABLE c (a int)",
    "CREATE TABLE log (v text)",
    "CREATE FUNCTION t_op() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (TG_OP || ' ' || TG_TABLE_NAME || ' ' || TG_TABLE_SCHEMA || ' ' || TG_WHEN || ' ' || TG_LEVEL || ' ' || TG_NAME || ' ' || TG_NARGS || ' ' || coalesce(TG_ARGV[0], '-') || ' ' || coalesce(TG_ARGV[1], '-')); RETURN NEW; END $$",
    "CREATE TRIGGER c_op AFTER INSERT ON c FOR EACH ROW EXECUTE FUNCTION t_op()",
    "CREATE TRIGGER c_argv BEFORE UPDATE ON c FOR EACH ROW EXECUTE FUNCTION t_op('x', 'y')",
    "CREATE TRIGGER c_stmt AFTER DELETE ON c FOR EACH STATEMENT EXECUTE FUNCTION t_op('s')",
  ],
  [
    { sql: "INSERT INTO c VALUES (2) RETURNING a", query: true },
    { sql: "UPDATE c SET a = 3 RETURNING a", query: true },
    { sql: "DELETE FROM c" },
    { sql: "SELECT v FROM log ORDER BY v", query: true },
  ],
);

sequenceParity(
  "PERFORM of a function from a trigger body",
  [
    "CREATE TABLE c (a int)",
    "CREATE TABLE log (v text)",
    "CREATE FUNCTION note(v text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (v); END $$",
    "CREATE FUNCTION t_perform() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM note('fired ' || NEW.a); RETURN NEW; END $$",
    "CREATE TRIGGER c_perform AFTER INSERT ON c FOR EACH ROW EXECUTE FUNCTION t_perform()",
  ],
  [
    { sql: "INSERT INTO c VALUES (4) RETURNING a", query: true },
    { sql: "SELECT v FROM log", query: true },
  ],
);

sequenceParity(
  "NEW is NULL in a DELETE trigger and OLD is NULL in an INSERT trigger",
  [
    "CREATE TABLE c (a int)",
    "CREATE TABLE log (v text)",
    "CREATE FUNCTION t_nulls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (TG_OP || ' new=' || (NEW IS NULL)::text || ' old=' || (OLD IS NULL)::text || ' ' || coalesce(OLD.a, -1) || ' ' || coalesce(NEW.a, -1)); IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER c_n BEFORE INSERT OR UPDATE OR DELETE ON c FOR EACH ROW EXECUTE FUNCTION t_nulls()",
  ],
  [
    { sql: "INSERT INTO c VALUES (1)" },
    { sql: "UPDATE c SET a = 2" },
    { sql: "DELETE FROM c" },
    { sql: "SELECT v FROM log ORDER BY v", query: true },
  ],
);

sequenceParity(
  "a record variable in a trigger body copies NEW",
  [
    "CREATE TABLE c (a int, b text)",
    "CREATE TABLE log (v text)",
    "CREATE FUNCTION t_rec() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r c%ROWTYPE; BEGIN r := NEW; r.b := upper(r.b); INSERT INTO log VALUES (r.a || r.b); NEW.b := r.b; RETURN NEW; END $$",
    "CREATE TRIGGER c_rec BEFORE INSERT ON c FOR EACH ROW EXECUTE FUNCTION t_rec()",
  ],
  [
    { sql: "INSERT INTO c VALUES (1, 'x') RETURNING a, b", query: true },
    { sql: "SELECT v FROM log", query: true },
  ],
);

errorParity(
  "a trigger function that reaches its end without RETURN",
  [
    "CREATE TABLE c (a int)",
    "CREATE FUNCTION t_noreturn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$",
    "CREATE TRIGGER c_nr BEFORE INSERT ON c FOR EACH ROW EXECUTE FUNCTION t_noreturn()",
  ],
  "INSERT INTO c VALUES (1)",
);

// #680: the three shapes of trigger in a pg_dump'd schema.
sequenceParity(
  "statement-level invalidation trigger: DECLARE array, TG_OP branches, transition tables, PERFORM",
  [
    "CREATE TABLE pay (id int PRIMARY KEY, order_id int, status text)",
    "CREATE TABLE queue (order_id int)",
    "CREATE FUNCTION enqueue(ids int[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO queue SELECT unnest(ids); END $$",
    "CREATE FUNCTION invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$ DECLARE ids integer[]; BEGIN IF TG_OP = 'INSERT' THEN ids := ARRAY(SELECT changed.order_id FROM new_rows changed); ELSIF TG_OP = 'DELETE' THEN ids := ARRAY(SELECT changed.order_id FROM old_rows changed); ELSE ids := ARRAY(SELECT a.order_id FROM old_rows o FULL JOIN new_rows n ON n.id = o.id CROSS JOIN LATERAL (VALUES (o.order_id), (n.order_id)) AS a(order_id) WHERE o.id IS NULL OR n.id IS NULL OR (o.order_id, o.status) IS DISTINCT FROM (n.order_id, n.status)); END IF; PERFORM public.enqueue(ids); RETURN NULL; END $$",
    "CREATE TRIGGER pay_i AFTER INSERT ON pay REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate()",
    "CREATE TRIGGER pay_u AFTER UPDATE ON pay REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate()",
    "CREATE TRIGGER pay_d AFTER DELETE ON pay REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate()",
  ],
  [
    { sql: "INSERT INTO pay VALUES (1, 10, 'a'), (2, 20, 'a')" },
    { sql: "UPDATE pay SET status = 'b' WHERE id = 1" },
    { sql: "DELETE FROM pay WHERE id = 2" },
    { sql: "SELECT order_id FROM queue ORDER BY 1", query: true },
  ],
);

sequenceParity(
  "BEFORE INSERT guard reads other rows with SELECT ... INTO and raises",
  [
    "CREATE TABLE credit (id int PRIMARY KEY, amount int)",
    "CREATE TABLE alloc (credit_id int, amount int)",
    "INSERT INTO credit VALUES (1, 100)",
    "CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE used int; cap int; BEGIN SELECT coalesce(sum(amount), 0) INTO used FROM alloc WHERE credit_id = NEW.credit_id; SELECT amount INTO cap FROM credit WHERE id = NEW.credit_id FOR UPDATE; IF used + NEW.amount > cap THEN RAISE EXCEPTION 'over-allocated: % > %', used + NEW.amount, cap USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER alloc_guard BEFORE INSERT ON alloc FOR EACH ROW EXECUTE FUNCTION guard()",
  ],
  [
    { sql: "INSERT INTO alloc VALUES (1, 50)" },
    { sql: "INSERT INTO alloc VALUES (1, 60)" },
    { sql: "SELECT count(*)::int AS allocations FROM alloc", query: true },
  ],
);

sequenceParity(
  "BEFORE INSERT OR UPDATE trigger maintains a derived column from TG_OP and OLD",
  [
    "CREATE TABLE thread (id int, status text, waiting_since timestamptz)",
    "CREATE FUNCTION maintain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN IF NEW.status = 'waiting' THEN NEW.waiting_since := now(); ELSE NEW.waiting_since := NULL; END IF; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER thread_m BEFORE INSERT OR UPDATE ON thread FOR EACH ROW EXECUTE FUNCTION maintain()",
  ],
  [
    { sql: "INSERT INTO thread VALUES (1, 'waiting'), (2, 'open')" },
    { sql: "SELECT id, waiting_since IS NOT NULL AS stamped FROM thread ORDER BY id", query: true },
    { sql: "UPDATE thread SET status = 'done' WHERE id = 1" },
    { sql: "SELECT id, waiting_since IS NOT NULL AS stamped FROM thread ORDER BY id", query: true },
  ],
);

sequenceParity(
  "a BEFORE UPDATE trigger that returns NULL skips the row, and NEW is NULL in a statement trigger",
  [
    "CREATE TABLE c (a int, locked bool)",
    "CREATE TABLE log (v text)",
    "INSERT INTO c VALUES (1, true), (2, false)",
    "CREATE FUNCTION t_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.locked THEN RETURN NULL; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER c_lock BEFORE UPDATE ON c FOR EACH ROW EXECUTE FUNCTION t_lock()",
    "CREATE FUNCTION t_stmt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (TG_LEVEL || ' ' || (NEW IS NULL)::text); RETURN NULL; END $$",
    "CREATE TRIGGER c_stmt AFTER UPDATE ON c FOR EACH STATEMENT EXECUTE FUNCTION t_stmt()",
  ],
  [
    { sql: "UPDATE c SET a = a + 10" },
    { sql: "SELECT a FROM c ORDER BY a", query: true },
    { sql: "SELECT v FROM log", query: true },
  ],
);
