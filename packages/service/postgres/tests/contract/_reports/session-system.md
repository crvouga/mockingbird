# Session/system contract divergences (postgres-mem vs PGlite oracle)

Cases removed from the session/system contract suites because the in-memory engine diverges from
the Postgres 18.3 oracle. Do not fix the engine here; these are recorded for central fixes.

## Cases removed from written test files

- `BEGIN; ROLLBACK TO SAVEPOINT sp1` (outside any savepoint, and plain `ROLLBACK TO SAVEPOINT sp1` outside a txn)
  — memory: 25P01 `SAVEPOINT can only be used in transaction blocks`; oracle: 25P01
  `ROLLBACK TO SAVEPOINT can only be used in transaction blocks`. Same SQLSTATE, message template names the wrong command.
- `RELEASE SAVEPOINT sp1` outside a transaction
  — memory: 25P01 `SAVEPOINT can only be used in transaction blocks`; oracle: 25P01
  `RELEASE SAVEPOINT can only be used in transaction blocks`.
- `DROP SCHEMA pg_catalog`
  — memory: 3F000 `schema "pg_catalog" does not exist`; oracle: 2BP01
  `cannot drop schema pg_catalog because it is required by the database system`.
- `SET search_path TO no_such_schema; CREATE TABLE t (id int)`
  — memory: table created successfully; oracle: 3F000 `no schema has been selected to create in`.
- `SELECT jsonb_array_length('1'::jsonb)`
  — memory: 22023 `cannot get array length of a non-array`; oracle: 22023 `cannot get array length of a scalar`.
- `SELECT '"hello"'::jsonb ->> 0`
  — memory: NULL; oracle: `hello` (Postgres treats a jsonb scalar as a one-element array for integer extraction).
- `SELECT key, value FROM jsonb_each_text('{"a":{"x":1},"b":"s"}'::jsonb)`
  — memory renders the nested-object value as `{"x":1}`; oracle renders `{"x": 1}` (canonical jsonb spacing).
- `SELECT jsonb_pretty('{"b":[1,2],"a":{"c":1}}'::jsonb)`
  — memory preserves input key order (`b` first); oracle prints canonical jsonb key order (`a` first).
  (Kept a variant whose input is already in canonical order.)
- `SELECT 'abcd'::varchar(3)`
  — memory: succeeds (returns `abcd`); oracle: 22001 `value too long for type character varying(3)`.
  (INSERT into a `varchar(3)` column does raise 22001 in both.)
- `SELECT ts_rank_cd(to_tsvector('english','quick brown fox'), to_tsquery('english','fox'))`
  — memory: `0.06079271` (same as `ts_rank`); oracle: `0.1`.
- `CREATE FUNCTION broken() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT * FROM table_that_does_not_exist; END`
  — memory: succeeds (body not validated at CREATE); oracle: 42P01 at CREATE time.
- `DROP FUNCTION ov(int, int)` with overloads `ov(int)` and `ov(int, int)` defined
  — memory drops every overload (`SELECT ov(5)` then fails 42883); oracle drops only the matching signature.

## Divergences found while probing (cases not committed because they cannot pass)

- Aborted-transaction state is not implemented: after a failed statement inside `BEGIN`, memory keeps
  executing statements successfully; oracle rejects them with 25P02
  `current transaction is aborted, commands ignored until end of transaction block`.
- `COMMIT` of a failed transaction: memory commits the pre-failure work
  (`BEGIN; INSERT ...; SELECT 1/0; COMMIT` leaves the row); oracle treats the COMMIT as rollback (0 rows).
- `ROLLBACK TO sp` does not keep the savepoint usable: rolling back to the same savepoint a second time
  fails to undo work in memory (row count 1 vs oracle 0).
- `SET LOCAL search_path TO pg_catalog` inside a txn: memory `current_schema()` returns NULL; oracle returns `pg_catalog`.
  (Works for user-created schemas; only the pg_catalog case diverges.)
- `set_config('application_name', 'inner', true)` (is_local = true) inside a txn: memory keeps the value after
  COMMIT; oracle reverts it. (`SET LOCAL` itself reverts correctly in both.)
- `SET timezone = 'Not/AZone'`: memory accepts it; oracle: 22023 `invalid value for parameter "TimeZone"`.
- `SHOW search_path` before any SET: memory `"$user", public`; PGlite oracle `public`.
- `SHOW statement_timeout` after `SET statement_timeout = 100`: memory `100`; oracle `100ms` (unit suffix).
- Prepared statements do not survive `ROLLBACK`: `BEGIN; PREPARE p AS SELECT 7; ROLLBACK; EXECUTE p`
  — memory: 26000 `prepared statement "p" does not exist`; oracle: returns 7.
- `regclass` casts unsupported: `SELECT 't'::regclass::text` — memory: 0A000
  `input of type regclass is not supported`; oracle: `t`. This also blocks `pg_table_is_visible('t'::regclass)`.
- `SELECT pg_get_serial_sequence('t', 'id')` for a serial column — memory: NULL; oracle: `public.t_id_seq`.
- Primary-key index relations are absent from pg_class: `SELECT count(*) FROM pg_class WHERE relname = 't_pkey'`
  — memory: 0; oracle: 1.
- `information_schema.columns.column_default` — memory: NULL for serial and DEFAULT columns; oracle:
  `nextval('t_id_seq'::regclass)` / `'x'::text`.
- 42601 syntax-error message wording differs: memory appends parser hints, e.g. `SELECT 1 +` gives
  `syntax error at or near end of input (expected expression)` vs oracle `syntax error at end of input`;
  `SELEC 1` gives `... (unrecognized statement)` vs `syntax error at or near "SELEC"`.
- Ambiguous column not detected (42702): `SELECT id FROM t1, t2` with `id` in both — memory succeeds;
  oracle: 42702 `column reference "id" is ambiguous`.
- Qualified undefined column message quoting: `SELECT t.nope FROM t` — memory: `column "t.nope" does not exist`;
  oracle: `column t.nope does not exist` (unquoted). Same SQLSTATE 42703.
- 42883 message type naming with integer args: memory prints `f(int4, int4)`; oracle prints `f(integer, integer)`.
  (No-arg, unknown-literal, and text-arg variants match and are covered.)
- `DROP FUNCTION nosuchfn(int)` — memory: `function nosuchfn does not exist`; oracle:
  `function nosuchfn(integer) does not exist`.
- Multi-row INSERT is not statement-atomic: `INSERT INTO t VALUES (2), (1), (3)` where `(1)` violates the PK
  leaves `(2)` inserted in memory; oracle inserts nothing. Same for a BEFORE trigger raising on a later row.
- AFTER trigger `RAISE EXCEPTION` does not undo the statement: single-row UPDATE with a raising AFTER UPDATE
  trigger — memory keeps the updated value (5); oracle keeps the original (10).
- Trigger firing order is creation order, not alphabetical: two BEFORE INSERT triggers `trg_zz` (created first)
  and `trg_aa` appending to a column — memory: `ba`; oracle: `ab`.
- `UPDATE OF <column>` trigger column lists are ignored: trigger declared `BEFORE UPDATE OF a` fires in memory
  for an UPDATE that only touches `b` (sets b to 99); oracle does not fire it (b stays 2).
- Trigger bodies do not support `INSERT INTO ...` (audit-table pattern): memory: 0A000
  `trigger body: expected assignment near "into" is not supported`; oracle executes it.
- Named function arguments out of declaration order bind positionally: `f(b => 2, a => 1)` with
  `f(a int, b int) = a * 10 + b` — memory: 21; oracle: 12.
- Named argument skipping a defaulted middle parameter binds wrongly: `f(1, c => 100)` with
  `f(a int, b int DEFAULT 5, c int DEFAULT 7) = a + b + c` — memory: 108; oracle: 106.
- `jsonb_path_query` is not implemented — memory: 42883; oracle: rows.
- `websearch_to_tsquery` is not implemented — memory: 42883; oracle: tsquery.
- `tsquery <-> tsquery` operator is not implemented — memory: 42883
  `operator does not exist: tsquery <-> tsquery`; oracle: `'a' <-> 'b'`.
  (`<->` inside a `to_tsquery` string works and is covered.)
- `to_tsquery('english', 'a &')` error message: memory `syntax error in tsquery: "a &"`; oracle
  `no operand in tsquery: "a &"`. Same SQLSTATE 42601.
- `CREATE SEQUENCE s INCREMENT BY -1 MINVALUE 1 START 1` validation message: memory
  `START value (1) cannot be greater than MAXVALUE (-1)`; oracle `MINVALUE (1) must be less than MAXVALUE (-1)`.
- `ALTER SEQUENCE s MAXVALUE 1` when the sequence already advanced past 1: memory accepts; oracle: 22023
  `MINVALUE (1) must be less than MAXVALUE (1)`.
