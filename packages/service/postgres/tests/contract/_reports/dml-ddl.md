# DML/DDL contract-test divergences (removed cases)

Cases removed from the DML/DDL contract suites because postgres-mem diverges from the PGlite
(Postgres 18.3) oracle. Each bullet records the SQL, the memory result, and the oracle result.
To be fixed centrally in the engine later.

## insert

- `INSERT INTO dst SELECT id, id * 2, 'row ' || id FROM src` (src has int ids; dst is `(id int, doubled int, label text)`)
  — memory: error `invalid input syntax for type integer: "row "` (mistypes the `||` result); oracle: succeeds, label is `row 1` etc.
- `INSERT INTO t (a, b) VALUES (1)` on `t (a int, b int)`
  — memory: succeeds (inserts with missing value); oracle: error 42601 `INSERT has more target columns than expressions`.
- `INSERT INTO t VALUES (1, 2), (3)` on `t (a int, b int)`
  — memory: succeeds; oracle: error 42601 `VALUES lists must all be the same length`.
- Multi-row insert atomicity: on `t (id int PRIMARY KEY)` with row `1`, `INSERT INTO t VALUES (2), (1), (3)`
  — memory: fails but leaves row `2` behind (table ends with `{1, 2}`); oracle: statement is atomic (table stays `{1}`).

## update

- `UPDATE t SET a = 1, a = 2` on `t (a int)`
  — memory: succeeds; oracle: error 42601 `multiple assignments to same column "a"`.
- Update atomicity: on `t (id int CHECK (id < 100))` with rows `{1, 50}`, `UPDATE t SET id = id + 60`
  — memory: fails but first row already updated (state `{50, 61}` — observed value `50` vs oracle `1` on the first row);
  oracle: statement is atomic (state stays `{1, 50}`).

## on-conflict

- `INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.missing`
  — memory: succeeds (does not validate EXCLUDED column names); oracle: error 42703 (column `excluded.missing` does not exist).

## constraints

- `CREATE TABLE t (a int CONSTRAINT c CHECK (a > 0), b int CONSTRAINT c CHECK (b > 0))` (duplicate constraint name)
  — memory: succeeds; oracle: error 42710 `constraint "c" for relation "t" already exists`.

## foreign-keys

- ON DELETE RESTRICT: parent delete with referencing child row
  — memory: 23503 `... violates foreign key constraint ...`; oracle: 23001 `... violates RESTRICT setting of foreign key constraint ...` (distinct SQLSTATE/category for RESTRICT).
- Self-referencing FK: `CREATE TABLE emp (id int PRIMARY KEY, manager int REFERENCES emp(id))`
  — memory: error `relation "emp" does not exist` (cannot create self-referencing table); oracle: succeeds. (Covered 4 removed cases: basic self-FK inserts, violation, row pointing at itself, self-referencing ON DELETE CASCADE.)
- `CREATE TABLE child (pid int REFERENCES parent(id))` where `parent.id` has no unique constraint
  — memory: succeeds; oracle: error 42830 `there is no unique constraint matching given keys for referenced table "parent"`.

## defaults

- `ALTER TABLE t ALTER COLUMN v SET DEFAULT ...`
  — memory: error 0A000 `this ALTER COLUMN form is not supported`; oracle: succeeds. (Covered 4 removed cases: SET DEFAULT affects later inserts, SET DEFAULT expression, replacing an existing default, and `UPDATE ... SET v = DEFAULT` after altering the default. `DROP DEFAULT` works in both.)

## generated

- `CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) STORED, c int GENERATED ALWAYS AS (b + 1) STORED)`
  — memory: succeeds; oracle: error 42P17 (generated column cannot reference another generated column).
- `CREATE TABLE t (a int, b int GENERATED ALWAYS AS ((SELECT 1)) STORED)`
  — memory: succeeds; oracle: error 0A000 (cannot use subquery in generation expression).
- `INSERT INTO t (a, b) VALUES (3, DEFAULT)` where `b` is `GENERATED ALWAYS AS (a * 2) STORED`
  — memory: error `cannot insert a non-DEFAULT value into column "b"`; oracle: succeeds (DEFAULT keyword is allowed for generated columns).
- `INSERT INTO t VALUES (1, 2), (3, 4)` (positional insert covering a generated column)
  — memory: error SQLSTATE 42601; oracle: error SQLSTATE 428C9 `cannot insert a non-DEFAULT value into column "b"` (both fail, different SQLSTATE).

## alter-table

- `ALTER TABLE t ALTER COLUMN v SET NOT NULL`
  — memory: error 0A000 `this ALTER COLUMN form is not supported`; oracle: succeeds (and correctly raises 23502 when existing rows contain nulls). (2 removed cases.)
- `ALTER TABLE t ADD CONSTRAINT n_pos CHECK (n > 0)` with violating existing rows
  — memory: 23514 `new row for relation "t" violates check constraint "n_pos"`; oracle: 23514 `check constraint "n_pos" of relation "t" is violated by some row` (message template mismatch).
- `ALTER TABLE t ADD CONSTRAINT t_id_uniq UNIQUE (id)` with duplicate existing rows
  — memory: 23505 `duplicate key value violates unique constraint "t_id_uniq"`; oracle: 23505 `could not create unique index "t_id_uniq"` (message template mismatch).

## create-table-as

- `SELECT ... INTO tbl FROM ...`
  — memory: error 0A000 `SELECT INTO is not supported`; oracle: supported. (Covered 5 removed cases: basic SELECT INTO, with expressions, result usable as regular table, with ORDER BY/LIMIT, and SELECT INTO an existing table which should raise 42P07.)
- `CREATE TABLE derived AS SELECT n, n * n AS square, 'x' || n AS label FROM src`
  — memory: error `invalid input syntax for type integer: "x"` (same `||` mistyping as the insert case); oracle: succeeds. Removed the `||` column from the CTAS test.
- `CREATE TABLE t (c1, c2) AS SELECT a FROM src` (more override names than columns)
  — memory: succeeds; oracle: error `CREATE TABLE AS specifies too many column names`.

## views

- `DROP VIEW base` (RESTRICT default) with a dependent view `derived`
  — memory: succeeds (drops despite dependency); oracle: error 2BP01 `cannot drop view base because other objects depend on it`.
- `CREATE VIEW v AS SELECT * FROM missing_table`
  — memory: succeeds (lazy name resolution); oracle: error 42P01.
- `CREATE OR REPLACE VIEW vw AS SELECT v FROM t` when `vw` was `SELECT id FROM t`
  — memory: succeeds; oracle: error 42P16 `cannot change name of view column "id" to "v"`.
- `DROP TABLE t` with a dependent view
  — memory: succeeds; oracle: error 2BP01 (dependent objects).

## indexes

- `DROP INDEX ghost` (missing index)
  — memory: 42P01 `index "ghost" does not exist`; oracle: 42704 (undefined_object) with the same message.
- `CREATE UNIQUE INDEX t_id ON t (id)` over existing duplicate rows
  — memory: `duplicate key value violates unique constraint "t_id"`; oracle: `could not create unique index "t_id"` (same 23505, message template mismatch).

## temp

- Temp table shadowing: `CREATE TEMP TABLE t (...)` when a permanent `t` exists
  — memory: error `relation "t" already exists` (no pg_temp schema separation); oracle: succeeds, temp shadows permanent. (Covered 6 removed cases: shadowing reads/writes, `public.t` qualification, drop-reveals-permanent, different shapes.)
- `SELECT v FROM pg_temp.t`
  — memory: error `relation "pg_temp.t" does not exist`; oracle: resolves temp table.
- `CREATE TEMP TABLE public.t (id int)`
  — memory: succeeds; oracle: error `cannot create temporary relation in non-temporary schema`.
- `CREATE TEMP TABLE ... ON COMMIT DELETE ROWS`
  — memory: rows survive COMMIT (count 2); oracle: rows cleared at commit (count 0).
- `CREATE TEMP TABLE ... ON COMMIT DROP`
  — memory: table survives COMMIT; oracle: table dropped at commit (later select fails 42P01).
- Test-harness note: the PGlite oracle session is shared and its reset keeps `pg_temp%` schemas, so temp-table contract tests must use unique table names and drop what they create.

## update-from

- `UPDATE t SET id = s.missing FROM s WHERE t.id = s.id`
  — memory: error message quotes the qualified name (`column "s.missing" does not exist`); oracle: `column s.missing does not exist` (unquoted). Same SQLSTATE 42703; message tier-B mismatch.
- `UPDATE t AS x SET id = t.id + 1` (referencing original name after aliasing)
  — memory: 42703 `column "t.id" does not exist`; oracle: 42P01 `invalid reference to FROM-clause entry for table "t"`.
