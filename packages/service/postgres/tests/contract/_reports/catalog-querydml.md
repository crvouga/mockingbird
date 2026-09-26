# Catalog (SEL/JOI/CTE/DDL/DML/CON) divergences

Divergences found while authoring the construct-level scenario catalog sections SEL, JOI, CTE,
DDL, DML, and CON. Each bullet records the SQL, the memory result, and the PGlite (Postgres 18.3)
oracle result. Entries already covered by `dml-ddl.md` or `query-surface.md` are not repeated.

## ddl

- `DROP TABLE t CASCADE` with a dependent view `v` (kept as `DDL-drop-03`, documented_divergence)
  — memory: succeeds but leaves the view behind (`pg_class` still lists `v`; selecting from it then
  fails with `relation "t" does not exist`); oracle: CASCADE also drops the dependent view
  (`pg_class` count for `v` is 0). Related to the `dml-ddl.md` entry about RESTRICT-mode DROP not
  detecting dependents, but this is the CASCADE side: the cascade never reaches dependent views.
- `COMMENT ON TABLE t IS 'catalog table'` then `SELECT obj_description(oid) FROM pg_class WHERE
  relname = 't'` (kept as `DDL-comment-01`, documented_divergence)
  — memory: COMMENT ON parses and succeeds but stores nothing; `obj_description(oid)` returns NULL
  (and `pg_description` does not exist as a relation); oracle: returns `catalog table`.
  Also note `SELECT obj_description('t'::regclass)` fails in memory with `input of type regclass is
  not supported`, so the memory-side assertion goes through `pg_class.oid` instead.
- `INSERT INTO t VALUES ('angry')` where the column is `mood AS ENUM ('sad', 'happy')` (kept as
  `DDL-enum-02`, Tier B error)
  — both fail with SQLSTATE 22P02, but memory qualifies the type name:
  `invalid input value for enum public.mood: "angry"` vs oracle
  `invalid input value for enum mood: "angry"` (message-template mismatch only).
