# Compatibility

Goal: **full SQLite3 SQL dialect behavioral parity** as a drop-in for the same statements against the reference oracle. Compatibility is proven by the differential contract suite and the fail-closed gate:

```bash
bun run test:sqlite-compat
```

See [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the latest evidence-based audit report.

Reference oracle: **SQLite 3.51.0** (`bun:sqlite`; Linux/Windows bun may report **3.53.0** — see 𝔇 `oracle-platform-sqlite-version`). Inventory: `bun run inventory`. Construct catalog: `bun run scenarios` → [`compat/scenarios.ts`](compat/scenarios.ts). Divergences: [`compat/divergences.json`](compat/divergences.json). Requirements matrix: `bun run requirements` → `compat/requirements.json` + `compat/coverage.json`.

## Proof surface (Phase 1)

Differential tests compare a **B-tuple**: rows (plus `typeof` where requested), column names, error category / sqliteCode / message (Tier A exact or Tier B prefix-normalized), `changes`, `total_changes`, `lastInsertRowid`, and autocommit, plus a **logical Dump** (`sqlite_master` names, `table_info`, row payloads with per-column `typeof`, `sqlite_sequence`, selected pragmas).

A catalog ID appearing in a test file is **not** proof by itself. Cases whose SQL is `SELECT 1 AS v` are **smoke**; [`compat/smoke-baseline.json`](compat/smoke-baseline.json) ratchets that list downward. Generated matrices live under [`tests/contract/matrices/`](tests/contract/matrices/). Observed mem≠oracle diffs must be `known-divergence(id)` from 𝔇 or **FAILURE** — unexplained diffs are not allowed.

Intentional differences are finite and machine-readable in `compat/divergences.json` (SQLM snapshots, seeded `random()`/`now`, ATTACH empty schema, EXPLAIN stubs, INDEXED BY discarded, MATERIALIZED hint ignored, FTS shadow counters, compile_options/function_list, `-0`, JS API extras, snapshot exclusions).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Differential contracts (+ fuzz where applicable) cover happy path **and** meaningful edges vs oracle |
| **PARTIALLY VERIFIED** | Implemented; coverage thin or known edges remain |
| **UNSUPPORTED** | Missing from SQL surface (must fail loud; gate fails if oracle-exposed) |
| **NOT APPLICABLE** | Outside the in-memory dialect surface (C API, on-disk `.sqlite`, VFS/pager/WAL) |

## Scope 3 bound

Anything a SQLite application can invoke through SQL against this Bun/SQLite **3.51.0** build must match oracle observable behavior, except:

1. **Snapshot format** — custom binary codec (`SQLM`), not the on-disk SQLite database file format (logical state still round-trips).
2. **Deterministic `random()` / `'now'`** — seeded PRNG and fixed clock by default (injectable).
3. **NOT APPLICABLE** rows in `compat/coverage.json` (C API, VFS, pager, file locking, etc.).

Oracle builtins (math, string extras, uuid, ieee754, …) and modules (FTS3/4/5, RTREE, dbstat, bytecode, tables_used) are **in scope**.

## Feature matrix (summary)

| Area | Status | Notes |
| --- | --- | --- |
| Core DML / SELECT / joins / CTE / UPSERT / RETURNING | VERIFIED | Contract + fuzz |
| STRICT tables / indexes | VERIFIED | STRICT types; partial + expression indexes; leftmost prefix |
| Expressions / operators / `->` `->>` / row values | VERIFIED | Row-value + precedence contracts |
| Affinity / NULL / COLLATE | VERIFIED | Comparison affinity + collation on GROUP BY/JOIN |
| Constraints / FK / triggers / views / ATTACH | VERIFIED | Deferred FK, composite FK, INSTEAD OF, OR ROLLBACK/FAIL |
| Windows (incl. ntile/cume_dist/percent_rank) | VERIFIED | EXCLUDE; GROUPS/RANGE frames; window FILTER |
| JSON1 / JSONB / TVFs | VERIFIED | |
| Math / string / date extras / uuid / ieee754 | VERIFIED | Scope-3 inventory |
| FTS3 / FTS4 / FTS5 + MATCH | PARTIALLY VERIFIED | Differential FTS suite + fuzz vs 3.51.0; see FTS matrix below. Shadow-table change counters intentionally diverge. |

## FTS compatibility matrix

Reference: **SQLite 3.51.0** (`bun:sqlite`). Inventory: `bun run scripts/fts-oracle-surface.ts` → `compat/fts-oracle-surface.json`.

| Feature | Status |
| --- | --- |
| FTS3 | PARTIALLY VERIFIED |
| FTS4 | PARTIALLY VERIFIED |
| FTS5 | PARTIALLY VERIFIED |
| Virtual table creation (options/tokenizers) | VERIFIED |
| Tokenizers (unicode61/ascii/porter/trigram) | VERIFIED |
| MATCH grammar (AND/OR/NOT/phrase/prefix/NEAR/columns) | VERIFIED |
| Boolean operators | VERIFIED |
| Phrases | VERIFIED |
| Prefix queries | VERIFIED |
| NEAR | VERIFIED |
| Column filters | VERIFIED |
| Ranking / bm25 / rank | VERIFIED |
| highlight / snippet | VERIFIED |
| matchinfo / offsets (FTS3/4) | PARTIALLY VERIFIED | Default + common format strings verified; some FTS4-only formats thinner |
| Contentless tables | VERIFIED |
| External content | PARTIALLY VERIFIED | Canonical delete/sync covered; backfill/projection edges thinner |
| Content tables | VERIFIED |
| Triggers + FTS | PARTIALLY VERIFIED | Maintenance sequences covered; advanced edges thinner |
| Special commands (optimize/rebuild/integrity-check) | VERIFIED |
| Prefix indexes | VERIFIED |
| Unicode / adversarial corpus | VERIFIED |
| Transactions / savepoints | VERIFIED |
| Error behavior | VERIFIED |
| FTS differential fuzz | VERIFIED |
| FTS stateful fuzz | VERIFIED |
| RTREE / dbstat / bytecode / tables_used | VERIFIED | dbstat synthetic pages; bytecode empty cursor |
| ANALYZE / REINDEX / VACUUM | VERIFIED | `:memory:` observable parity |
| EXPLAIN / INDEXED BY | PARTIALLY VERIFIED | Stub shapes / no-ops (missing INDEXED BY errors documented) |
| Prepared stmt schema invalidation | VERIFIED | Re-prepare after ALTER/DROP; `tests/contract/api/schema-invalidation.test.ts` |
| On-disk file format / C API | NOT APPLICABLE | |

## How to verify

```bash
bun run test:sqlite-compat   # requirements + gate + contract/fuzz/harness
bun run inventory            # oracle function/module inventory
bun run requirements         # refresh SQLite.org requirements + coverage
bun run build && bun run verify-package  # ESM browser build + isomorphic pack gates
```

Do not treat isolated unit tests of internal modules as proof of SQLite compatibility. The differential matrix runner is authoritative for SQL behavior; `test:sqlite-compat` is the release gate.

**Parity claim:** Verified against **SQLite 3.51.0** (`bun:sqlite`). Features marked **VERIFIED** are oracle-proven. **PARTIALLY VERIFIED** rows must not be marketed as complete. **NOT APPLICABLE** is the only allowed permanent omission from the SQL drop-in claim.
