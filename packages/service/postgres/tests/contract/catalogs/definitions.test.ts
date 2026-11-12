import { parity, queryErrorParity } from "../helpers.ts";

// #689: catalog columns, information_schema views and pg_get_* functions introspection tools read

const SCHEMA = [
  "CREATE TABLE def_parent (id int PRIMARY KEY, code text UNIQUE, a int, b int, UNIQUE (a, b))",
  `CREATE TABLE def_child (
     pid int REFERENCES def_parent (id) ON DELETE CASCADE,
     n int CHECK (n > 0),
     a int, b int,
     c text NOT NULL,
     CONSTRAINT def_fk2 FOREIGN KEY (a, b) REFERENCES def_parent (a, b) MATCH FULL ON UPDATE SET NULL DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT def_ck2 CHECK (c <> '' AND n < 100))`,
  "CREATE VIEW def_v AS SELECT 1 AS a",
  "CREATE FUNCTION def_tg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
  "CREATE TRIGGER def_b BEFORE INSERT ON def_child FOR EACH ROW EXECUTE FUNCTION def_tg()",
  "CREATE TRIGGER def_a AFTER UPDATE OF n OR DELETE ON def_child FOR EACH STATEMENT EXECUTE FUNCTION def_tg()",
  "CREATE TRIGGER def_w BEFORE UPDATE ON def_child FOR EACH ROW WHEN (OLD.n IS DISTINCT FROM NEW.n) EXECUTE FUNCTION def_tg('x', 'y')",
  "CREATE FUNCTION def_add(a int, b int DEFAULT 2) RETURNS int LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT a + b $$",
  "CREATE FUNCTION def_srf(n int) RETURNS SETOF int LANGUAGE sql AS 'SELECT generate_series(1, n)'",
  "CREATE FUNCTION def_tab(n int) RETURNS TABLE(x int, y text) LANGUAGE sql AS $$ SELECT 1, 'a' $$",
];

parity(
  "pg_proc.prorettype finds trigger functions",
  SCHEMA,
  "SELECT count(*)::int AS trigger_functions FROM pg_proc WHERE prorettype = 'trigger'::regtype AND proname = 'def_tg'",
);

parity(
  "pg_proc return types, strictness and volatility",
  SCHEMA,
  `SELECT proname, prorettype::regtype::text AS rettype, proretset, proisstrict, provolatile, pronargs
   FROM pg_proc WHERE proname LIKE 'def\\_%' ORDER BY proname`,
);

parity(
  "pg_constraint keys, actions and match type",
  SCHEMA,
  `SELECT conname, contype, conkey::text, confkey::text, confdeltype, confupdtype, confmatchtype,
          condeferrable, condeferred, convalidated
   FROM pg_constraint WHERE conrelid IN ('def_parent'::regclass, 'def_child'::regclass) ORDER BY conrelid, conname`,
);

parity(
  "pg_get_constraintdef for every kind of constraint",
  SCHEMA,
  `SELECT conname, pg_get_constraintdef(oid) AS def, pg_get_constraintdef(oid, true) AS pretty
   FROM pg_constraint WHERE conrelid IN ('def_parent'::regclass, 'def_child'::regclass) ORDER BY conrelid, conname`,
);

parity(
  "pg_index.indkey numbers the key columns from subscript 0",
  SCHEMA,
  `SELECT i.indkey[0] AS first_key, a.attname
   FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = 'def_parent'::regclass ORDER BY a.attname`,
);

parity(
  "pg_get_triggerdef and pg_trigger columns",
  SCHEMA,
  `SELECT tgname, pg_get_triggerdef(oid) AS def, pg_get_triggerdef(oid, true) AS pretty, tgtype, tgenabled,
          tgfoid::regproc::text AS fn, tgnargs
   FROM pg_trigger WHERE tgrelid = 'def_child'::regclass AND NOT tgisinternal ORDER BY tgname`,
);

parity(
  "pg_get_functiondef and its parts",
  SCHEMA,
  `SELECT pg_get_functiondef('def_tg'::regproc) AS tg, pg_get_functiondef('def_add'::regproc) AS add,
          pg_get_functiondef('def_srf'::regproc) AS srf, pg_get_functiondef('def_tab'::regproc) AS tab,
          pg_get_function_arguments('def_add'::regproc) AS args,
          pg_get_function_identity_arguments('def_add'::regproc) AS identity,
          pg_get_function_result('def_tab'::regproc) AS result`,
);

parity(
  "regtype and regproc input",
  SCHEMA,
  `SELECT 'int4'::regtype::oid::int AS oid, 'now'::regproc::text AS proc, 'varchar(10)'::regtype::text AS varchar,
          'int4[]'::regtype::text AS arr, 'trigger'::regtype::text AS pseudo, 23::regtype::text AS by_oid,
          to_regtype('def_nosuch') AS missing_type, to_regproc('def_add')::text AS fn`,
);

queryErrorParity("an unknown type name is 42704", [], "SELECT 'def_nosuch'::regtype");
queryErrorParity("an unknown function name is 42883", [], "SELECT 'def_nosuch'::regproc");

parity(
  "format_type prints the type modifier",
  [],
  `SELECT format_type(1043, 36) AS varchar32, format_type(1700, 655366) AS numeric_10_2, format_type(1042, 14) AS char10,
          format_type(1114, 3) AS ts3, format_type(1184, 6) AS tstz6, format_type(1083, 2) AS time2,
          format_type(1560, 5) AS bit5, format_type(1562, 5) AS varbit5, format_type(1015, 36) AS varchar_array,
          format_type(1043, -1) AS no_mod, format_type(1043, NULL) AS null_mod, format_type(1042, -1) AS bpchar,
          format_type(99999, NULL) AS unknown, format_type(NULL, 1) AS null_oid, format_type(2279, NULL) AS pseudo`,
);

parity(
  "pg_views.definition and pg_get_viewdef",
  [
    "CREATE TABLE def_t (a int, b text)",
    "CREATE TABLE def_u (a int, c text)",
    "CREATE VIEW def_v1 AS SELECT 1 AS a",
    "CREATE VIEW def_v2 AS SELECT a AS x, b, a + 1 AS y, upper(b) FROM def_t WHERE a > 1 AND b <> 'x' GROUP BY a, b HAVING count(*) > 1 ORDER BY b DESC LIMIT 5 OFFSET 2",
    "CREATE VIEW def_v3 AS SELECT def_t.a, def_u.c FROM def_t JOIN def_u ON def_t.a = def_u.a LEFT JOIN def_u u2 ON u2.a = def_t.a",
    "CREATE VIEW def_v4 AS SELECT * FROM def_t",
    "CREATE VIEW def_v5 AS SELECT a FROM def_t UNION ALL SELECT a FROM def_u",
    "CREATE VIEW def_v6 AS SELECT DISTINCT b FROM def_t",
    "CREATE VIEW def_v7 AS SELECT 'x'::text AS s, CASE WHEN a > 1 THEN 'big' ELSE 'small' END AS sz FROM def_t",
  ],
  `SELECT viewname, definition, pg_get_viewdef(viewname::regclass, true) AS pretty
   FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
);

parity(
  "information_schema.views.view_definition",
  ["CREATE VIEW def_v AS SELECT 1 AS a"],
  "SELECT view_definition FROM information_schema.views WHERE table_name = 'def_v'",
);

parity(
  "information_schema.triggers",
  SCHEMA,
  "SELECT * FROM information_schema.triggers WHERE event_object_table = 'def_child' ORDER BY trigger_name, event_manipulation",
);

parity(
  "information_schema.constraint_column_usage",
  SCHEMA,
  `SELECT table_name, column_name, constraint_name FROM information_schema.constraint_column_usage
   WHERE constraint_schema = 'public' ORDER BY constraint_name, column_name`,
);

parity(
  "information_schema.referential_constraints",
  SCHEMA,
  "SELECT * FROM information_schema.referential_constraints WHERE constraint_schema = 'public' ORDER BY constraint_name",
);

parity(
  "information_schema.check_constraints includes NOT NULL",
  SCHEMA,
  "SELECT constraint_name, check_clause FROM information_schema.check_constraints WHERE constraint_schema = 'public' ORDER BY constraint_name",
);

parity(
  "information_schema.table_constraints lists PostgreSQL 18's NOT NULL constraints",
  SCHEMA,
  `SELECT table_name, constraint_name, constraint_type, is_deferrable, initially_deferred, enforced, nulls_distinct
   FROM information_schema.table_constraints WHERE table_schema = 'public' ORDER BY table_name, constraint_type, constraint_name`,
);

parity(
  "the standard foreign-key query joins three information_schema views",
  SCHEMA,
  `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
   JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
   WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'def_child'
   ORDER BY 1, 2, 4`,
);

parity(
  "pg_stat_database has a row for the current database",
  [],
  "SELECT numbackends >= 0 AS ok, xact_rollback >= 0 AS counters FROM pg_stat_database WHERE datname = current_database()",
);

parity(
  "pg_database collation columns",
  [],
  "SELECT datcollate IS NOT NULL AS has_collation, datlocprovider, datconnlimit, datallowconn FROM pg_database WHERE datname = current_database()",
);
