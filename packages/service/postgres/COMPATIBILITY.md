# Compatibility

Goal: **PostgreSQL 18 SQL dialect behavioral parity** as a drop-in for the same statements against the reference oracle. Compatibility is proven by the differential contract suite and the fail-closed gate:

```bash
bun run test:postgres-compat
```

See [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the latest evidence-based audit report.

Reference oracle: **PostgreSQL 18.3** via PGlite (`@electric-sql/pglite`, real Postgres compiled to WASM, in-process). Inventory: `bun run inventory`. Construct catalog: `bun run scenarios` → [`compat/scenarios.ts`](compat/scenarios.ts). Divergences: [`compat/divergences.json`](compat/divergences.json). Requirements matrix: `bun run requirements` → `compat/requirements.json` + `compat/coverage.json`.

## Proof surface

Differential tests compare a **tuple** per statement: rows (normalized to canonical PostgreSQL text where typed), column names and type names where requested, error SQLSTATE class + normalized message, command tag / `rowCount`, and transaction status, plus a **logical state dump** (catalog names, column definitions, row payloads, sequence values) after write sequences.

A catalog ID appearing in a test file is **not** proof by itself. Trivial probes are tracked in [`compat/smoke-baseline.json`](compat/smoke-baseline.json) and ratcheted downward (currently **0 smoke stubs** across 945 catalog scenarios). Generated operator/cast matrices live under [`tests/contract/matrices/`](tests/contract/matrices/). Observed mem≠oracle diffs must bind to a `compat/divergences.json` entry or be a **FAILURE** — unexplained diffs are not allowed.

Intentional differences are finite and machine-readable in `compat/divergences.json` (PGMM snapshots, seeded `random()`/`now()`, sync single-session API, no aborted-transaction state, EXPLAIN stubs, trigger-order/`UPDATE OF` edges, float8 rounding/overflow edges, …). Human-readable: [DIVERGENCES.md](DIVERGENCES.md).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Differential contracts (+ fuzz where applicable) cover happy path **and** meaningful edges vs oracle |
| **PARTIALLY VERIFIED** | Implemented; coverage thin or known edges remain |
| **UNSUPPORTED** | Missing from SQL surface (must fail loud; gate fails if oracle-exposed and unregistered) |
| **NOT APPLICABLE** | Outside the in-memory single-session dialect surface (roles/auth, replication, storage, wire protocol) |

## Scope bound

Anything a PostgreSQL application can invoke through SQL against the PGlite **18.3** oracle must match observable behavior, except:

1. **Snapshot format** — custom binary codec (`PGMM`), not `pg_dump` / on-disk clusters (logical state still round-trips).
2. **Deterministic `random()` / `now()`** — seeded PRNG and fixed clock by default (injectable).
3. **Single session** — no MVCC across connections, no isolation levels beyond one session, no `25P02` aborted-transaction state (documented divergence).
4. **NOT APPLICABLE** rows in `compat/coverage.json` (roles, replication, VACUUM internals, LISTEN/NOTIFY, cursors, full PL/pgSQL, extensions).

The oracle exposes **2787 builtin functions** and **74 operators** in `pg_catalog`; postgres-mem implements **302 functions** and **41 operators**, and every remaining item is an explicit entry in [`compat/unsupported-register.json`](compat/unsupported-register.json) with a reason (trigger/internal plumbing, admin/monitoring, unsupported type families, …). The gate fails closed on silence.

## Requirements coverage (PostgreSQL 18 SQL commands)

`bun run requirements` ingests the PostgreSQL 18 SQL-commands documentation index: **183 commands** → 56 NOT APPLICABLE, 127 SQL-behavior. Of the SQL-behavior commands: **43 VERIFIED**, **26 PARTIALLY VERIFIED**, **58 UNSUPPORTED** (fail-loud, registered). Full detail: `compat/coverage.json`.

## Feature matrix (summary)

| Area | Status | Notes |
| --- | --- | --- |
| Core DML / SELECT / joins / CTE / ON CONFLICT / RETURNING | VERIFIED | Contract + fuzz |
| Types: bool/int2/4/8, float4/8, numeric, text/varchar/char, bytea, uuid | VERIFIED | numeric is in-repo arbitrary precision |
| Date/time: date, time, timestamp[tz], interval + arithmetic | VERIFIED | Timezone conversions for named zones; some interval corners partial |
| Casts (implicit/assignment/explicit) | VERIFIED | Generated cast matrices from oracle |
| Arrays + unnest + subscripts/slices | VERIFIED | |
| JSON / JSONB operators + functions | VERIFIED | |
| Window functions (frames, EXCLUDE) | VERIFIED | |
| GROUPING SETS / ROLLUP / CUBE, DISTINCT ON, LATERAL, set ops | VERIFIED | |
| Recursive + data-modifying CTEs | VERIFIED | |
| Constraints: PK / UNIQUE / NOT NULL / CHECK / FK actions | VERIFIED | DEFERRABLE parsed, checked at statement end |
| Sequences / serial / identity | VERIFIED | |
| Schemas + search_path + pg_catalog / information_schema | VERIFIED | Catalog columns are the commonly-queried subset |
| Enums, domains, generated columns | VERIFIED | |
| Triggers (row-level, LANGUAGE sql-expressible) | PARTIALLY VERIFIED | Creation-order firing, `UPDATE OF` ignored, no INSTEAD OF (documented) |
| CREATE FUNCTION LANGUAGE sql / plpgsql-lite | PARTIALLY VERIFIED | Scalar + set-returning; plpgsql subset: DECLARE, EXCEPTION WHEN others, CASE, FOR-IN-SELECT, RETURN NEXT |
| Text search (tsvector / tsquery / @@ / ts_rank) | PARTIALLY VERIFIED | `simple`-style config; no ispell/synonym dictionaries |
| COPY FROM/TO (text, csv) | VERIFIED | Via `copyFrom` API hook / rows out |
| PREPARE / EXECUTE / DEALLOCATE, SET / SHOW / RESET | VERIFIED | GUC subset |
| Transactions / savepoints | VERIFIED | No `25P02` aborted state (documented divergence) |
| Collation / ordering | PARTIALLY VERIFIED | `C` semantics pinned; locale/ICU out of scope |
| Regex (`~`, `~*`, POSIX functions) | PARTIALLY VERIFIED | JS regex flavor mapped to POSIX ERE; documented edges |
| EXPLAIN | PARTIALLY VERIFIED | Stub plan shapes |
| MERGE / CALL / cursors / LISTEN / full PL/pgSQL | UNSUPPORTED | Fail loud `0A000`, registered |
| Roles / GRANT / VACUUM / ANALYZE / LOCK | NOT APPLICABLE | Parsed no-ops where harmless |
| Wire protocol / multi-session MVCC / on-disk format | NOT APPLICABLE | |

## How to verify

```bash
bun run test:postgres-compat # requirements + gate + contract/fuzz/harness
bun run inventory            # oracle pg_proc/pg_operator inventory
bun run requirements         # refresh PostgreSQL 18 requirements + coverage
bun run scenarios            # catalog + smoke ratchet
bun run build                # ESM browser build
```

Do not treat isolated unit tests of internal modules as proof of PostgreSQL compatibility. The differential suite is authoritative for SQL behavior; `test:postgres-compat` is the release gate.

**Parity claim:** Verified against **PostgreSQL 18.3** (PGlite). Features marked **VERIFIED** are oracle-proven. **PARTIALLY VERIFIED** rows must not be marketed as complete. **NOT APPLICABLE** is the only allowed permanent omission from the SQL drop-in claim.
