# Query/DML fuzz-suite divergences (postgres-mem vs PGlite oracle)

Divergences found while authoring the differential property tests in `tests/fuzz/` for the
query/DML surface (dml, upsert, constraints, foreign-keys, joins, aggregates, subqueries,
windows, cte, transactions, sequences-counters). Each entry records the SQL, the memory
result, and the oracle (Postgres 18.3 via PGlite) result. The fuzz generators are
constrained to avoid these shapes; fix centrally in the engine, then relax the generators.

## New divergences found by the fuzz suite

> **All four entries below are FIXED in the engine** (select.ts: per-group aggregate type
> reconciliation + FULL JOIN condition check; eval.ts: IN over empty sets) and pinned as
> differential regressions in `tests/contract/aggregates/empty-groups.test.ts`. The entries
> are kept for the record; the generator constraints noted inline have been relaxed where
> mechanical.

### FULL JOIN with a non-equality predicate is not rejected (FIXED)

- SQL: `SELECT ... FROM l FULL JOIN r ON l.x <> r.x ORDER BY ...`
- memory: ok (executes the join)
- oracle: error 0A000 `FULL JOIN is only supported with merge-joinable or hash-joinable join conditions`
- Constraint: `tests/fuzz/joins.test.ts` forces `=` as the join predicate whenever the join type is FULL.

### sum() over an empty input set crashes (internal numeric error) (FIXED)

- SQL: `SELECT g, sum(v) FILTER (WHERE v > 0) AS x FROM gt GROUP BY g ORDER BY g` over rows `(0, NULL), (1, 20)`
  — memory: error (no SQLSTATE) `undefined is not an object (evaluating '(neg ? -v.coef : v.coef).toString')`;
  oracle: ok, `x` is NULL for the empty-filter group and `20` otherwise.
- Same crash for a correlated scalar subquery whose correlated set is empty:
  `SELECT t.id, (SELECT sum(s.a) FROM s WHERE s.g = t.g) AS m FROM t ORDER BY t.id` where some `t.g`
  matches no `s` row — memory: same internal error; oracle: ok (NULL for those rows).
- Note: `SELECT sum(a) FROM s WHERE false` (no GROUP BY, top level) does NOT crash — the trigger is a
  per-group / per-subquery-invocation empty input set.
- Constraint: `tests/fuzz/aggregates.test.ts` uses FILTER only on `count`; `tests/fuzz/subqueries.test.ts`
  uses only `count(*)` in correlated scalar subqueries.

### min/max produce unnormalized (raw JS number) cells in some shapes (FIXED)

- SQL: `SELECT g, min(v) FILTER (WHERE v > 0) AS x FROM gt GROUP BY g ORDER BY g` over rows `(0, NULL), (1, 20)`
  — memory: values `[["0", null], ["1", 20]]` (raw number `20`, not text); oracle: `[["0", null], ["1", "20"]]`.
  Same for `max(v) FILTER (...)`.
- SQL: `SELECT t.id, (SELECT min(s.a) FROM s WHERE s.g = t.g) AS m FROM t ORDER BY t.id` where `s`
  contains a row with a NULL `a` — memory: raw number cells (e.g. `5`); oracle: text `"5"`.
  (With no NULL `a` rows in `s`, the same query renders text correctly.)
- Constraint: same generator restrictions as the sum() crash above.

### NULL IN / NOT IN an empty subquery returns NULL instead of false/true (FIXED)

- SQL: `SELECT NULL::int IN (SELECT a FROM s WHERE false) AS v` — memory: NULL; oracle: `f`.
- SQL: `SELECT NULL::int NOT IN (SELECT a FROM s WHERE false) AS v` — memory: NULL; oracle: `t`.
  (An empty set makes `IN` false regardless of the needle; memory short-circuits on the NULL needle first.)
- Only visible when the result is selected as a value, or via `NOT IN` in WHERE (oracle keeps the row,
  memory drops it). Constraint: `tests/fuzz/subqueries.test.ts` skips value-position IN/NOT IN with a NULL
  needle over a possibly-empty subquery, and skips `NOT IN (SELECT ...)` in WHERE when the subquery is empty.

## Known divergences steered around (recorded elsewhere, listed here for generator rationale)

- Multi-row INSERT/UPDATE statement atomicity differs (memory leaves earlier rows behind on a
  mid-statement failure; `tests/contract/_reports/dml-ddl.md`) — `constraints.test.ts` and every other
  fuzz file generate only single-row DML wherever a statement could fail mid-way. Multi-row UPDATE/DELETE
  in `dml.test.ts` touch only unconstrained columns so they cannot fail.
- No aborted-transaction state (`tests/contract/_reports/session-system.md`) — `transactions.test.ts`
  generates only statements that cannot fail inside a transaction.
- ROLLBACK TO the same savepoint twice diverges — `transactions.test.ts` forgets a savepoint after one
  rollback and never reuses names.
- ON DELETE RESTRICT raises SQLSTATE 23001 in the oracle vs 23503 in memory — `foreign-keys.test.ts`
  uses only NO ACTION, CASCADE, and SET NULL.
- Data-modifying CTE snapshot semantics (outer read of the modified table sees the CTE's writes;
  `tests/contract/_reports/query-surface.md`) — `cte.test.ts` reads only from the CTE's RETURNING output
  inside the same statement.
- RETURNING output is only surfaced through the adapters' `query()` (the memory adapter's `exec()` drops
  rows), and multi-row RETURNING row order is not guaranteed to match — the fuzz files attach RETURNING
  only to statements that affect at most one row.
