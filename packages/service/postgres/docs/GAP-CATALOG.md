# Gap catalog — unproven / thin / intentional inventory

**As of:** 2026-08-21. Companion to [GAP-ANALYSIS.md](GAP-ANALYSIS.md) (ranked analysis) and [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) (claim definition). This file is the flat inventory: every known place where postgres-mem's behavior is unproven, thinly proven, or intentionally different.

Sources of truth this catalog summarizes:

- [`compat/divergences.json`](../compat/divergences.json) — 18 pinned intentional divergences
- [`compat/unsupported-register.json`](../compat/unsupported-register.json) — 2486 functions + 33 operators registered as unsupported with reasons
- [`compat/coverage.json`](../compat/coverage.json) — 183 SQL commands: 43 VERIFIED / 26 PARTIALLY VERIFIED / 58 UNSUPPORTED / 56 NOT APPLICABLE
- [`compat/smoke-baseline.json`](../compat/smoke-baseline.json) — smoke-stub ratchet (currently empty)

## 1. Intentional divergences (pinned, closed set)

See [DIVERGENCES.md](../DIVERGENCES.md) for the generated full list. Categories:

| Category | Entries |
| --- | --- |
| Runtime/API design | `deterministic-runtime`, `pgmm-snapshot-codec`, `sync-api-surface`, `copy-stdin-api`, `oracle-pglite-version` |
| Parser/eval edges | `empty-script-rejected`, `row-value-subquery-arity`, `unary-minus-folding` |
| float8 edges | `float8-overflow-saturates`, `round-half-away-from-zero` |
| DDL/catalog edges | `drop-cascade-view-retained`, `comment-on-not-stored`, `version-banner`, `pg-get-viewdef-missing` |
| Triggers | `trigger-order-creation`, `trigger-update-of-ignored`, `instead-of-triggers-unsupported` |
| Transactions | `no-aborted-transaction-state` |

Every entry has `pinnedBy` scenario IDs and/or test files. Adding a new intentional difference without a pin fails the gate.

## 2. UNSUPPORTED SQL commands (fail loud, registered)

58 of the 183 PostgreSQL 18 SQL commands are UNSUPPORTED (see `compat/coverage.json` for the exact list). Notable families:

- **Procedural:** `CREATE PROCEDURE`, `CALL`, `DO`
- **MERGE**
- **Cursors:** `DECLARE`, `FETCH`, `MOVE`, `CLOSE`
- **Async:** `LISTEN`, `NOTIFY`, `UNLISTEN`
- **Extensions/FDW:** `CREATE EXTENSION`, `CREATE FOREIGN TABLE`, `CREATE SERVER`, `IMPORT FOREIGN SCHEMA`, …
- **Partitioning:** `CREATE TABLE ... PARTITION BY` and partition maintenance
- **Storage/admin:** `CREATE TABLESPACE`, `ALTER SYSTEM`, `REFRESH MATERIALIZED VIEW CONCURRENTLY` edge forms

All fail loud with SQLSTATE `0A000` (or `42601` where the grammar is not parsed). None fail silently.

## 3. NOT APPLICABLE (56 commands)

Roles/privileges as enforcement (`CREATE ROLE`, `GRANT`, …), replication (`CREATE PUBLICATION/SUBSCRIPTION`), maintenance internals (`VACUUM`, `CLUSTER`, `CHECKPOINT`, `REINDEX` — parsed no-ops where harmless), and wire-protocol-session commands. These are outside the single-session in-memory dialect claim by definition.

## 4. PARTIALLY VERIFIED areas (implemented; thin edges)

| Area | Thin edge |
| --- | --- |
| `numeric` transcendentals | exp/ln/power/sqrt at extreme precision/scale; contract coverage is common ranges |
| Intervals / timezones | DST transition arithmetic for named zones; interval normalization corners (`justify_*` interactions) |
| Regex | POSIX ERE via mapped JS regex; bracket-expression/locale classes |
| Triggers | Name-order firing, `UPDATE OF`, INSTEAD OF (pinned divergences — candidates for real fixes) |
| `LANGUAGE sql` functions | Polymorphic args, VARIADIC, overload resolution beyond exact-arity |
| Text search | `simple`-style dictionary only; no ispell/synonym/thesaurus; `ts_headline` thin |
| `pg_catalog` / `information_schema` | Commonly-queried columns/relations only; long tail returns absent-column errors |
| GUCs | Common settings; long tail defaults/errors |
| DEFERRABLE constraints | Checked at statement end, not commit time |
| EXPLAIN | Stub shapes |
| Collation | `C` semantics only |

## 5. Unsupported oracle builtins (registered families)

`compat/unsupported-register.json` groups the 2486 unregistered-in-engine oracle functions by reason. Largest families:

- Internal/trigger plumbing (`*_in`, `*_out`, `*_recv`, `*_send`, I/O and support functions)
- Admin/monitoring (`pg_stat_*`, `pg_ls_*`, `pg_*_size`, backup/replication helpers)
- Unsupported type families (geometric, network `inet`/`cidr` operators beyond text, `money`, range types, multirange, xml)
- Access-method / planner support functions
- Full-text dictionaries/config management beyond the simple pipeline

An engine change that implements any registered item must remove it from the register (the inventory gate cross-checks both directions).

## 6. Proof-infrastructure gaps

| Gap | Status |
| --- | --- |
| Mutation testing / branch-coverage thresholds | absent |
| Second oracle (native postgres server) | **wired** — `bun run test:postgres-native` / `PostgresServerAdapter` |
| Full differential suite in real browsers | absent — smoke fixtures only |
| Cross-runtime determinism matrix (Node/Deno/workers) | absent — Bun only |
| ORM upstream suites | absent — style tests only |
| Grammar-production coverage metrics | absent |

## 7. How to use this catalog

- Before claiming support for a feature in README/marketing, check it is not in §2/§4/§5.
- When fixing a §4 thin edge, add contract tests and (if it was pinned) remove the divergence entry + regenerate `DIVERGENCES.md`.
- When implementing a §2 command, update `scripts/postgres-requirements.ts` seeding, re-run `bun run requirements`, and add catalog scenarios.
