# Catalog authoring session divergences (postgres-mem vs PGlite oracle)

Divergences found while authoring the SEQ / TRG / TXN / GUC / SCH / CAT / TSR / CPY / PRE / ERR / ECO
construct-catalog sections. Entries already recorded in `session-system.md` are not repeated here.
Do not fix the engine here; these are recorded for central fixes.

## Divergences shipped as documented_divergence scenarios

- `CREATE TRIGGER trg INSTEAD OF INSERT ON some_view FOR EACH ROW EXECUTE FUNCTION f()`
  — memory: fails with `relation "some_view" does not exist` (trigger creation does not see views);
  oracle: creates the trigger and routes view INSERTs through it. Catalog scenario `TRG-instead-01`.
- `SELECT pg_get_viewdef('myv')` (and the `pg_get_viewdef(oid)` form)
  — memory: 42883 `function pg_get_viewdef(unknown) does not exist`; oracle: returns the view definition text.
  Catalog scenario `CAT-viewdef-01`.
- `SELECT version()`
  — memory: `PostgreSQL 18.3 (postgres-mem) on TypeScript, in-memory engine`; oracle: the real PGlite/Postgres
  build banner. Both start with `PostgreSQL`, so shape parity (`version() LIKE 'PostgreSQL %'`) is kept as the
  differential `CAT-fn-02`; the full text is `CAT-ver-01`.
- COPY cannot be compared differentially through the contract adapters: PGlite streams COPY data on a separate
  channel, so `await pg.query('COPY t TO STDOUT')` returns `rows: []` (only `affectedRows` is set), while memory
  returns the copy text as result rows. All CPY scenarios are therefore memory-only assertions mirroring
  `tests/contract/copy/basic.test.ts`.

## Divergences found while probing (scenarios scoped or not committed)

- `information_schema.table_constraints` does not include the not-null CHECK rows PostgreSQL 18 emits:
  for `CREATE TABLE c (id int PRIMARY KEY, v text UNIQUE, w int CHECK (w > 0))` the oracle returns a fourth row
  `c_id_not_null` / `CHECK`; memory returns only `c_pkey`, `c_v_key`, `c_w_check`. Catalog scenario `CAT-cons-01`
  filters with `constraint_name NOT LIKE '%not_null'` to keep the rest differential.
- `format_type(atttypid, atttypmod)` ignores the typmod: for a `varchar(120)` column memory renders
  `character varying`; oracle renders `character varying(120)`. (Untyped-modifier columns like `int`/`text`
  match; the ECO Drizzle-style scenario uses `pg_type.typname` instead.)
