# Proof status — drop-in evidence

**As of:** 2026-08-21 (initial full build: engine + contract suite + fuzz + fail-closed gate). Full argument lives in [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) and [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

## What is proven now

| Mechanism | Evidence |
| --- | --- |
| Differential SQL vs PGlite (Postgres 18.3) | `bun run test:postgres-compat` |
| Differential SQL vs native PostgreSQL 18.3 | `bun run test:postgres-native` (embedded-postgres, or `POSTGRES_MEM_ORACLE_URL`) |
| Contract areas (66 directories, 246 files) | `tests/contract/` — types, casts, numeric, arrays, jsonb, joins, lateral, distinct-on, grouping, window-functions, cte, recursive-cte, returning, on-conflict, sequences, schemas, search-path, catalogs, text-search, domains, triggers, date-time, intervals, errors, transactions, savepoints, determinism, snapshots, api, parameters, copy, prepare-execute, … |
| Construct catalog (945 scenarios, 0 smoke stubs) | `bun run scenarios` → `compat/scenarios.ts` + `tests/contract/catalog/` |
| Oracle builtin inventory closed | `bun run inventory` — 301 implemented functions + 41 operators; all 2486 + 33 remaining oracle items explicitly registered in `compat/unsupported-register.json` |
| PostgreSQL 18 SQL-commands requirements matrix | `bun run requirements` — 183 commands, 0 unknown statuses |
| Generated operator/cast matrices from oracle | `tests/contract/matrices/` |
| Grammar-based differential fuzz | `tests/fuzz/differential.test.ts` + per-area fuzz (joins/subqueries/datetime/strings/windows/json-arrays/typing-binds/upsert/aggregates/cte/constraints/foreign-keys/sequences-counters/transactions/dml/expressions/combinations) |
| TLP / NoREC metamorphic | `tests/fuzz/metamorphic/` |
| Stateful DST with minimize/repro | `tests/fuzz/dst/` + `stateful.test.ts` + `mixed-stateful.test.ts` (dump-after-each) |
| Robustness (PostgresError-only, no hangs) | `tests/fuzz/robustness.test.ts` |
| Corpus regressions (bugs found by fuzzing) | `tests/corpus/regressions/` + `tests/fuzz/corpus.test.ts` |
| Determinism invariants (seed, clock, PRNG rollback, byte-identical snapshots) | `tests/contract/determinism/`, `tests/contract/snapshots/` |
| Canaries (suite can fail) | `bun run canaries` — 6 sabotages, each caught |
| Skip register | `scripts/check-skip-register.ts` (wired into `test:postgres-compat`) |
| Divergences doc | Auto-generated [DIVERGENCES.md](../DIVERGENCES.md) from 18 pinned entries |
| Browser SQL smoke | `bun run test:browser-sql` (recorded PGlite fixtures vs in-browser engine) |
| Harness comparator meta-tests | `tests/harness/*.test.ts` |

## What is NOT proven (blockers for broader drop-in claims)

- Wire protocol / async client (`pg`, `postgres.js`) API compatibility — no adapters exist
- `pg_dump` archive restore (plain-SQL subset only)
- PL/pgSQL, extensions, MERGE, cursors, LISTEN/NOTIFY — fail loud, UNSUPPORTED
- Multi-session MVCC / isolation levels / aborted-transaction (`25P02`) state
- Locale/ICU collation ordering (pinned to `C` semantics)
- ORM upstream test suites (Prisma/Drizzle/Kysely) — introspection queries work in style tests only
- Full-precision `numeric` transcendentals at extreme scales (exp/ln/power edges are PARTIALLY VERIFIED)

Honest product claim: **SQL dialect drop-in** for the native sync API — **not** a swap-in for `pg` / `postgres.js` / PGlite client APIs.
