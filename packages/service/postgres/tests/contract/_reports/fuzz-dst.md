# Fuzz DST report — stateful / mixed-stateful / robustness

Ported from sqlite-mem's DST engine (`tests/fuzz/dst/`). Ops resolve against a `SimState`
so generated SQL is valid-by-construction; every statement / dump / final state is compared
differentially against the PGlite oracle.

## New divergences found

None. All divergences the generators are designed around were already documented in
`session-system.md` / `dml-ddl.md`.

## Generator constraints (designed around known divergences)

- **No failing statements inside `BEGIN`** — aborted-transaction state is not implemented
  (memory keeps executing; oracle returns 25P02). Row ids come from a monotonic `SimState`
  counter that never rolls back, so PK conflicts cannot happen; `update` / `delete` target
  only ids known to be visible (skipped when the table is empty).
- **Single-row DML only** — multi-row statements are not statement-atomic in memory.
- **Each savepoint is rolled back to at most once** — `ROLLBACK TO` the same savepoint twice
  fails to undo work in memory. `rollback_to` consumes (pops) the innermost savepoint; names
  are monotonic (`sp1`, `sp2`, …) and never reused within a run.
- **No `PREPARE`** — prepared statements do not survive `ROLLBACK` in memory.
- **No `random()` / `now()` / `current_*`** — nondeterministic across engines.
- **DDL (`ADD COLUMN`, `CREATE INDEX`, `DROP INDEX`) only outside transactions.**
- **Checkpoints (memory-only PGMM snapshot → `DELETE FROM t` → restore → full logical state
  compare) only outside transactions** — `restore()` throws 25P01 inside one.
- **Transaction-control and DDL statements are compared outcome-only**
  (`compareOutcomeOrReport`): memory reports `changes = 1` and an empty command tag for
  `BEGIN` / `SAVEPOINT` / `COMMIT` / `ALTER` / `CREATE INDEX` etc., while the oracle reports
  `changes = 0` with a proper tag. Row-returning and DML results are compared in full.
- **`select_scan` orders by all columns with `id` first**, so ordering is total and never
  depends on text collation; **`select_agg` aggregates numeric columns only**
  (`count(*)`, `count(a)`, `sum(a)`, `min/max(a)`, `min/max(c)`) — text `min/max` and
  `sum(float8)` are avoided (collation / float summation order).

## Robustness observations (memory-only)

- Token-salad SQL throws only `PostgresError` from `prepare` / `query` / `exec`.
- Random snapshot byte corruption (probed exhaustively over ~300 offsets during development)
  either restores cleanly or throws `PostgresError` — no `TypeError` / `RangeError` escapes.
- Parenthesis nesting to depth 1600 and identifiers of 10k chars parse or error cleanly
  (no stack overflow, no process crash); identifiers are not truncated to 63 bytes
  (memory-only observation, not oracle-compared here).
