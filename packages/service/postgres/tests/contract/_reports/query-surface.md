# Query-surface divergences (memory engine vs PGlite oracle)

Cases removed from the contract suites because the in-memory engine diverges from the
Postgres 18 oracle. One bullet per removed case: SQL, memory result, oracle result.
These are to be fixed centrally in the engine, then re-added as contract tests.

## select

- `SELECT 'n=' || 42 AS v` — memory: error `invalid input syntax for type integer: "n="` (tries to
  coerce the unknown literal to the integer operand's type); oracle: ok, returns `n=42`.
- `SELECT id FROM t WHERE nope = 1` / `SELECT nope FROM t` on an **empty** table — memory: ok, zero
  rows (column references are only validated when rows exist); oracle: error 42703
  `column "nope" does not exist`. (Kept the populated-table variants, which pass.)
- `SELECT * FROM (SELECT id FROM t)` — memory: ok (alias optional); oracle: error 42601
  `subquery in FROM must have an alias`.
- `SELECT id FROM t WHERE 1` (t populated) — memory: ok (coerces int to boolean); oracle: error
  42804 `argument of WHERE must be type boolean, not type integer`.

## joins

- `SELECT * FROM a JOIN b ON zz.id = b.id` (unknown table alias in ON) — memory: error 42703
  `column "zz.id" does not exist`; oracle: error 42P01 `missing FROM-clause entry for table "zz"`
  (category mismatch: undefined_column vs undefined_table).

## lateral

- `SELECT c.name, s.total FROM customers c, LATERAL (SELECT coalesce(sum(amount), 0) AS total FROM orders WHERE customer_id = c.id) s ORDER BY c.name`
  — memory: returns `[object Object]` for the customer with no orders (unnormalized cell from
  `coalesce(sum(...), 0)` over an empty correlated set); oracle: ok, returns `0`.
- `SELECT * FROM t, (SELECT t.n + 1 AS m) s` (non-LATERAL subquery referencing a sibling) — memory:
  error 42703 `column "t.n" does not exist`; oracle: error 42P01 `invalid reference to FROM-clause
  entry for table "t"` (category mismatch: undefined_column vs undefined_table).

## subqueries

- `SELECT id FROM t WHERE (id, v) = (SELECT id, v FROM t WHERE id = 2)` (row subquery comparison) —
  memory: error `subquery must return only one column`; oracle: ok, returns the id=2 row.
- `SELECT a, b FROM t WHERE (a, b) IN (SELECT a, b FROM s)` (row-wise IN subquery) — memory: error
  `subquery has too many columns`; oracle: ok.
- `SELECT * FROM (SELECT t.n FROM t) s1, t` (subquery referencing a later FROM item) — memory: ok
  (resolves the reference); oracle: error 42P01 `invalid reference to FROM-clause entry for table "t"`.

## unions

- `SELECT 1 AS v UNION SELECT true` — both fail 42804, but the messages diverge under tier-B
  compare: memory `UNION types int4 and bool cannot be matched` vs oracle `UNION types integer and
  boolean cannot be matched` (type-name spelling: `int4`/`bool` vs `integer`/`boolean`).
- `SELECT 1 AS v UNION ALL SELECT '2'` — memory: error `UNION types int4 and text cannot be matched`
  (treats the unknown literal as text); oracle: ok, resolves `'2'` against integer.
- `SELECT NULL AS v UNION ALL SELECT 5` — memory: error `UNION types text and int4 cannot be
  matched` (bare NULL defaults to text before matching); oracle: ok, NULL adopts integer.

## distinct-on

- `SELECT DISTINCT ON (a) a, b FROM t ORDER BY b`, `... ORDER BY b, a`, and
  `SELECT DISTINCT ON (a, b) a, b FROM t ORDER BY a` — memory: ok (does not enforce that DISTINCT ON
  expressions match the leftmost ORDER BY expressions); oracle: error 42P10
  `SELECT DISTINCT ON expressions must match initial ORDER BY expressions`.

## grouping

- Ungrouped-column errors (`SELECT a, b FROM t GROUP BY a`, `SELECT a, b + 1 FROM t GROUP BY a`,
  `... HAVING b > 1`, `... ORDER BY b`, `SELECT a, count(*) FROM t`) — both fail 42803, but memory
  says `column "b" must appear in the GROUP BY clause...` while the oracle qualifies the name:
  `column "t.b" must appear in the GROUP BY clause...` (message mismatch under tier-B compare).
- `SELECT a FROM t WHERE count(*) > 1 GROUP BY a` and `SELECT count(*) FROM t GROUP BY count(*)` —
  memory: error 42883 `function count() does not exist`; oracle: error 42803 `aggregate functions
  are not allowed in WHERE` / `... in GROUP BY` (category mismatch: undefined_function vs grouping).
- `SELECT sum(count(*)) FROM t GROUP BY a` (nested aggregates) — memory: error 42883 `function
  count() does not exist`; oracle: error 42803 `aggregate function calls cannot be nested`
  (category mismatch: undefined_function vs grouping).
- `SELECT GROUPING(a) FROM t` — both fail 42803, but memory says `GROUPING must appear in GROUP BY
  context` vs oracle `arguments to GROUPING must be grouping expressions of the associated query
  level` (message mismatch).

## ordering

- `SELECT a FROM t ORDER BY 'k', a` — memory: ok (sorts by the constant); oracle: error 42601
  `non-integer constant in ORDER BY`.
- `SELECT a FROM t ORDER BY -1` — memory: ok; oracle: error 42P10 `ORDER BY position -1 is not in
  select list`.

## window-functions

- `SELECT id, rank() OVER w2 AS r FROM t WINDOW w1 AS (PARTITION BY grp), w2 AS (w1 ORDER BY v) ORDER BY id`
  (named window referencing another window) — memory: wrong rank values (row 2 returned `3`;
  appears to ignore the inherited PARTITION BY from w1); oracle: `1` (rank restarts per partition).
- Window-function-in-wrong-context errors (`WHERE row_number() OVER (...) = 1`,
  `GROUP BY row_number() OVER (...)`, `HAVING rank() OVER (...) = 1`, and nested
  `rank() OVER (ORDER BY row_number() OVER (...))`) — both fail 42P20, but memory's message is the
  generic `window functions are not allowed in this context` while the oracle names the clause
  (`... not allowed in WHERE` / `GROUP BY` / `HAVING` / `window definitions`).

## cte

- `WITH upd AS (UPDATE t SET v = v + 1 RETURNING v) SELECT t.v AS original, upd.v AS updated FROM t, upd`
  — memory: `original` = 101 (outer SELECT sees the CTE's update); oracle: `original` = 100 (all
  parts of the statement see the same snapshot).
- `WITH s AS (SELECT 1 AS x), s AS (SELECT 2 AS y) SELECT * FROM s` — memory: ok (last definition
  wins); oracle: error 42712 `WITH query name "s" specified more than once`.

## recursive-cte

- `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT c.n + 1 FROM c RIGHT JOIN (SELECT 1 AS x) s ON true WHERE c.n < 3) SELECT * FROM c`
  — memory: ok; oracle: error 42P19 `recursive reference to query "c" must not appear within an
  outer join`.
- `WITH RECURSIVE a(n) AS (... FROM b ...), b(n) AS (... FROM a ...) SELECT * FROM a` (mutual
  recursion) — memory: error 42P01 `relation "b" does not exist`; oracle: error 0A000 `mutual
  recursion between WITH items is not implemented` (category mismatch: undefined_table vs
  unsupported).
- `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT x.n + y.n FROM c x, c y WHERE x.n < 3) SELECT * FROM c`
  — memory: ok; oracle: error 42P19 `recursive reference to query "c" must not appear more than once`.
- `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT sum(n)::int FROM c WHERE n < 3) SELECT * FROM c`
  — memory: spins for ~2 minutes before failing with 54000 `recursive query iteration limit
  exceeded`; oracle: fails fast with 42P19 `aggregate functions are not allowed in a recursive
  query's recursive term`. (Also a pathological-runtime hazard.)

## aggregates

- `SELECT min(f) AS mn, max(f) AS mx FROM s` (boolean column) — memory: ok; oracle: error 42883
  `function min(boolean) does not exist` (Postgres has no min/max over boolean).
- `SELECT no_such_agg(v) FROM t` — both fail 42883, but memory renders the argument type as `int4`
  vs oracle `integer` (message mismatch under tier-B compare).
- `SELECT sum(v) FROM s` (text column) — memory: error 22P02 `invalid input syntax for type
  numeric: "a"` (coerces text and tries to sum); oracle: error 42883 `function sum(text) does not
  exist` (category mismatch: invalid_text_representation vs undefined_function).
- `SELECT percentile_cont(1.5) WITHIN GROUP (ORDER BY v) FROM t` — memory: error 22023 `percentile
  value must be between 0 and 1`; oracle: error 22003 `percentile value 1.5 is not between 0 and 1`
  (sqlstate mismatch: invalid_parameter vs numeric_out_of_range).
- `SELECT stddev_pop(v) FROM s` with a single row — memory: `0.0000000000000000`; oracle: `0`
  (numeric scale/formatting of the zero result differs).
- `SELECT percentile_disc(0.25) WITHIN GROUP (ORDER BY v DESC) FROM t` (v = 10,20,30,40,50) —
  memory: `20` (ignores the DESC direction); oracle: `40`.

## table-valued

- `SELECT generate_series(1, 3) * 10 AS v` (SRF nested inside an expression in the select list) —
  memory: error 42883 `function generate_series(int4, int4) does not exist`; oracle: ok, expands to
  10/20/30.

## arrays

- `SELECT array_agg(a ORDER BY a) AS m FROM (VALUES (ARRAY[1, 2]), (ARRAY[3, 4])) v(a)` — memory:
  `{"{1,2}","{3,4}"}` (aggregates the arrays as quoted text elements); oracle: `{{1,2},{3,4}}`
  (builds a true two-dimensional array).
- `SELECT string_to_array('', ',')` — memory: `{""}` (one empty-string element); oracle: `{}`
  (empty array).
