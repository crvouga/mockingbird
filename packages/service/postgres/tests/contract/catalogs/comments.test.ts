import { parity, sequenceParity } from "../helpers.ts";

// #686: COMMENT ON is kept and read back through obj_description / col_description / pg_description

const SETUP = [
  "CREATE TABLE cm_t (a int, b text CONSTRAINT cm_b_check CHECK (b <> ''))",
  "COMMENT ON TABLE cm_t IS 'table note'",
  "COMMENT ON COLUMN cm_t.a IS 'column note'",
  "CREATE VIEW cm_v AS SELECT 1 AS a",
  "COMMENT ON VIEW cm_v IS 'view note'",
  "CREATE FUNCTION cm_f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
  "COMMENT ON FUNCTION cm_f() IS 'function note'",
];

parity("COMMENT ON TABLE reads back", SETUP, "SELECT obj_description('cm_t'::regclass, 'pg_class') AS c");
parity(
  "COMMENT ON COLUMN reads back",
  SETUP,
  "SELECT col_description('cm_t'::regclass, 1) AS c, col_description('cm_t'::regclass, 2) AS none",
);
parity("COMMENT ON VIEW reads back", SETUP, "SELECT obj_description(to_regclass('public.cm_v'), 'pg_class') AS c");
parity("COMMENT ON FUNCTION reads back", SETUP, "SELECT obj_description('cm_f'::regproc, 'pg_proc') AS c");
parity(
  "pg_description lists table and column comments",
  SETUP,
  "SELECT objsubid, description FROM pg_description WHERE objoid = 'cm_t'::regclass ORDER BY objsubid",
);
parity(
  "the catalog name must match the object",
  SETUP,
  "SELECT obj_description('cm_t'::regclass, 'pg_proc') AS wrong_catalog, obj_description('cm_t'::regclass) AS any_catalog",
);

sequenceParity("COMMENT ... IS NULL and IS '' remove a comment", SETUP, [
  { sql: "COMMENT ON TABLE cm_t IS NULL" },
  { sql: "COMMENT ON COLUMN cm_t.a IS ''" },
  {
    sql: "SELECT obj_description('cm_t'::regclass, 'pg_class') AS t, col_description('cm_t'::regclass, 1) AS c",
    query: true,
  },
]);

sequenceParity(
  "comments on sequences, types, domains, constraints and triggers",
  [
    ...SETUP,
    "CREATE SEQUENCE cm_s",
    "CREATE TYPE cm_mood AS ENUM ('a')",
    "CREATE DOMAIN cm_d AS int",
    "CREATE FUNCTION cm_tg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    "CREATE TRIGGER cm_trg BEFORE INSERT ON cm_t FOR EACH ROW EXECUTE FUNCTION cm_tg()",
  ],
  [
    { sql: "COMMENT ON SEQUENCE cm_s IS 'seq note'" },
    { sql: "COMMENT ON TYPE cm_mood IS 'type note'" },
    { sql: "COMMENT ON DOMAIN cm_d IS 'domain note'" },
    { sql: "COMMENT ON CONSTRAINT cm_b_check ON cm_t IS 'constraint note'" },
    { sql: "COMMENT ON TRIGGER cm_trg ON cm_t IS 'trigger note'" },
    {
      sql: `SELECT obj_description('cm_s'::regclass, 'pg_class') AS s, obj_description('cm_mood'::regtype, 'pg_type') AS t,
              obj_description('cm_d'::regtype, 'pg_type') AS d`,
      query: true,
    },
    {
      sql: "SELECT d.description FROM pg_description d JOIN pg_constraint c ON c.oid = d.objoid AND d.classoid = 'pg_constraint'::regclass WHERE c.conname = 'cm_b_check'",
      query: true,
    },
    {
      sql: "SELECT d.description FROM pg_description d JOIN pg_trigger t ON t.oid = d.objoid AND d.classoid = 'pg_trigger'::regclass WHERE t.tgname = 'cm_trg'",
      query: true,
    },
  ],
);

sequenceParity("a comment follows a renamed column and rolls back with its transaction", SETUP, [
  { sql: "ALTER TABLE cm_t RENAME COLUMN a TO a2" },
  { sql: "SELECT col_description('cm_t'::regclass, 1) AS c", query: true },
  { sql: "BEGIN" },
  { sql: "COMMENT ON COLUMN cm_t.a2 IS 'in transaction'" },
  { sql: "ROLLBACK" },
  { sql: "SELECT col_description('cm_t'::regclass, 1) AS c", query: true },
]);

sequenceParity("COMMENT ON a missing or mismatched object fails", SETUP, [
  { sql: "COMMENT ON FUNCTION cm_missing() IS 'x'" },
  { sql: "COMMENT ON COLUMN cm_t.missing IS 'x'" },
  { sql: "COMMENT ON TABLE cm_missing IS 'x'" },
  { sql: "COMMENT ON TABLE cm_v IS 'x'" },
  { sql: "COMMENT ON INDEX cm_t IS 'x'" },
  { sql: "COMMENT ON CONSTRAINT cm_missing ON cm_t IS 'x'" },
]);
