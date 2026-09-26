# Proof status — drop-in evidence

**As of:** 2026-08-21 (core SQL dialect proof wave — affinity matrix, statement ABORT, OR-grid, FK MATCH, area fuzz). Full argument lives in [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) and [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

## What is proven now

| Mechanism | Evidence |
| --- | --- |
| Differential SQL vs `bun:sqlite` | `bun run test:sqlite-compat` |
| `sqlite_master.sql` text | Stored + normalized; dump compares `sql:…`; `tests/contract/schema/master-sql.test.ts` |
| `?NNN` binds | `tests/contract/parameters/numbered.test.ts` |
| `NOT IN (SELECT)` NULL trap | `tests/contract/null/not-in-select.test.ts` |
| Multi-statement `exec` counters | same file + `api/freeze.test.ts` |
| Bind rejection matrix | `tests/contract/parameters/bind-rejection.test.ts` |
| Error depth (CHECK UPDATE, generated, MATCH) | `tests/contract/errors/depth.test.ts` |
| Scalar / empty IN subquery edges | `tests/contract/subqueries/edges.test.ts` |
| UPSERT / UPDATE FROM / windows / JSON / date / collate / FK+trigger | `tests/contract/*/thin-gaps` + related |
| Affinity combinatorial (INSERT/CAST/UNION/INSERT SELECT) | `tests/contract/types/affinity-matrix.test.ts` + fuzz `affinity-dml.test.ts` |
| Statement ABORT / OR-mode × constraint grid | `tests/contract/conflicts/statement-atomicity.test.ts`, `or-constraint-grid.test.ts` + fuzz `conflicts.test.ts` |
| FK MATCH SIMPLE/FULL (oracle = SIMPLE semantics) | `tests/contract/foreign-keys/match.test.ts` + fuzz FK MATCH |
| Views with `WITH` + reject view DML without INSTEAD OF | `tests/contract/views/with.test.ts` |
| Invalid date/time edges | `tests/contract/date-time/invalid.test.ts` |
| Index / generated UNIQUE fuzz | `tests/fuzz/indexes.test.ts`, deepened `generated.test.ts` |
| Mixed DDL+DML+txn+PRAGMA+UPSERT+FK+trigger/RETURNING/ATTACH DST | `tests/fuzz/dst/` + `mixed-stateful.test.ts` |
| Dump-after-each DML (O3) | `tests/fuzz/stateful.test.ts` |
| TLP / NoREC metamorphic (incl. join TLP) | `tests/fuzz/metamorphic/` |
| Robustness (SqliteError-only, timeout, SQLM bit-flip) | `tests/fuzz/robustness.test.ts` |
| SQLLogicTest vendor corpus | `vendor/sqllogictest/` + `tests/fuzz/sqllogictest.test.ts` |
| Area fuzz (joins/subqueries/datetime/LIKE/windows/json/binds/triggers/generated/FK/counters/indexes/conflicts/affinity-dml) | `tests/fuzz/*.test.ts` |
| Smoke baseline emptied | `compat/smoke-baseline.json` (`ids: []`) — former smoke IDs promoted |
| Affinity / bind / malformed fuzz + determinism properties | `tests/fuzz/affinity-binds.test.ts` |
| Canaries (suite can fail) | `bun run test:canaries` |
| Skip register | `bun run scripts/check-skip-register.ts` (wired into `test:sqlite-compat`) |
| Browser SQL smoke | `bun run test:browser-sql` (12 fixtures vs recorded oracle) |
| Purity gate | `verify-package` bans WASM / `eval` / `new Function` / SAB / Atomics |
| Divergences doc | Auto-generated [DIVERGENCES.md](../DIVERGENCES.md) |
| Nightly multi-seed soak | `.github/workflows/fuzz-soak.yml` + `bun run test:fuzz:soak` |
| Corpus regressions (FK SET DEFAULT, NATURAL FULL, …) | `tests/corpus/regressions/` + `tests/fuzz/corpus.test.ts` |

## What is NOT proven (still blockers for WASM / API drop-in)

- On-disk `.sqlite` read/write (§35)
- JS UDFs / custom collations (§34)
- Adapter exports + upstream suites (§54)
- Full contract suite in all browsers / workers (§49) — smoke only
- Full upstream `sqllogictest` tree (trimmed vendor subset only); Stryker mutation score; grammar production coverage metrics
- Sync-engine E2E (§56)
- Fault-injection atomicity (§43); multi-oracle matrix (§45)

Honest product claim: **SQL dialect drop-in** for the native sync API — **not** a swap-in for `sql.js` / `sqlite-wasm`.
