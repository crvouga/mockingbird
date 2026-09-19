# Gap analysis — drop-in proof vs the full PostgreSQL surface

**Status:** initial build audit (2026-08-21). Remaining blockers (§30/§31/§40) prevent any claim broader than the SQL-dialect drop-in defined in [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md).

**Contract:** [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md). Inventory of thin/unproven items: [GAP-CATALOG.md](GAP-CATALOG.md).

**Evidence basis:** repo tree as of this date — 246 contract test files across 66 area directories, 24 fuzz files, sole oracle PGlite 18.3 (`tests/adapters/pglite.ts`), gate `bun run test:postgres-compat`, divergences in `compat/divergences.json` (18 entries), canaries + skip register + smoke ratchet wired. No wire-protocol adapter, no second oracle, no browser differential CI beyond smoke fixtures.

---

## Verdict (answer first)

**Given the current API surface — sync single-session, no wire protocol, no PL/pgSQL, no extensions — can postgres-mem replace PostgreSQL for an application today?**

| Class of app | Answer |
| --- | --- |
| New client/test apps that adopt the **postgres-mem** sync API, persist via **PGMM** or rebuild-from-SQL, and stay within the dialect | **Yes, as a SQL engine** — strongest existing evidence is the differential contract suite vs real Postgres 18.3 (PGlite). |
| Unit tests for SQL that ships to real Postgres | **Conditional yes** — check the UNSUPPORTED command list (58 commands) and divergences (18) first. |
| Drop-in swap for **`pg` / `postgres.js` / PGlite** client code | **No — non-starter** without adapters (§40). |
| Apps needing **PL/pgSQL, extensions, MERGE, cursors, LISTEN/NOTIFY** | **No — non-starter**; these fail loud (§31). |
| Apps needing **multi-session MVCC / isolation / locking** | **No — non-starter** by design (single session). |
| ORMs (Prisma / Drizzle / Kysely) via custom driver | **Unproven** — introspection queries work in style tests; upstream suites not run (§41). |

Treat any marketing phrase implying “no known bugs” or unqualified “drop-in for Postgres” as **unverified**. Absence of failures in the current suite is not absence of gaps.

---

## Legend

| Field | Values |
| --- | --- |
| **Status** | `covered` — differential happy+edges vs oracle; `partial` — some differential, important holes; `absent` — no meaningful oracle proof (or capability missing); `intentional` — documented divergence with pin; `n/a` — outside dialect claim |
| **Severity** | `blocker` / `major` / `minor` for the **drop-in** claim |
| **Effort** | S ≤2d · M ~1w · L ~2–4w · XL multi-sprint |

---

## Suite integrity (meta)

| # | Item | Status | Severity | Effort | Evidence |
| --- | --- | --- | --- | --- | --- |
| M1 | Canaries (suite can fail) | **covered** | — | — | `tests/meta/canaries/defs.ts` (6 sabotages) + `bun run canaries` |
| M2 | Skip register | **covered** | — | — | `scripts/check-skip-register.ts` + `tests/meta/skips.json` (empty) |
| M3 | Smoke ratchet | **covered** | — | — | `compat/smoke-baseline.json` (`ids: []` — zero smoke stubs) |
| M4 | Mutation testing (Stryker) | **absent** | major | L | No mutation tooling in CI |
| M5 | Branch-coverage thresholds | **absent** | major | M | No coverage gate |
| M6 | Flake gate (shuffled multi-seed soak) | **partial** | minor | M | Seed replay exists (`POSTGRES_MEM_FUZZ_SEED`/`PATH`); nightly soak workflow, no 20× shuffle |

---

## A. SQL semantics — values and types

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 1 | Core scalar types (bool/ints/floats/text/bytea/uuid) | **covered** | — | — | `tests/contract/types/`, `bytea/`, `uuid/` + matrices |
| 2 | `numeric` arbitrary precision (add/mul/div/round/compare) | **covered** | — | — | `tests/contract/numeric/` + fuzz |
| 3 | `numeric` transcendentals (exp/ln/power/sqrt) at extreme scales | **partial** | major | L | In-repo fixed-point implementation; edges at very large scale/precision thinner |
| 4 | Cast matrix (implicit/assignment/explicit) | **covered** | — | — | Generated from oracle `pg_cast` → `tests/contract/matrices/` |
| 5 | Date/time + intervals + timezones | **partial** | major | L | `date-time/`, `intervals/` broad; named-zone DST transitions and interval normalization corners thinner |
| 6 | Collation / ordering | **intentional** `C` | major | XL | Locale/ICU ordering out of scope; pinned semantics |
| 7 | NULL / 3VL through operators, aggregates, DISTINCT | **covered** | — | — | `null/`, fuzz TLP partitions |
| 8 | Regex flavor (POSIX ERE via JS regex mapping) | **partial** | major | M | `regex/`; character-class/locale edges thinner |
| 9 | float8 edges | **intentional** (2 pins) | minor | S | `round-half-away-from-zero`, `float8-overflow-saturates` |

---

## B. SQL semantics — statements and schema

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 10 | Core DML/SELECT/joins/set ops/CTEs | **covered** | — | — | Area dirs + fuzz + metamorphic |
| 11 | ON CONFLICT / RETURNING / UPDATE-FROM / DELETE-USING | **covered** | — | — | `on-conflict/`, `returning/`, `update-from/` |
| 12 | Constraints + FK referential actions | **covered** | — | — | `constraints/`, `foreign-keys/`; DEFERRABLE checked at statement end (parsed, not deferred to commit) |
| 13 | Window functions (frames, EXCLUDE) | **covered** | — | — | `window-functions/` + fuzz |
| 14 | GROUPING SETS / ROLLUP / CUBE | **covered** | — | — | `grouping/` |
| 15 | Triggers | **partial** + 3 pins | major | M | Creation-order firing, `UPDATE OF` ignored, no INSTEAD OF (all pinned) |
| 16 | `LANGUAGE sql` functions | **partial** | major | M | Scalar + SRF; polymorphic/variadic/overload resolution edges thinner |
| 17 | ALTER TABLE breadth | **partial** | major | L | Common forms covered; exotic forms (SET STORAGE, attach partition, …) unsupported/registered |
| 18 | Partitioned tables | **absent** (registered) | major | XL | `CREATE TABLE ... PARTITION BY` unsupported, fails loud |
| 19 | MERGE / CALL / cursors | **absent** (registered) | major | XL | Fail loud `0A000` |
| 20 | Aborted-transaction state (`25P02`) | **intentional** | **major** | L | Largest semantic divergence — pinned `no-aborted-transaction-state` |
| 21 | EXPLAIN | **intentional** stubs | minor | XL | Plan shapes only |

---

## C. Catalog, metadata, introspection

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 22 | `pg_catalog` core relations (`pg_class`, `pg_attribute`, `pg_type`, `pg_proc`, `pg_namespace`, …) | **partial** | major | L | Commonly-queried columns present; long tail of columns/relations thinner |
| 23 | `information_schema` | **partial** | major | M | `tables`/`columns` + common views; full standard surface incomplete |
| 24 | `pg_get_viewdef` / deparse functions | **absent** (pinned) | major | L | `pg-get-viewdef-missing`; ORM migration diffing not covered |
| 25 | `version()` banner | **intentional** | minor | S | Pinned `version-banner` |
| 26 | GUCs (SET/SHOW/RESET) | **partial** | minor | M | Common GUCs; long tail returns defaults or errors |

---

## D. Transactions and concurrency

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 27 | BEGIN/COMMIT/ROLLBACK/SAVEPOINT | **covered** | — | — | `transactions/`, `savepoints/` + DST fuzz |
| 28 | Isolation levels / multi-session MVCC | **n/a** | — | — | Single session by design |
| 29 | Deferred constraint timing (commit-time) | **partial** | major | M | DEFERRABLE parsed; checks run at statement end, not commit |

---

## E. Missing capability surface

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 30 | Wire protocol / async client | **absent** | **blocker** (for client swap) | XL | No sockets; sync API only |
| 31 | PL/pgSQL / extensions / FDW | **absent** (registered) | **blocker** (for such apps) | XL | Fail loud |
| 32 | `pg_dump` custom-format restore | **absent** | major | XL | Plain SQL subset only |
| 33 | LISTEN/NOTIFY | **absent** (registered) | major | L | Fail loud |

---

## F. DST and fuzzing

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 34 | Deterministic driver + minimize + repro | **covered** | — | — | `tests/fuzz/dst/` |
| 35 | Model-based differential after every op | **covered** | — | — | `stateful.test.ts`, `mixed-stateful.test.ts` |
| 36 | TLP / NoREC metamorphic | **covered** | — | — | `tests/fuzz/metamorphic/` |
| 37 | Robustness (PostgresError-only, no hang) | **covered** | — | — | `tests/fuzz/robustness.test.ts` |
| 38 | Grammar-production-weighted generators | **partial** | major | XL | Area arbitraries, not production-weighted grammar |
| 39 | Cross-runtime determinism gate (Node/Deno/browsers) | **absent** | major | L | Proven under Bun only |

---

## G. Ecosystem conformance

| # | Item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 40 | Adapter entry points (`pg`-shaped, PGlite-shaped) + upstream suites | **absent** | **blocker** | XL | No adapter exports |
| 41 | ORM conformance (Prisma/Drizzle/Kysely upstream suites) | **partial** | major | XL | Introspection-style contracts only |
| 42 | In-browser full differential CI | **partial** | major | L | Browser smoke vs recorded fixtures; full suite is Bun-only |

---

## Ranked top 10 (for strengthening the dialect claim)

| Rank | ID | Gap | Why it matters | Effort |
| --- | --- | --- | --- | --- |
| 1 | 20 | `25P02` aborted-transaction state | Most visible semantic difference in error paths | L |
| 2 | 22–24 | Catalog long tail + `pg_get_viewdef` | ORM introspection/migration tools | L |
| 3 | 5 | Interval/timezone corners | Common app bugs land here | L |
| 4 | 29 | Commit-time deferred constraints | Silent semantic difference for DEFERRABLE users | M |
| 5 | 15 | Trigger name-order + `UPDATE OF` + INSTEAD OF | Documented but fixable | M |
| 6 | 3 | numeric transcendental extremes | Precision claims | L |
| 7 | 18 | Partitioned tables | Common in modern schemas | XL |
| 8 | 19 | MERGE | Postgres 15+ apps use it | XL |
| 9 | M4/M5 | Mutation/coverage gates | Trust in green | L |
| 10 | 39 | Cross-runtime determinism | “Runs in browsers” claim | L |

---

## What *is* relatively strong today

- Large **differential** suite vs real Postgres 18.3 for core DML/DDL/joins/CTE/windows/jsonb/arrays/numeric/datetime.
- Fail-closed **inventory** (2787 oracle functions, 74 operators — zero silent gaps) / requirements / scenario / smoke-ratchet machinery.
- Machine-readable intentional divergences (18 pinned entries + generated markdown).
- Canaries, skip register, corpus regressions — the suite has been shown to fail on sabotage.
- Deterministic runtime with snapshot/PRNG/clock round-trip proofs.

---

## Recommended claim (applied in README)

> **Verified:** PostgreSQL 18 **SQL dialect** behavioral parity against PGlite 18.3 for the `@crvouga/postgres-mem` sync API, via differential contracts (`bun run test:postgres-compat`).
>
> **Not a drop-in for:** `pg` / `postgres.js` / PGlite client APIs, the wire protocol, PL/pgSQL, extensions, multi-session concurrency, or `pg_dump` interchange.
