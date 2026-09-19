# PostgreSQL 18 Compatibility Audit

```text
PostgreSQL 18 Compatibility Audit
=================================

Reference PostgreSQL version:
  PGlite (@electric-sql/pglite) — real PostgreSQL 18.3 compiled to WASM,
  in-process, no Docker. server_version pinned in
  tests/harness/oracle-versions.ts and asserted by the gate.

postgres-mem version:
  0.0.0-development (package.json; publish via semantic-release)

Scope:
  Every oracle-exposed SQL construct is in-scope except NOT APPLICABLE
  (roles/auth enforcement, replication, wire protocol, storage internals,
  PL/pgSQL, extensions). The gate fails closed on silence.

PostgreSQL requirements reviewed:
  183 SQL commands (from the PostgreSQL 18 SQL-commands documentation
  index → compat/requirements.json)

Requirements classification:
  NOT APPLICABLE:  56
  SQL_BEHAVIOR:    127
  unknown:         0 (gate fails if non-zero)

Coverage statuses (SQL_BEHAVIOR):
  VERIFIED: 43 / PARTIALLY_VERIFIED: 26 / UNSUPPORTED: 58 (fail-loud,
  registered) — see `bun run requirements` / compat/coverage.json

Oracle builtin inventory:
  pg_catalog functions exposed by oracle: 2787
  implemented in engine registries:        302
  registered unsupported (with reasons):  2485
  silently missing:                          0 (gate fails otherwise)
  pg_catalog operators exposed by oracle:   74
  implemented:                              41
  registered unsupported:                   33

Construct catalog:
  945 scenarios across 33 sections (compat/scenarios.ts), all promoted
  to executing catalog tests; smoke baseline EMPTY (0 trivial stubs).

SQL grammar / operators / expressions:
  VERIFIED — contracts + generated operator matrices from pg_operator

Types / casts / NULL:
  VERIFIED — bool/int2/4/8, float4/8, numeric (in-repo arbitrary
  precision), text/varchar/char, bytea, uuid, date/time/timestamp[tz],
  interval, json/jsonb, arrays; cast matrices generated from pg_cast;
  3VL through operators/aggregates/DISTINCT

Functions (oracle surface):
  VERIFIED for the implemented 302; every other oracle builtin is an
  explicit register entry (never silent)

JSON / JSONB:
  VERIFIED — operator + function surface, jsonpath subset

Aggregates / windows:
  VERIFIED — FILTER, ORDER BY in aggregates, string_agg/array_agg/
  jsonb_agg, full frame specs incl. GROUPS/RANGE + EXCLUDE

CTEs / transactions / savepoints / constraints / FK:
  VERIFIED — recursive + data-modifying CTEs; FK actions (CASCADE/SET
  NULL/SET DEFAULT/RESTRICT/NO ACTION); DEFERRABLE parsed, checked at
  statement end (commit-time deferral is a documented gap)

Schemas / search_path / catalogs:
  VERIFIED — pg_catalog + information_schema commonly-queried subset

Sequences / serial / identity / enums / domains / generated columns:
  VERIFIED

Triggers / LANGUAGE sql / plpgsql-lite functions:
  PARTIALLY VERIFIED — row-level triggers fire in creation order
  (PostgreSQL: name order), UPDATE OF ignored, INSTEAD OF unsupported —
  all pinned divergences. plpgsql-lite UDFs: DECLARE, EXCEPTION WHEN
  others, CASE, FOR-IN-SELECT, RETURN NEXT.

Text search:
  PARTIALLY VERIFIED — tsvector/tsquery/@@/ts_rank with simple-style
  config; no ispell/synonym dictionaries

COPY / PREPARE / EXECUTE / SET / SHOW:
  VERIFIED — text + csv COPY via copyFrom API hook; GUC subset

Collation:
  Pinned C semantics; locale/ICU out of scope (documented)

Snapshots / determinism:
  VERIFIED — PGMM logical round-trip, byte-identical snapshots, PRNG
  rollback with transactions, fixed clock, post-restore lockstep

Differential tests (2026-08-21 initial audit):
  Total: 3400 under `bun test` / `bun run test:postgres-compat`
    (contract + fuzz + harness; Bun 1.4.0, PGlite/PostgreSQL 18.3)
  Passed: 3400
  Failed: 0
  expect() calls: 8968
  Files: 273 (246 contract)

Stateful / fuzz:
  Seeds: 0x5a17e0e1 (+ POSTGRES_MEM_FUZZ_SEED override, PATH replay)
  Differential grammar fuzz, per-area fuzz (17 areas), TLP + NoREC
  metamorphic, stateful DST with minimizer/repro, mixed-stateful,
  robustness (PostgresError-only), corpus regressions
  Mismatches: 0

Harness integrity:
  PGlite adapter compares rows (canonical text), column names/types,
  SQLSTATE class + normalized messages, rowCount/command tags, and
  logical state dumps after write sequences. Comparator meta-tests:
  tests/harness/*.test.ts. Canaries: 6 deliberate sabotages, each
  caught by the suite (bun run canaries). Skip register: empty.

Engine bugs found & fixed by the differential/fuzz process (this build):
  1. sum() crashed on certain inputs surfaced by grammar fuzz
  2. min()/max() returned unnormalized numeric cells
  3. NULL IN (empty subquery) returned NULL instead of false
  4. FULL JOIN did not enforce the join condition on one side
  (regression tests added under tests/contract/*; area corpus scripts
  replayed by tests/fuzz/corpus.test.ts)

Remaining known differences / intentional:
  Custom PGMM snapshots; deterministic random()/now() by default
  ({ random: "os" } / { now: "system" } match PostgreSQL entropy and
  wall clock); sync single-session API; COPY payloads via copyFrom;
  no 25P02 aborted-transaction state; trigger creation-order firing;
  UPDATE OF ignored; no INSTEAD OF triggers; round(float8) ties away
  from zero; '1e400'::float8 saturates; DROP CASCADE retains dependent
  views; COMMENT ON not stored; version() banner; pg_get_viewdef
  missing; EXPLAIN stubs. Machine-readable: compat/divergences.json
  (18 entries, each pinned).

Final assessment:
  Verified against PostgreSQL 18.3 (PGlite on Bun 1.4.0). Oracle
  function/operator inventory is closed (0 silently missing).
  Requirements matrix ingested with zero unknown statuses. Gate:
  `bun run test:postgres-compat`. Triggers, text search, collation,
  numeric extremes, and catalog long tail remain PARTIALLY VERIFIED
  honestly — not “fully compatible because green.”
```

Verification commands:

```bash
bun run test:postgres-compat
bun run inventory
bun run requirements
bun run scenarios
bun run canaries
bun run typecheck
```
