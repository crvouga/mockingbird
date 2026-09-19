import { expect } from "bun:test";
import { CAT_SECTION } from "../../../compat/sections/cat.ts";
import { runCatalog } from "./run.ts";

runCatalog(CAT_SECTION, [
  {
    id: "CAT-class-01",
    kind: "parity",
    setup: ["CREATE TABLE t (id int)"],
    sql: "SELECT relname, relkind FROM pg_class WHERE relname = 't'",
  },
  {
    id: "CAT-class-02",
    kind: "parity",
    setup: ["CREATE TABLE t (id int)", "CREATE VIEW myv AS SELECT id FROM t"],
    sql: "SELECT relname, relkind FROM pg_class WHERE relname = 'myv'",
  },
  {
    id: "CAT-class-03",
    kind: "parity",
    setup: ["CREATE SEQUENCE seq_cat"],
    sql: "SELECT relname, relkind FROM pg_class WHERE relname = 'seq_cat'",
  },
  {
    id: "CAT-class-04",
    kind: "parity",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
    sql: "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 't'",
  },
  {
    id: "CAT-class-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
      { sql: "DROP TABLE t" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
    ],
  },
  {
    id: "CAT-attr-01",
    kind: "parity",
    setup: ["CREATE TABLE t (id int, name text, flag boolean)"],
    sql: "SELECT a.attname, a.attnum FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
  },
  {
    id: "CAT-attr-02",
    kind: "parity",
    setup: ["CREATE TABLE t (id int PRIMARY KEY, req text NOT NULL, opt text)"],
    sql: "SELECT a.attname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
  },
  {
    id: "CAT-attr-03",
    kind: "parity",
    setup: ["CREATE TABLE t (id int, name text, weight float8, big bigint)"],
    sql: "SELECT a.attname, ty.typname FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid JOIN pg_type ty ON a.atttypid = ty.oid WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum",
  },
  {
    id: "CAT-type-01",
    kind: "parity",
    sql: "SELECT typname FROM pg_type WHERE typname IN ('int4', 'int8', 'text', 'bool') ORDER BY typname",
  },
  {
    id: "CAT-ns-01",
    kind: "parity",
    sql: "SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'pg_catalog', 'information_schema') ORDER BY nspname",
  },
  {
    id: "CAT-proc-01",
    kind: "parity",
    setup: ["CREATE FUNCTION uf(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$"],
    sql: "SELECT proname, pronargs FROM pg_proc WHERE proname = 'uf'",
  },
  {
    id: "CAT-proc-02",
    kind: "parity",
    setup: [
      "CREATE FUNCTION ov(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$",
      "CREATE FUNCTION ov(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$",
    ],
    sql: "SELECT proname, pronargs FROM pg_proc WHERE proname = 'ov' ORDER BY pronargs",
  },
  {
    id: "CAT-proc-03",
    kind: "parity",
    sql: "SELECT count(*) > 0 AS present FROM pg_proc WHERE proname = 'lower'",
  },
  {
    id: "CAT-tabs-01",
    kind: "parity",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
    sql: "SELECT schemaname, tablename FROM pg_tables WHERE tablename = 't'",
  },
  {
    id: "CAT-views-01",
    kind: "parity",
    setup: ["CREATE TABLE t (id int)", "CREATE VIEW myv AS SELECT id FROM t"],
    sql: "SELECT viewname FROM pg_views WHERE viewname = 'myv'",
  },
  {
    id: "CAT-info-01",
    kind: "parity",
    setup: ["CREATE TABLE t (id int)"],
    sql: "SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables WHERE table_name = 't'",
  },
  {
    id: "CAT-info-02",
    kind: "parity",
    setup: ["CREATE TABLE t (id int)", "CREATE VIEW infv AS SELECT id FROM t"],
    sql: "SELECT table_name, table_type FROM information_schema.tables WHERE table_name = 'infv'",
  },
  {
    id: "CAT-info-03",
    kind: "parity",
    setup: ["CREATE TABLE t (id int NOT NULL, name varchar(10), flag boolean)"],
    sql: "SELECT column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
  },
  {
    id: "CAT-info-04",
    kind: "parity",
    setup: ["CREATE TABLE t (a int, b text, c bigint)"],
    sql: "SELECT column_name, ordinal_position FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
  },
  {
    id: "CAT-info-05",
    kind: "parity",
    setup: ["CREATE TABLE t (i int, b bigint, s smallint, r real, d double precision, n numeric(10,2))"],
    sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
  },
  {
    id: "CAT-cons-01",
    kind: "parity",
    setup: ["CREATE TABLE c (id int PRIMARY KEY, v text UNIQUE, w int CHECK (w > 0))"],
    // not-null CHECK rows (c_id_not_null) are excluded: memory does not emit them (see catalog-session.md)
    sql: "SELECT constraint_name, constraint_type FROM information_schema.table_constraints WHERE table_name = 'c' AND constraint_name NOT LIKE '%not_null' ORDER BY constraint_name",
  },
  {
    id: "CAT-cons-02",
    kind: "parity",
    setup: ["CREATE TABLE c (id int PRIMARY KEY, v text UNIQUE)"],
    sql: "SELECT constraint_name, column_name FROM information_schema.key_column_usage WHERE table_name = 'c' ORDER BY constraint_name",
  },
  {
    id: "CAT-cons-03",
    kind: "parity",
    setup: ["CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE ch (pid int REFERENCES p(id))"],
    sql: "SELECT constraint_type FROM information_schema.table_constraints WHERE table_name = 'ch' AND constraint_type = 'FOREIGN KEY'",
  },
  {
    id: "CAT-fn-01",
    kind: "parity",
    sql: "SELECT current_database() AS d, current_schema() AS s",
  },
  {
    id: "CAT-fn-02",
    kind: "parity",
    sql: "SELECT version() LIKE 'PostgreSQL %' AS looks_like_postgres",
  },
  {
    id: "CAT-ver-01",
    kind: "divergence",
    fn: (db) => {
      const row = db.query<{ v: string }>("SELECT version() AS v")[0]!;
      expect(row.v).toStartWith("PostgreSQL 18.3");
      expect(row.v).toContain("postgres-mem");
    },
  },
  {
    id: "CAT-viewdef-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      db.exec("CREATE VIEW myv AS SELECT id FROM t");
      expect(() => db.query("SELECT pg_get_viewdef('myv') AS d")).toThrow(/pg_get_viewdef/);
    },
  },
]);
