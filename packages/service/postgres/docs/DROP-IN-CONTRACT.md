# Drop-in contract — `@crvouga/postgres-mem`

**Status:** definition (2026-08-21). Until this document exists and tests map to it, “drop-in replacement” is unfalsifiable.

**Related:** [GAP-ANALYSIS.md](GAP-ANALYSIS.md) (coverage vs this contract), [GAP-CATALOG.md](GAP-CATALOG.md) (unproven inventory), [COMPATIBILITY.md](../COMPATIBILITY.md), [`compat/divergences.json`](../compat/divergences.json).

---

## 0. Claim under test (falsifiable)

> For every SQL statement (or sequence) in the **in-scope dialect surface**, executing it against `@crvouga/postgres-mem` and against a **pinned PostgreSQL oracle** yields observationally equal results under the equivalence relation in §2 — except for divergences listed in §4, each of which has a pinning test.

This is **not** the claim “any app can replace `pg` / `postgres.js` / PGlite by swapping the import.” That broader claim is **false today** for the reasons in §1 and [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

Honest product claim:

> **SQL dialect drop-in** vs PostgreSQL 18.3 (default oracle PGlite; secondary native-server oracle via `bun run test:postgres-native`) for the sync `Database`/`Statement` surface documented here — **not** a drop-in for the wire protocol, async client APIs, `pg_dump` files, full PL/pgSQL, extensions, or multi-session concurrency.

---

## 1. Drop-in for *what*?

Each consumer surface has a different API. “Drop-in” must name the surface.

| Surface | Typical entry | postgres-mem today | Drop-in status |
| --- | --- | --- | --- |
| **postgres-mem native** | `import { Database } from "@crvouga/postgres-mem"` — `exec` / `query` / `prepare` → `run`/`all`/`get`/`result`, `transaction`, `copyFrom`, `snapshot`/`restore`, `changes` | **This is the supported API** | Claim target for SQL dialect parity only |
| **`pg` (node-postgres)** | Async `Client`/`Pool`, `client.query(text, values)` → `{ rows, rowCount, fields }`, events, cursors | Sync API, no Pool/Client shape, no events | **Non-drop-in** without an adapter |
| **`postgres.js`** | Tagged-template `` sql`SELECT …` ``, async, pipelining | No adapter | **Non-drop-in** |
| **PGlite** | Async `db.query` / `db.exec`, `.dumpDataDir()`, extensions, live queries | Used as the differential oracle, not as an API model | **Non-drop-in** API-wise; **dialect** is the claim |
| **Wire protocol** | Any driver in any language over TCP/socket | No sockets, no protocol | **NOT APPLICABLE** |
| **ORMs** | Prisma, Drizzle, Kysely, TypeORM, knex | No official drivers; catalog introspection queries largely work (`pg_catalog` / `information_schema`) but upstream suites unproven | **Unproven** as drop-in drivers |
| **`pg_dump` / restore** | SQL text or custom-format archives | Plain-SQL subset executes (in-scope statements); custom format is not parsed | **Partial** (plain SQL only) |

Package exports today: `"."` and `"./unstable"` only — **no** `@crvouga/postgres-mem/pg`, `/pglite`, etc.

---

## 2. Equivalence relation (what “same behavior” means)

Every differential test must compare against the oracle using this relation (or an explicitly weaker documented subset).

### 2.1 Statement result

Implemented today in [`tests/harness/`](../tests/harness/) (`expectParity`, `deepCompareResults`, adapters):

| Field | Rule |
| --- | --- |
| **Rows** | Same row count; cells compared after harness normalization to canonical PostgreSQL text |
| **Per-column type names** | When requested (`parityTyped`): PG internal names (`int4`, `numeric`, `_text`, …) |
| **float4/float8** | Exact text by default; rank comparisons may use epsilon (`rankParity`) |
| **bytea** | Exact byte sequences |
| **Column names + count** | From result metadata |
| **Row order** | Order-sensitive unless the test marks order-insensitive |
| **`rowCount` / command tag** | Compared for DML unless neutralized for DDL/txn/session statements |
| **Errors** | Both fail; SQLSTATE class + normalized message prefix |
| **Transaction status** | In-transaction flag when not ignored |

### 2.2 Post-statement database state

[`expectStateParity`](../tests/harness/state-dump.ts): schema object names, column definitions, row payloads, sequence values — dumped from both engines after write sequences and compared.

### 2.3 Multi-statement scripts

`exec()` runs all statements; `db.changes` reflects the most recent completed DML statement. A failed statement inside an explicit transaction does **not** put the session into the `25P02` aborted state (𝔇 `no-aborted-transaction-state`) — this is the largest known semantic divergence.

---

## 3. Reference oracles (pinned)

| Oracle | Role today | Contract target |
| --- | --- | --- |
| **PGlite** (`@electric-sql/pglite`) | **Default** differential oracle (`tests/adapters/pglite.ts`) — `bun run test:postgres-compat` | Primary — `server_version` **18.3** pinned in `tests/harness/oracle-versions.ts` + gate |
| **Native `postgres` server** | **Secondary** oracle (`tests/adapters/postgres-server.ts`) — `bun run test:postgres-native` (embedded-postgres 18.3, or `POSTGRES_MEM_ORACLE_URL`) | Same allow-list; CI job `test-native-oracle` |
| **`psql` text output** | Normalization reference (canonical text rendering) | Encoded in `datumText` + harness normalize |

**Rule:** Prefer catching PGlite-only quirks with the native oracle (`POSTGRES_MEM_ORACLE=server`). Default CI stays on PGlite for speed; the native suite is the second proof path. PGlite **is** real Postgres compiled to WASM, which already reduces quirk risk vs a reimplementation oracle.

---

## 4. Declared intentional divergences

Source of truth: [`compat/divergences.json`](../compat/divergences.json) (18 entries). Each entry must have `pinnedBy` tests. Human-readable summary: [DIVERGENCES.md](../DIVERGENCES.md). Highlights:

| ID | Behavior |
| --- | --- |
| `pgmm-snapshot-codec` | Snapshots are `PGMM`, not `pg_dump` |
| `deterministic-runtime` | Seeded `random()` / fixed `now()` by default |
| `sync-api-surface` | Sync single-session API, not an async client |
| `copy-stdin-api` | COPY payloads via `copyFrom(sql, text)` hook |
| `no-aborted-transaction-state` | No `25P02` after in-transaction errors |
| `trigger-order-creation` / `trigger-update-of-ignored` / `instead-of-triggers-unsupported` | Trigger edges |
| `round-half-away-from-zero` / `float8-overflow-saturates` | float8 edges |
| `drop-cascade-view-retained` / `comment-on-not-stored` / `pg-get-viewdef-missing` | DDL/catalog edges |
| `version-banner` | `version()` banner text |

New intentional differences **must** add a divergence entry + pin test before README mentions them.

---

## 5. Out of scope (NOT APPLICABLE)

These are **not** drop-in failures; marketing must not imply them:

1. **Wire protocol** / network clients / connection pooling
2. **Multi-session concurrency**, MVCC across connections, isolation levels, locks that block
3. **Roles / authentication / privileges** as enforcement (GRANT/REVOKE parse as no-ops)
4. **Full PL/pgSQL** and other procedural languages (plpgsql-lite UDFs: DECLARE / EXCEPTION WHEN others / RETURN NEXT / FOR-IN-SELECT)
5. **Extensions** (`CREATE EXTENSION`), foreign data wrappers, logical/physical replication
6. **Storage internals** — VACUUM behavior, TOAST, tablespaces, checkpoints
7. **LISTEN/NOTIFY**, cursors (`DECLARE`/`FETCH`), `MERGE`, `CALL` (fail loud today)

**Borderline (in dialect scope but intentionally limited):**

- Persistence via **PGMM** only, not `pg_dump` (𝔇 `pgmm-snapshot-codec`)
- Collation pinned to `C` semantics; ICU/locale ordering out of scope
- `EXPLAIN` stub shapes

---

## 6. Proof obligations (how the claim becomes evidence)

A green CI alone is not proof. The contract requires:

| Mechanism | Purpose |
| --- | --- |
| Differential contracts + fuzz vs oracle | Behavioral equality |
| Fail-closed inventory / requirements / scenario gates | Oracle surface not silently missing |
| Canaries (`bun run canaries`) | Suite can fail; sabotages are caught |
| Skip register (`scripts/check-skip-register.ts`) | No silent skips |
| Smoke ratchet (`compat/smoke-baseline.json`) | No trivial-probe proof inflation |
| Browser smoke + fixtures | Client delivery claims |
| Auto-generated `DIVERGENCES.md` | Docs cannot drift from divergences.json |

---

## 7. Classes of application (guidance)

| App class | Fit today? |
| --- | --- |
| New browser/Node app using postgres-mem API; schema+data rebuilt from SQL or PGMM; no PL/pgSQL | **Best fit** — dialect claim is the relevant one |
| Unit-testing SQL that runs against real Postgres in production | **Good fit** for the in-scope dialect; check UNSUPPORTED list first |
| Port from `pg` / `postgres.js` with a thin sync adapter | **Possible** if async client features (pooling, events, cursors) unused |
| Loading `pg_dump` plain SQL | **Partial** — in-scope statements only |
| Prisma / Drizzle / Kysely via custom driver | **Plausible**; introspection queries largely work, upstream suites unproven |
| Apps needing MVCC, roles, LISTEN/NOTIFY, extensions | **Non-starter** |
