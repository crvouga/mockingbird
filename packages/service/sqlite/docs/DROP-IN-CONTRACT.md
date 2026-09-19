# Drop-in contract — `@crvouga/sqlite-mem`

**Status:** Phase 0 definition (2026-08-20). Until this document exists and tests map to it, “drop-in replacement” is unfalsifiable.

**Related:** [GAP-ANALYSIS.md](GAP-ANALYSIS.md) (coverage vs this contract), [GAP-CATALOG.md](GAP-CATALOG.md) (prior inventory), [COMPATIBILITY.md](../COMPATIBILITY.md), [`compat/divergences.json`](../compat/divergences.json).

---

## 0. Claim under test (falsifiable)

> For every SQL statement (or sequence) in the **in-scope dialect surface**, executing it against `@crvouga/sqlite-mem` and against a **pinned SQLite oracle** yields observationally equal results under the equivalence relation in §2 — except for divergences listed in §4, each of which has a pinning test.

This is **not** the claim “any browser app can replace `sql.js` / `sqlite-wasm` by swapping the import.” That broader claim is **false today** for the reasons in §1 and [GAP-ANALYSIS.md](GAP-ANALYSIS.md) §Verdict.

Honest product claim (proposed for README once gates exist):

> **SQL dialect drop-in** vs SQLite 3.51.x (oracle `bun:sqlite`) for the sync `Database`/`Statement` surface documented here — **not** a drop-in for on-disk `.sqlite` I/O, C/WASM APIs, user-defined functions, or `sql.js` / OO1 method shapes.

---

## 1. Drop-in for *what*?

Each consumer surface has a different API. “Drop-in” must name the surface.

| Surface | Typical entry | sqlite-mem today | Drop-in status |
| --- | --- | --- | --- |
| **sqlite-mem native** | `import { Database } from "@crvouga/sqlite-mem"` — `exec` / `query` / `prepare` → `run`/`all`/`get`/`result`, `transaction`, `snapshot`/`restore`, `changes` / `lastInsertRowid` | **This is the supported API** | Claim target for SQL dialect parity only |
| **`sql.js`** | `new SQL.Database(bytes)`, `db.run` / `db.exec` → `[{columns,values}]`, `stmt.bind`/`step`/`get`/`getAsObject`/`getColumnNames`/`reset`/`free`, `db.each`, `db.export()`, `db.create_function` | No adapter export; no `step`/`export`/UDF; snapshot ≠ `.sqlite` | **Non-drop-in** without adapters + file codec + UDF |
| **`wa-sqlite` / `@sqlite.org/sqlite-wasm`** | OO1 `DB`/`Stmt`, `oo1.OpfsDb`, `sqlite3_*` bindings | No C API, no OPFS, no WASM | **Non-drop-in** |
| **`better-sqlite3`** | `Database`, `prepare`, `iterate`, `pluck`/`raw`/`expand`, `safeIntegers`, sticky `bind`, `pragma()`, hooks, `serialize`/`backup` | Subset of method names; extras absent (pinned `js-api-surface`) | **Partial** SQL-only; **not** API drop-in |
| **`node:sqlite`** | `DatabaseSync` / `StatementSync`, `function()`, stepping | No adapter; no UDF; different class names | **Non-drop-in** |
| **`bun:sqlite`** | Closest oracle shape; used as differential oracle | Similar `prepare`/`run`/`all`/`get`; no file DB, no `serialize` as `.sqlite` | **Closest** for SQL; still not file/WASM swap |
| **ORMs** | Kysely, Drizzle, TypeORM, Sequelize, Knex | No official drivers; integration tests are **style** SQL (pragma TVFs, CRUD), not upstream suites | **Unproven** as drop-in drivers |
| **Sync engines** | ElectricSQL / PowerSync / CR-SQLite patterns | Need `.sqlite` bytes, ATTACH, often hooks/triggers + file round-trip | **Non-starter** while §35/§37 gaps hold |

Package exports today: `"."` and `"./unstable"` only — **no** `@crvouga/sqlite-mem/sql.js`, `/better-sqlite3`, etc.

---

## 2. Equivalence relation (what “same behavior” means)

Every differential test must compare against an oracle using this relation (or an explicitly weaker documented subset).

### 2.1 Statement result (B-tuple)

Implemented today in [`tests/harness/`](../tests/harness/) (`expectParity`, adapters):

| Field | Rule |
| --- | --- |
| **Rows** | Same row count; cells compared after harness normalization |
| **Per-cell SQL typeof** | When requested (`parityTyped` / dump types): `NULL` / `integer` / `real` / `text` / `blob` |
| **REAL** | Exact by default; FTS rank may use `realEpsilon: 1e-15` |
| **BLOB** | Exact byte sequences (`Uint8Array`) |
| **Column names + count** | From result metadata (`result().columns` / query column list) |
| **Row order** | Order-sensitive unless the test marks order-insensitive |
| **`changes` / `lastInsertRowid` / `total_changes`** | Compared unless `ignoreWriteCounters` / neutralized for DDL/txn/pragma |
| **Errors** | Both fail; category + `sqliteCode`; message Tier A exact or Tier B prefix-normalized |
| **Autocommit / in-transaction** | Session fields when not ignored |

### 2.2 Post-statement database state

[`dumpLogicalState`](../tests/harness/state-dump.ts): schema object names/`tbl_name`, `table_info`, row payloads + typeof, indexes (non-autoindex), FKs, `sqlite_sequence`, selected pragma knobs.

**Known dump weakness (contract gap):** `sqlite_master.sql` is **queried** but **not** compared character-for-character in the dump payload (only `type:name` → `tbl_name`). ORM migration tools that diff `sql` text are **not** covered by Dump equality today.

### 2.3 Multi-statement scripts

`exec()` runs all statements; counters reflect the **most recent** completed statement (documented README semantics). Differential coverage includes multi-statement `exec` counter sequences (`tests/contract/null/not-in-select.test.ts`, `api/freeze.test.ts`).

---

## 3. Reference oracles (pinned)

| Oracle | Role today | Contract target |
| --- | --- | --- |
| **`bun:sqlite`** | **Sole** differential oracle (`tests/adapters/real-sqlite.ts`) | Primary — versions **3.51.0** (macOS) or **3.53.0** (Linux/Windows Bun); gate + `oracle-platform-sqlite-version` |
| **`node:sqlite`** | Not wired | Secondary CI matrix (Phase 2+) |
| **Native `sqlite3` CLI** | Not wired | Dump / integrity / file round-trip when file codec exists |
| **Official `sqlite-wasm`** | Benchmarks only (`benchmarks/compare/`) | Browser dialect + API conformance |
| **`sql.js`** | Benchmarks only | Adapter conformance |

**Rule:** absence of a second oracle means bugs that happen to match Bun’s amalgamation quirks can be encoded as “parity.” Multi-oracle matrix is required before marketing “SQLite” generically.

---

## 4. Declared intentional divergences

Source of truth: [`compat/divergences.json`](../compat/divergences.json). Each entry must have `pinnedBy` tests. Summary:

| ID | Behavior |
| --- | --- |
| `snapshot-sqlm` | Snapshots are `SQLM`, not `.sqlite` |
| `deterministic-random-now` | Seeded `random()` / fixed `'now'` by default |
| `negzero-canonicalization` | IEEE `-0` → `+0` |
| `attach-empty-schema` | `ATTACH 'file'` → empty in-memory schema (filename recorded) |
| `explain-stub` | `EXPLAIN` shapes are stubs |
| `indexed-by-discarded` | `INDEXED BY` / `NOT INDEXED` ignored (missing index does not error) |
| `materialized-hint-ignored` | `MATERIALIZED` / `NOT MATERIALIZED` both materialize |
| `fts-shadow-counters` | FTS shadow `changes()` may differ |
| `compile-options-function-list` | Engine’s own lists, not Bun’s |
| `js-api-surface` | No better-sqlite3 extras (`iterate`/`pluck`/…) |
| `snapshot-exclusions` | Triggers, ATTACH, vtabs, `user_version` not in SQLM |
| `json-api-unwrap` | JSON subtype → JS string |
| `nan-infinity-bind` | Reject NaN/Infinity binds |
| `double-quote-string-fallback` | Double-quote identifier/string rules as pinned |
| `lone-surrogate-bind` | Lone surrogate bind behavior pinned |
| `user-version-snapshot` | `user_version` not restored from SQLM |
| `oracle-platform-sqlite-version` | 3.51.0 vs 3.53.0 platform split |

New intentional differences **must** add a 𝔇 entry + pin test before README mentions them.

---

## 5. Out of scope (NOT APPLICABLE)

These are **not** drop-in failures; marketing must not imply them:

1. SQLite **C API** (`sqlite3_*`)
2. On-disk **pager / VFS / WAL / SHM / file locking**
3. **URI filename** semantics for opening files
4. **Multi-process** concurrency / locking
5. Loading **native extensions** via `loadExtension`
6. **OPFS** / SharedArrayBuffer WASM workers (by design — no WASM)

**Borderline (in dialect scope but intentionally limited):**

- `ATTACH` of filesystem paths → empty schema (𝔇 `attach-empty-schema`)
- Persistence via **SQLM** only, not `.sqlite` (𝔇 `snapshot-sqlm`)

If a consumer needs true `.sqlite` interchange, that is an **in-scope product gap** for “replace WASM SQLite in the client,” not a NOT APPLICABLE item — see GAP-ANALYSIS §35.

---

## 6. Proof obligations (how the claim becomes evidence)

A green CI alone is not proof. The contract requires:

| Mechanism | Purpose |
| --- | --- |
| Differential contracts + fuzz vs oracle | Behavioral equality |
| Fail-closed inventory / requirements / scenario gates | Oracle surface not silently missing |
| Canaries / mutation / branch coverage | Suite can fail; dead code not hidden |
| `@no-oracle` ratchet | No hardcoded-only behavioral tests without label |
| Skip register with expiry | No silent skips |
| Browser + purity + size gates | Client delivery claims |
| Conformance adapters + upstream suites | API drop-in claims (only if those surfaces are claimed) |
| Auto-generated `DIVERGENCES.md` | Docs cannot drift from 𝔇 |

Until Phase 1–3 close, treat README “drop-in” / VERIFIED marketing as **aspirational relative to this contract**, not proven for browser WASM replacement.

---

## 7. Classes of application (guidance)

| App class | Fit today? |
| --- | --- |
| New browser/Node app using sqlite-mem API; schema+data rebuilt from SQL or SQLM; no UDFs | **Best fit** — dialect claim is the relevant one |
| Port from `bun:sqlite` / better-sqlite3 **SQL** with thin API shim | **Possible** if extras unused |
| Port from `sql.js` / `sqlite-wasm` with `export()` / file load | **Non-starter** without file codec |
| Kysely/Drizzle via custom dialect over prepare/run | **Plausible**; migrator/`sql` text + upstream suites unproven |
| Electric / PowerSync / CR-SQLite style sync | **Non-starter** without `.sqlite` + richer ATTACH/hooks |
