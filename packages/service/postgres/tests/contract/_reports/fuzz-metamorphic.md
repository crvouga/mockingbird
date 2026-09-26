# Metamorphic fuzz divergences (TLP / NoREC / combinations / corpus)

New divergences found by `tests/fuzz/metamorphic/`, `tests/fuzz/combinations.test.ts`, and
`tests/fuzz/corpus.test.ts`. Each entry: the SQL, the memory result, the oracle result.

## Divergences found

None so far. All suites pass at the default seed (0x5a17e0e1) and at 100 runs per property
(`POSTGRES_MEM_FUZZ_RUNS=100`).

## Generator constraints applied up-front (known divergences, not re-reported here)

These were excluded from generation based on the existing `_reports/*.md` findings, so the fuzzers
do not rediscover them:

- No unknown-literal concatenation (`'a' || 1`); generated concat is text-only or cast explicitly.
- No `DISTINCT ON` in combinations (ordering-enforcement divergence).
- No row-wise `IN` subqueries (`(a, b) IN (SELECT ...)`).
- Predicates are always proper booleans — never `WHERE <int>`.
- Multi-row DML only where it cannot fail (statement-atomicity divergence on failing multi-row DML).
- No statements after a failed statement inside an open transaction (aborted-transaction state).
- No `ROLLBACK TO` savepoint reuse in the corpus scripts.
- No `random()` / `now()` / `current_*` anywhere.
- Set-operation branches are always the same query (identical column types), avoiding the
  unknown-literal / bare-NULL UNION type-resolution divergences.
- Text ORDER BY keys in combinations come from a fixed ASCII pool; row order is always anchored by
  a unique key so collation subtleties cannot flip row order.
