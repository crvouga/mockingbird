# Gap analysis — drop-in proof vs Phase 2 catalog

**Status:** Phase 0 audit complete (2026-08-20). **Partial Phase 1–2 progress applied** — see [PROOF.md](PROOF.md). Remaining blockers (§34/§35/§54) still prevent full WASM drop-in.

**Contract:** [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md). Prior inventory: [GAP-CATALOG.md](GAP-CATALOG.md).

**Evidence basis:** repo tree as of this date — ~183 contract test files, ~18 fuzz files, sole oracle `bun:sqlite` (`tests/adapters/real-sqlite.ts`), gate `bun run test:sqlite-compat`, divergences in `compat/divergences.json` (17 entries). No `tests/meta/`, `tests/dst/`, `tests/conformance/`, Stryker, branch-coverage CI, Playwright SQL suite, or multi-oracle matrix.

---

## Verdict (answer first)

**Given the current API surface — no user-defined functions, no `.sqlite` file I/O, no lazy `step`/`iterate`, and `ATTACH 'file'` → empty schema — can sqlite-mem replace a WASM SQLite build in a browser app today?**

| Class of app | Answer |
| --- | --- |
| New client apps that adopt the **sqlite-mem** sync API, persist via **SQLM** or rebuild-from-SQL, and stay within the dialect | **Yes, as a SQL engine** — strongest existing evidence is Bun-side differential contracts. Browser SQL dialect execution is **unproven in CI** (blocker). |
| Apps that only need “run SQL, get rows” and can rewrite persistence | **Conditional yes** — rewrite imports + drop file export/import. |
| Drop-in swap for **`sql.js` / `sqlite-wasm` / OO1** (same methods, `export()` / serialize `.sqlite`, OPFS) | **No — non-starter.** |
| Apps needing **`create_function` / custom collations / aggregates** | **No — non-starter** until §34. |
| Sync engines (Electric / PowerSync / CR-SQLite) exchanging **`.sqlite`** or ATTACH’d files | **No — non-starter** until §35–§37 / §56. |
| ORMs expecting **better-sqlite3 / node:sqlite** drivers + upstream test pass | **No** — style SQL only (§54–§55); not vendor suites. |

Treat any marketing phrase implying “no known bugs” or unqualified “drop-in for client SQLite” as **unverified**. Absence of failures in a Bun-only suite is not absence of gaps.

---

## Legend

| Field | Values |
| --- | --- |
| **Status** | `covered` — differential happy+edges vs oracle; `partial` — some differential, important holes; `absent` — no meaningful oracle proof (or capability missing); `intentional` — documented divergence with pin; `n/a` — outside dialect claim |
| **Severity** | `blocker` / `major` / `minor` for the **browser WASM drop-in** claim (not “is the SQL engine empty”) |
| **Effort** | S ≤2d · M ~1w · L ~2–4w · XL multi-sprint / research |

Evidence cites paths relative to repo root. Line numbers are approximate anchors from the Phase 0 audit.

---

## Phase 1 meta-gaps (suite integrity)

These are not SQL features — they determine whether later green is trustworthy.

| # | Item | Status | Severity | Effort | Evidence |
| --- | --- | --- | --- | --- | --- |
| P1.1 | Canary / anti-cheat (`tests/meta/canaries/`) | **absent** | blocker | M | No `tests/meta/`. Suite has never been shown to fail under deliberate semantic corruption. |
| P1.2 | Mutation testing (StrykerJS) | **absent** | major | L | No Stryker / mutation tooling in `package.json` / CI. |
| P1.3 | Branch coverage per-file thresholds | **absent** | major | M | No c8/istanbul/v8 coverage gate. |
| P1.4 | `@no-oracle` lint + ratchet | **absent** | major | M | Helpers favor oracle (`parity` et al. in `tests/contract/helpers.ts`), but no AST lint; ISOLATED / hardcoded `expect` paths exist (~15 ISOLATED-tagged uses; catalog ECO/divergence fns). |
| P1.5 | Skip register (ID/reason/expiry) | **absent** | minor | S | Few/no `.skip`/`todo` found; no machine register or CI fail on undocumented skips. |
| P1.6 | Flake gate (20× shuffled + random fuzz seeds) | **absent** | major | M | Fuzz has seed replay (`SQLITE_MEM_FUZZ_SEED` / `PATH`); no 20× shuffle soak in CI. |

---

## A. SQL semantics — values and types

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 1 | Affinity matrix (types × values × CAST/UNION/index/INSERT SELECT) | **partial** | major | L | `tests/contract/types/affinity.test.ts`, `comparison-affinity.test.ts`, `edges.test.ts`; matrices `m1`/`m2` for ops/CAST. Not a full declared-type × value-class combinatorial matrix. |
| 2 | Comparison / ordering / row values / NULLS FIRST|LAST | **partial** | major | M | Cross-type via affinity + `ordering/`, `row-values/`, `null/`, catalog NULLS. Full cross-type table + `BETWEEN`/`IN` mixed edges thinner. |
| 3 | Collation BINARY/NOCASE/RTRIM + precedence + non-ASCII | **partial** | major | M | `tests/contract/collate/*`, fuzz `collate.test.ts`; `UNI-fold-01` non-ASCII fold. Custom collation registration **absent** (§34). UNIQUE COLLATE / generated COLLATE thin (`GAP-CATALOG`). |
| 4 | Numerics (int64 overflow, `/0`, shifts, −0, subnormals, printf, round) | **partial** | major | L | Expressions + matrices + typ catalog; `-0` intentional. Exhaustive overflow/shift/subnormal/`Infinity` arithmetic matrix incomplete. |
| 5 | Text / UTF-8 / astral / length vs UTF-16 | **partial** | major | M | `tests/contract/catalog/uni.test.ts` (`UNI-len-01`, `UNI-astral-01`, `UNI-surr-01`). Embedded NUL / invalid UTF-8 BLOB→TEXT thinner. |
| 6 | NULL / 3VL through operators, aggregates, DISTINCT | **partial** | major | M | `null/`, `distinct/`, aggregates. `NOT IN (SELECT …)` with NULL rows called out as high hole in GAP-CATALOG. |

---

## B. SQL semantics — statements and schema

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 7 | Grammar production coverage instrumentation | **absent** | major | XL | No machine-readable production list; no parser coverage counters; CI cannot fail on uncovered productions. |
| 8 | Rowid / AUTOINCREMENT / WITHOUT ROWID / aliases | **partial** | minor | M | `rowid/`, `without-rowid/`, primary-keys. Exhaustion / random probe / RETURNING rowid edges thinner. |
| 9 | Constraints × ON CONFLICT algorithms + timing | **partial** | major | L | `conflicts/`, `unique/`, `check/`, `or-modes`. Full 5-algorithm × constraint × trigger timing matrix incomplete. |
| 10 | UPSERT (targets, WHERE, excluded, WITHOUT ROWID) | **partial** | major | M | `upsert/*`, fuzz; GAP-CATALOG “thin-gaps” still open. |
| 11 | Foreign keys (actions, deferred, check, cycles) | **partial** | major | L | `foreign-keys/*` solid core; MATCH FULL, FK+triggers, SET DEFAULT missing parent thinner; `CON-fk-09` smoke. |
| 12 | Triggers (BEFORE/AFTER/INSTEAD OF, RAISE, recursion) | **partial** | major | L | `triggers/*` incl. instead-of; `recursive_triggers` PRAGMA / FK+trigger interactions thinner. |
| 13 | Generated columns VIRTUAL/STORED | **partial** | major | M | `generated/basic.test.ts`; insert-into-generated often ISOLATED; `table_xinfo` hidden flags thinner. |
| 14 | Indexes (partial/expr/DESC/COLLATE/REINDEX/ANALYZE) | **partial** | major | M | `indexes/*` proven core; INDEXED BY **intentional** no-op (`indexed-by-discarded`; pin hygiene: JSON cites COMPATIBILITY.md). |
| 15 | ALTER TABLE + rewriting views/triggers/`sqlite_master.sql` | **partial** | major | L | `alter-table/*`; reference rewriting + `sql` text fidelity vs oracle **not** Dump-proven (§24). |
| 16 | Views & CTEs (recursive, MATERIALIZED) | **partial** | minor | M | `views/`, `cte/`, `recursive-cte/`; MATERIALIZED **intentional**. View WITH / writable without INSTEAD OF thinner. |
| 17 | Joins (OUTER/NATURAL/USING/CROSS/many tables) | **partial** | minor | M | `joins/*`, catalog JOI-*; multi-column USING / NATURAL FULL edges thinner. |
| 18 | Query features (GROUP BY bare columns, LIMIT neg, compounds) | **partial** | major | L | `grouping/`, `select/`, `unions/`, `subqueries/`. Bare-column min/max special case + scalar cardinality edges incomplete. |
| 19 | Window functions (all builtins × frames × EXCLUDE) | **partial** | major | L | `window-functions/*`, fuzz `windows.test.ts`. IGNORE/RESPECT NULLS, illegal window in WHERE thinner. |
| 20 | Aggregates (FILTER, group_concat order, total vs sum) | **partial** | minor | M | `aggregates/`; group_concat order unspecified in SQLite — document decision. |
| 21 | RETURNING | **partial** | minor | S | `returning/`; excluded/old/new naming edges thinner. |
| 22 | Statement-level rollback | **partial** | major | M | `errors/state.test.ts` UNIQUE atomicity; multi-row fail-at-n + txn/autocommit matrix incomplete. |
| 23 | Change counters after every stmt class | **partial** | major | M | Compared in many paths but often `ignoreWriteCounters`; multi-statement `exec` counter differential called **high** in GAP-CATALOG; FTS counters intentional diverge. |

---

## C. Catalog, metadata, introspection

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 24 | `sqlite_master.sql` byte-fidelity | **partial** → effectively **absent** for ORM diffs | **blocker** | L | Dump queries `sql` (`state-dump.ts` ~18) but payload compares only `tbl_name` (~75–80), **not** `sql` text. Schema name lists proven (`schema/basic.test.ts`). |
| 25 | Result-set metadata / column naming | **partial** | major | M | API `result().columns`; SEL-dup / catalog. Full expression naming rules matrix incomplete. |
| 26 | PRAGMA matrix + `pragma_*` TVFs | **partial** | major | L | `pragma/*`, TVFs correlated (Kysely path). Many storage pragmas getter-sampled; `PRG-beh-01`…`07` still **smoke**. |
| 27 | Limits / SQLITE_TOOBIG parity | **partial** | major | L | `limits/`; `LIM-vals-01` smoke. Bound-param ceiling vs oracle not exhaustively proven. |
| 28 | Reserved words / quoting / temp shadowing | **partial** | minor | M | Lexer/parser contracts + TOK-*; unicode identifiers / all four quoting forms matrix incomplete. |

---

## D. Extensions and virtual tables

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 29 | JSON1 / JSONB full surface | **partial** | major | L | Large `json/*` + fuzz; thin-gaps file for remaining edges. |
| 30 | FTS5 (+ FTS3/4) | **partial** / PARTIAL | major | XL | `fts/*`, fuzz; COMPATIBILITY PARTIALLY VERIFIED; shadow counters intentional; README must not claim full FTS. |
| 31 | R-Tree, dbstat, math, soundex, datetime modifiers | **partial** | major | L | Modules stubs/parity in `modules/scope3-modules.test.ts`; date-time thin (`subsec`/`ceiling`/DST); math thin. |

---

## E. Transactions and concurrency

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 32 | BEGIN modes / SAVEPOINT nesting / DDL in txn | **partial** | minor | M | `transactions/`, `savepoints/`, fuzz. Locking modes N/A; IMMEDIATE/EXCLUSIVE success parity thin. |
| 33 | Cursor / mid-iteration mutation semantics | **absent** | **blocker** (for sql.js ports) | L | No `stmt.step` / `iterate`; API is eager `all`/`get`. Mid-scan mutation vs oracle **untestable** on current surface. |

---

## F. Missing capability surface

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 34 | JS UDFs / aggregates / windows / collations / TVF reg | **absent** | **blocker** | XL | No `create_function` / `Database.function` in `src/api/database.ts`. Collations builtin-only (`src/types/collation.ts`). |
| 35 | Real `.sqlite` file format I/O | **absent** / intentional SQLM | **blocker** | XL | `snapshot-sqlm`; README explicit. Without this, cannot replace WASM clients that `export()`/`serialize()`. |
| 36 | Streaming iteration, pluck/raw, hooks, VACUUM INTO, real multi-DB ATTACH semantics, loadExtension | **absent** / intentional | **blocker** (subset) | XL | `js-api-surface` pins absence of iterate/pluck/…; VACUUM no-op-ish (`misc/analyze-vacuum.test.ts`); no hooks/BLOB I/O/backup. |
| 37 | ATTACH file contents / cross-file schemas | **intentional** empty | **blocker** for sync/migrate | L | `attach/file.test.ts` proves mem does **not** see oracle file table; `:memory:` ATTACH matches. |

---

## G. DST and fuzzing

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 38 | Deterministic driver + shrink + repro files | **partial** | major | L | Seed/path replay + `tests/fuzz/dst/{minimize,repro}.ts` + `scripts/promote-fuzz-repro.ts` → corpus; shrink not fully automatic in CI. |
| 39 | Model-based differential after every op | **partial** | major | L | `fuzz/stateful` + `mixed-stateful` via `tests/fuzz/dst/engine.ts` (DDL/DML/txn/UPSERT/FK/checkpoint). |
| 40 | Random schema + grammar-weighted SQL generators | **partial** | major | XL | Expanded area arbs (joins/subqueries/datetime/LIKE/…); not production-weighted grammar. |
| 41 | SQLancer-style TLP / NoREC / metamorphic | **partial** | major | XL | `tests/fuzz/metamorphic/{tlp,norec}.test.ts` — includes join TLP. |
| 42 | Robustness fuzz (never non-SqliteError / hang / corrupt) | **partial** | major | L | `tests/fuzz/robustness.test.ts` (token salad, 5s budget, Dump, SQLM bit-flip → SqliteError). |
| 43 | Fault injection atomicity | **absent** | major | L | None. |
| 44 | Snapshot fuzz invariants (corrupt decoder) | **partial** | major | M | Bit-flip decoder wrapped as SqliteError; deeper adversarial codecs thinner. |
| 45 | Cross-environment determinism (Node/Bun/Deno/browsers/arch) | **absent** | **blocker** for “deterministic everywhere” | L | Proven under Bun; browser/Node/Deno matrix absent. |
| 46 | Soak / corpus persistence nightly | **partial** | minor | M | `.github/workflows/fuzz-soak.yml` + `test:fuzz:soak`; corpus promote script. |
| 47 | `sqllogictest` corpus | **partial** | major | XL | Trimmed vendor under `vendor/sqllogictest/` + differential runner; full upstream tree not ingested. |

---

## H. Browser / no-WASM proof

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 48 | Static purity gate on `dist/` | **partial** | major | M | `scripts/verify-package.ts` bans `node:`/`bun:`/`require`/… — **not** WebAssembly / `.wasm` / `eval` / `new Function` / `SharedArrayBuffer`. |
| 49 | Full contract+DST in real browsers | **absent** | **blocker** | L | `test:browser` = optional perf smoke (`scripts/browser-perf.ts`); **not** in `.github/workflows/ci.yml` or `scripts/ci-local.ts`. README “browser smoke in CI” is **false** relative to current workflow. |
| 50 | Runtime matrix (Node 20/22/24, Deno, Workers, Edge, RN) | **absent** | major | L | CI = Bun 1.3.14 only. |
| 51 | Bundler matrix + size budget in CI | **partial** | major | M | Bundle measured in benchmarks (~79 KB gzip target docs); not full Vite/webpack/Next matrix in CI. |
| 52 | Memory & scale in-browser (100k/1M rows) | **partial** | major | M | Bench budgets exist; not full browser leak/cycle suite. |
| 53 | Perf parity vs sql.js / sqlite-wasm with CI thresholds | **partial** | major | M | `benchmarks/` + compare engines; PERFORMANCE.md notes large slowdowns vs native; browser vs wasm gate thin. |

---

## I. Ecosystem conformance

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 54 | Adapter entry points + upstream suites | **absent** | **blocker** | XL | No `exports` for sql.js/better-sqlite3/…; `ECO-b3-01` only asserts extras **undefined**. |
| 55 | ORM conformance in-browser (Kysely/Drizzle/…) | **partial** | major | XL | Style tests: `integration/kysely-introspection.test.ts`, `orm-crud.test.ts`, catalog ECO-*; **not** upstream Kysely/Drizzle suites or drizzle-kit. |
| 56 | Sync-engine E2E patterns | **absent** | **blocker** | XL | Blocked on §35; `integration/snapshot-sync.test.ts` is SQLM-oriented, not `.sqlite` changeset interchange. |

---

## J. Test-infrastructure gaps

| # | Catalog item | Status | Severity | Effort | Evidence / hole |
| --- | --- | --- | --- | --- | --- |
| 57 | Requirements traceability (`docs/requirements/` ↔ tests) | **partial** | major | L | `compat/requirements.json` + coverage gate exist; not the bidirectional claim-ID system described; README claims not all ID-linked. |
| 58 | Auto-generated `DIVERGENCES.md` | **absent** | minor | S | Hand-maintained JSON + markdown prose; drift risk (`indexed-by-discarded` pin cites COMPATIBILITY.md). |
| 59 | Oracle version matrix in CI | **partial** | major | M | 3.51/3.53 allowed; no multi-binary matrix (CLI / node:sqlite / wasm). |
| 60 | CI layout (PR / merge / nightly tiers) | **partial** | major | M | Single test job `test:sqlite-compat` + benchmarks; no browser/conformance/mutation/nightly soak. |

---

## Ranked top 20 (blocker → major for drop-in claim)

| Rank | ID | Gap | Why it blocks “WASM SQLite drop-in” | Effort |
| --- | --- | --- | --- | --- |
| 1 | 35 | No `.sqlite` read/write | Cannot load server DB or `export()` for upload | XL |
| 2 | 34 | No JS UDFs/collations | Common sql.js / node:sqlite apps break | XL |
| 3 | 54 | No API adapters + upstream suites | Import swap impossible | XL |
| 4 | 49 | No in-browser SQL differential CI | “Runs in browsers” unproven for dialect | L |
| 5 | 37 | ATTACH file → empty | Migrations/sync often ATTACH | L |
| 6 | 33 | No lazy cursor / mid-scan semantics | sql.js stepping model unsupported | L |
| 7 | 24 | `sqlite_master.sql` not byte-compared | ORM migrators diff SQL text | L |
| 8 | P1.1 | No canaries | Suite may be unable to catch regressions | M |
| 9 | 56 | Sync-engine scenarios unreachable | Primary browser SQLite use-case class | XL |
| 10 | 45 | No cross-runtime determinism gate | Float/sort/locale portability unknown | L |
| 11 | 47 | No sqllogictest | Strongest external parity corpus unused | XL |
| 12 | 7 | No grammar coverage metric | “Lots of tests” ≠ production coverage | XL |
| 13 | 41 | No TLP/NoREC oracles | Logic bugs evade random differential | XL |
| 14 | 30 | FTS PARTIAL | Apps using FTS5 advanced features risk | XL |
| 15 | 23 | Multi-statement `exec` counters thin | App scripts trust `changes`/`lastInsertRowid` | M |
| 16 | 1 | Affinity matrix incomplete | Silent type bugs in ORM inserts | L |
| 17 | 26 | PRAGMA behavior smokes | ORM introspector edges | L |
| 18 | 48 | Purity gate incomplete | WASM/`eval` not banned in verify-package | M |
| 19 | P1.2–P1.3 | No mutation / branch thresholds | Dead / untested executor paths | L |
| 20 | 55 | ORM upstream suites absent | “Works with Drizzle/Kysely” unproven | XL |

---

## What *is* relatively strong today

Do not erase this when rewriting claims — narrow the claim to match:

- Large **differential** suite vs `bun:sqlite` (helpers + catalog + fuzz) for core DML/DDL/joins/CTE/FK/triggers/JSON/windows.
- Fail-closed **inventory** / requirements / scenario / smoke-baseline machinery.
- Machine-readable **𝔇** intentional divergences (needs pin hygiene + generated markdown).
- Isomorphic **ESM** build with Node/Bun import bans (`verify-package`).
- Honest README notes on SQLM, deterministic defaults, INDEXED BY, ATTACH file, FTS partial, missing better-sqlite3 extras.

---

## Recommended claim rewrite (for Phase 3 README — not applied yet)

> **Verified:** SQLite **SQL dialect** behavioral parity against `bun:sqlite` 3.51.x/3.53.0 for the `@crvouga/sqlite-mem` sync API, via differential contracts (`bun run test:sqlite-compat`).
>
> **Not a drop-in for:** `sql.js` / `sqlite-wasm` APIs, on-disk `.sqlite` interchange, user-defined functions, lazy statement stepping, or ATTACH of filesystem databases.
>
> **Browser:** package is isomorphic ESM with no WASM dependency; **full dialect suite is not yet executed in browsers in CI.**

---

## Review gate

**Stop here.** Please review:

1. [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) — is the claim surface correct?
2. This file’s **Verdict** and **Top 20** — any severity you disagree with?
3. Whether `.sqlite` I/O (§35) and UDFs (§34) should stay **explicit non-goals** (narrow claim) or become **Phase 2+ product work**.

After approval, Phase 1 starts with canaries + oracle-lint + skip register (prove the suite can fail) before expanding catalog coverage.
