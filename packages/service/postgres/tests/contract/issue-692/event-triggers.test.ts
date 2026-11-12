import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, sequenceParity } from "../helpers.ts";

// #692: event triggers — CREATE / ALTER / DROP EVENT TRIGGER, ddl_command_start / _end, sql_drop,
// table_rewrite, TG_EVENT / TG_TAG, pg_event_trigger_ddl_commands() / _dropped_objects().

const q = (sql: string) => ({ sql, query: true });
const fn = [
  "CREATE TABLE log (n serial, ev text, tag text, extra text)",
  "CREATE FUNCTION ev() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log (ev, tag) VALUES (tg_event, tg_tag); END $$",
];

sequenceParity(
  "CREATE FUNCTION ... RETURNS event_trigger",
  [],
  [
    { sql: "CREATE FUNCTION ev() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$" },
    q("SELECT proname, prorettype::regtype::text AS rettype FROM pg_proc WHERE proname = 'ev'"),
  ],
);
sequenceParity(
  "the four DDL events fire in trigger-name order, filtered by tag",
  [
    ...fn,
    "CREATE EVENT TRIGGER a_start ON ddl_command_start EXECUTE FUNCTION ev()",
    "CREATE EVENT TRIGGER b_end ON ddl_command_end WHEN TAG IN ('create table', 'DROP TABLE') EXECUTE PROCEDURE ev()",
    "CREATE EVENT TRIGGER c_drop ON sql_drop EXECUTE FUNCTION ev()",
    "CREATE EVENT TRIGGER d_rw ON table_rewrite EXECUTE FUNCTION ev()",
  ],
  [
    { sql: "CREATE TABLE t (a int)" },
    { sql: "ALTER TABLE t ADD COLUMN b text" },
    { sql: "ALTER TABLE t ALTER COLUMN a TYPE bigint" },
    { sql: "CREATE INDEX ON t (a)" },
    { sql: "INSERT INTO t VALUES (1, 'x')" },
    { sql: "COMMENT ON TABLE t IS 'note'" },
    { sql: "DROP TABLE t" },
    q("SELECT ev, tag FROM log ORDER BY n"),
    q("SELECT evtname, evtevent, evtenabled, evttags FROM pg_event_trigger ORDER BY 1"),
  ],
);
sequenceParity(
  "ALTER EVENT TRIGGER ENABLE / DISABLE / RENAME, DROP EVENT TRIGGER",
  [...fn, "CREATE EVENT TRIGGER a_start ON ddl_command_start EXECUTE FUNCTION ev()"],
  [
    { sql: "ALTER EVENT TRIGGER a_start DISABLE" },
    { sql: "CREATE TABLE t1 (a int)" },
    { sql: "ALTER EVENT TRIGGER a_start ENABLE ALWAYS" },
    { sql: "CREATE TABLE t2 (a int)" },
    { sql: "ALTER EVENT TRIGGER a_start RENAME TO z_start" },
    q("SELECT evtname, evtenabled FROM pg_event_trigger"),
    q("SELECT ev, tag FROM log ORDER BY n"),
    { sql: "DROP EVENT TRIGGER IF EXISTS nope" },
    { sql: "DROP EVENT TRIGGER z_start" },
    { sql: "CREATE TABLE t3 (a int)" },
    q("SELECT count(*) FROM log"),
  ],
);
sequenceParity(
  "pg_event_trigger_ddl_commands() and pg_event_trigger_dropped_objects()",
  [
    "CREATE TABLE log (n serial, ev text, tag text, extra text)",
    "CREATE FUNCTION cmds() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP INSERT INTO log (ev, tag, extra) VALUES (r.command_tag, r.object_type, r.schema_name || ':' || r.object_identity); END LOOP; END $$",
    "CREATE EVENT TRIGGER e_cmds ON ddl_command_end EXECUTE FUNCTION cmds()",
    "CREATE FUNCTION drops() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP INSERT INTO log (ev, tag, extra) VALUES ('dropped', r.object_type, r.object_identity || ':' || r.original::text || ':' || r.normal::text); END LOOP; END $$",
    "CREATE EVENT TRIGGER f_drops ON sql_drop EXECUTE FUNCTION drops()",
  ],
  [
    { sql: "CREATE TABLE u (a int PRIMARY KEY)" },
    { sql: "CREATE VIEW v AS SELECT * FROM u" },
    { sql: "DROP VIEW v" },
    { sql: "DROP TABLE u" },
    q("SELECT ev, tag, extra FROM log ORDER BY n"),
  ],
);
sequenceParity(
  "an event trigger that raises takes the command back",
  [
    "CREATE FUNCTION boom() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no ddl: %', tg_tag; END $$",
    "CREATE EVENT TRIGGER g_boom ON ddl_command_end WHEN TAG IN ('CREATE SEQUENCE') EXECUTE FUNCTION boom()",
  ],
  [{ sql: "CREATE SEQUENCE s" }, q("SELECT count(*) FROM pg_class WHERE relname = 's'")],
);
errorParity(
  "the function must return event_trigger",
  ["CREATE FUNCTION notev() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
  "CREATE EVENT TRIGGER bad ON ddl_command_start EXECUTE FUNCTION notev()",
);
errorParity("an unknown event", fn, "CREATE EVENT TRIGGER bad ON foo EXECUTE FUNCTION ev()", "syntax");
errorParity(
  "an unknown tag",
  fn,
  "CREATE EVENT TRIGGER bad ON ddl_command_start WHEN TAG IN ('CREATE FOO') EXECUTE FUNCTION ev()",
  "syntax",
);
errorParity(
  "a duplicate name",
  [...fn, "CREATE EVENT TRIGGER a ON ddl_command_start EXECUTE FUNCTION ev()"],
  "CREATE EVENT TRIGGER a ON ddl_command_end EXECUTE FUNCTION ev()",
  "duplicate_object",
);
errorParity("DROP a missing event trigger", [], "DROP EVENT TRIGGER nope", "undefined_object");
errorParity(
  "a function an event trigger uses cannot be dropped",
  [...fn, "CREATE EVENT TRIGGER a ON ddl_command_start EXECUTE FUNCTION ev()"],
  "DROP FUNCTION ev()",
);
errorParity(
  "pg_event_trigger_ddl_commands() outside an event trigger",
  [],
  "SELECT * FROM pg_event_trigger_ddl_commands()",
);

test("table_rewrite exposes the table and the reason", () => {
  const db = new Database();
  db.exec("CREATE TABLE log (oid oid, reason int)");
  db.exec(
    "CREATE FUNCTION rw() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (pg_event_trigger_table_rewrite_oid(), pg_event_trigger_table_rewrite_reason()); END $$",
  );
  db.exec("CREATE EVENT TRIGGER rw ON table_rewrite EXECUTE FUNCTION rw()");
  db.exec("CREATE TABLE t (a int)");
  db.exec("ALTER TABLE t ALTER COLUMN a TYPE bigint");
  expect(db.query("SELECT oid = 't'::regclass AS same, reason FROM log")).toEqual([{ same: true, reason: 4 }]);
});
