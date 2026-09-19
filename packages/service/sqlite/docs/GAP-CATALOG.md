# Gap Catalog — drop-in proof inventory

**Status:** Phase 0 (2026-08-20). Authoritative inventory of what is *differentially proven* vs *claimed* vs *intentionally different* for `@crvouga/sqlite-mem` as a client-side drop-in for SQLite **3.51.0** (`bun:sqlite`; Linux/Windows may report **3.53.0**).

This file supersedes [`docs/PARITY-GAPS.md`](PARITY-GAPS.md) as the **current** unproven-inventory. PARITY-GAPS remains historical (many of its “LIKELY DIVERGENCE” P0 items were closed in the 2026-08-19 hardening pass — see [Closed since PARITY-GAPS](#closed-since-parity-gaps)).

**Proof vocabulary**

| Label | Meaning |
| --- | --- |
| **Proven** | Differential (`parity` / `execParity` / `errorParity` / `sequenceParity` / fuzz) covers happy path **and** meaningful edges vs oracle |
| **Thin** | Some differential; important app forms still missing |
| **Unproven** | Implemented or claimed; no oracle proof (or only ISOLATED `new Database()`) |
| **Intentional** | Documented in [`compat/divergences.json`](../compat/divergences.json) / README; proof = limitation pin, not oracle equality |
| **N/A** | Outside Scope 3 (C API, on-disk `.sqlite`, VFS/pager/WAL) |

**Severity** (drop-in readiness, not “invented bugs”)

| Severity | Meaning |
| --- | --- |
| **blocker** | Browser first-class claim without in-browser SQL proof, or marketed VERIFIED surface with no differential on a user path |
| **high** | Thin/unproven app-SQL or API edges (ORM, binds, counters, txn+snapshot simulation) |
| **medium** | Exotic / PARTIAL areas (FTS edges, window options, date modifiers) |
| **low** | Smoke ratchet leftovers, extensions, planner essays |

**Authoritative gate:** `bun run test:sqlite-compat`. Isolated unit tests are never SQLite proof.

---

## Closed since PARITY-GAPS

Do **not** reopen these as gaps. Differential evidence exists:

| Former “LIKELY DIVERGENCE” | Evidence |
| --- | --- |
| Comparison affinity | [`tests/contract/types/comparison-affinity.test.ts`](../tests/contract/types/comparison-affinity.test.ts) |
| TRUE / FALSE / IS TRUE / IS FALSE | [`tests/contract/expressions/boolean-literals.test.ts`](../tests/contract/expressions/boolean-literals.test.ts), `EXP-bool-*` |
| `weekday N` | [`tests/contract/date-time/weekday.test.ts`](../tests/contract/date-time/weekday.test.ts) |
| REGEXP → missing `regexp()` | [`tests/contract/expressions/regexp.test.ts`](../tests/contract/expressions/regexp.test.ts) |
| WITH on UPDATE / DELETE | [`tests/contract/cte/dml-with.test.ts`](../tests/contract/cte/dml-with.test.ts), fuzz `cte.test.ts` |
| INSTEAD OF triggers | [`tests/contract/triggers/instead-of.test.ts`](../tests/contract/triggers/instead-of.test.ts) |
| OR FAIL / OR ROLLBACK | [`tests/contract/conflicts/or-modes.test.ts`](../tests/contract/conflicts/or-modes.test.ts) |
| Plain IPK rowid reuse | [`tests/contract/rowid/reuse.test.ts`](../tests/contract/rowid/reuse.test.ts) |
| Trigger-visible `last_insert_rowid` | [`tests/contract/triggers/rowid.test.ts`](../tests/contract/triggers/rowid.test.ts) |
| `PRAGMA case_sensitive_like` | [`tests/contract/expressions/like-glob-gaps.test.ts`](../tests/contract/expressions/like-glob-gaps.test.ts) |
| INDEXED BY missing-index pin | [`tests/contract/indexes/indexed-by.test.ts`](../tests/contract/indexes/indexed-by.test.ts) |
| Snapshot omissions (triggers / ATTACH / FTS / user_version) | `SNP-omit-01`…`04` in [`tests/contract/catalog/snp.test.ts`](../tests/contract/catalog/snp.test.ts) |
| Simple-select partial-index WHERE (residual conjuncts) | [`tests/contract/select/partial-index-where.test.ts`](../tests/contract/select/partial-index-where.test.ts), [`tests/fuzz/simple-select-where.test.ts`](../tests/fuzz/simple-select-where.test.ts) |
| Integer `+`/`-`/`*` i64 overflow → REAL | [`tests/contract/expressions/integer-overflow.test.ts`](../tests/contract/expressions/integer-overflow.test.ts), fuzz `expressions.test.ts` |
| `randomblob` / `zeroblob` SQLITE_TOOBIG | [`tests/contract/limits/toobig.test.ts`](../tests/contract/limits/toobig.test.ts) |
| FTS5 prefix `*` parse error (oracle message) | [`tests/contract/fts/parse-errors.test.ts`](../tests/contract/fts/parse-errors.test.ts) |
| Dual-path fast ≡ full (simple SELECT / INSERT) | [`tests/fuzz/fast-path.test.ts`](../tests/fuzz/fast-path.test.ts) |
| LEFT JOIN TLP metamorphic | [`tests/fuzz/metamorphic/tlp.test.ts`](../tests/fuzz/metamorphic/tlp.test.ts) |
| Mixed DST with FTS ops (outcome compare; no checkpoint) | [`tests/fuzz/dst/ops.ts`](../tests/fuzz/dst/ops.ts), `mixed-stateful.test.ts` |

---

## Master gap table

Columns: Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type

### Core DML / DDL

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| CREATE / DROP TABLE / INDEX / VIEW | Schema + IF EXISTS/NOT EXISTS | Proven — `tests/contract/schema/`, `ddl-if/`, `indexes/`, `views/`, catalog `DDL-*` / `PAR-*` | low | Named-constraint edge names; IF NOT EXISTS race-like sequences | differential |
| ALTER TABLE | ADD/DROP/RENAME column (SQLite limits) | Proven — `tests/contract/alter-table/*` | low | DROP generated column; RENAME TABLE deeper | differential |
| INSERT / UPDATE / DELETE | Standard DML + conflicts | Proven — `insert/`, `update/`, `delete/`, `conflicts/` incl. `statement-atomicity` + `or-constraint-grid`, fuzz `conflicts.test.ts` | low | DELETE OR (not in bun:sqlite) | differential |
| UPSERT | ON CONFLICT DO UPDATE/NOTHING, targets, WHERE | Thin — `upsert/*`, `upsert/thin-gaps.test.ts`, fuzz | medium | `OR IGNORE`/`OR REPLACE` vs UPSERT same table; AUTOINCREMENT + `last_insert_rowid`; `excluded.*`; WITHOUT ROWID; `ON CONFLICT(rowid)` | differential |
| RETURNING | INSERT/UPDATE/DELETE RETURNING | Proven — `returning/`, UPSERT RETURNING in thin-gaps | low | `RETURNING` excluded / `old`/`new` names | differential |
| UPDATE FROM | Join source into UPDATE | Thin — one INNER in `update-from/basic.test.ts` | medium | Multi-match, LEFT FROM, correlated FROM | differential |
| CREATE TABLE AS / STRICT / WITHOUT ROWID | Supported | Proven — `create-table-as/`, `schema/strict`, `without-rowid/` | low | — | — |
| ANALYZE / REINDEX / VACUUM | `:memory:` observable no-ops / sqlite_stat1 | Thin — `misc/analyze-vacuum`, COMPATIBILITY VERIFIED | low | VACUUM INTO ignore pin; REINDEX collation | intentional pin + differential |

### Expressions / operators / affinity / collations

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Arithmetic / logic / CASE / CAST | Full expr surface | Proven — `expressions/`, matrices `m1`/`m2` | low | Hex integer literals `0x…` | differential |
| Comparison affinity | Column affinity on `=` / IN / WHERE | Proven — `types/comparison-affinity.test.ts` | — | — | — |
| Affinity matrix | Declared type × insert/CAST/UNION/INSERT SELECT | Proven — `types/affinity-matrix.test.ts`, fuzz `affinity-dml.test.ts` | low | Subquery projection of REAL wrappers | differential |
| LIKE / GLOB / ESCAPE | ASCII CI unless `case_sensitive_like` | Thin — `like-glob-gaps.test.ts` | medium | LIKE vs column `COLLATE BINARY`; multi-char ESCAPE | differential |
| REGEXP | Calls missing `regexp()` → error | Proven (error parity) — `expressions/regexp.test.ts` | intentional | Document “no regexp() builtin” as oracle-matching absence | intentional pin |
| IS / IS DISTINCT FROM / boolean | NULL-safe + TRUE/FALSE | Proven — `null/`, `boolean-literals`, `distinct-from` | low | postfix ISNULL/NOTNULL; IS on BLOBs | differential |
| COLLATE NOCASE/RTRIM/BINARY | Comparisons, indexes, GROUP/JOIN | Thin — `collate/*`, `collate/thin-gaps` | medium | `UNIQUE COLLATE` constraint form; COLLATE on generated; RTRIM UNIQUE | differential |
| Row values / `->` `->>` | Supported | Proven — `row-values/`, `json/operators` | low | — | — |
| `NOT IN (SELECT …)` NULL trap | NULL in subquery → unknown | Thin — list-form only in `null/edges.test.ts`; empty subquery `EXP-in-02` | high | `NOT IN (SELECT …)` with NULL rows | differential |
| Comma joins | `FROM a, b` ≡ CROSS JOIN | Proven — catalog `JOI-*` | low | — | — |

### Functions (core / date / aggregate / window / JSON / math / string)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Inventory names | All oracle builtins present | Proven — inventory gate + `functions/inventory.test.ts` | — | Name presence ≠ behavioral parity | — |
| Core scalars | abs, typeof, printf, … | Thin — `functions/scalar|edges|more|scope3` | medium | soundex, unistr*, format flags, likelihood edges | differential / fuzz |
| Date/time | date/time/datetime/strftime/modifiers | Proven — `date-time/*` incl. `invalid.test.ts` | low | timezone offsets beyond intentional `localtime`/`utc` no-ops | differential |
| `timediff` / `julianday` / `unixepoch` | Oracle calendar rules | Thin — catalog has samples (`DAT-fn-04`, `DAT-fn-07`) | medium | Broader modifier matrix vs oracle | differential |
| Aggregates + FILTER | count/sum/avg/… + FILTER | Proven — `aggregates/`, window FILTER in thin-gaps | low | — | — |
| Windows (frames / EXCLUDE) | ROWS/RANGE/GROUPS + EXCLUDE | Thin — `window-functions/*`, fuzz `windows.test.ts` | medium | `IGNORE NULLS` / `RESPECT NULLS`; deeper `nth_value`; window in WHERE must fail; `BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING` | differential |
| JSON1 / JSONB | Full JSON1 surface | Thin — `json/*`, `json/thin-gaps`, fuzz | medium | JSON agg FILTER; `json_valid` JSONB flags; `json_pretty` indent; `jsonb_replace` / `jsonb_group_object`; TVF on SQL NULL | differential |
| Math / ieee754 | ENABLE_MATH_FUNCTIONS | Thin — scope3 + scalar samples | medium | acosh/asinh/atan2; NaN→NULL; ieee754 pair | differential / fuzz |
| UUID | `uuid` / `uuid_str` / `uuid_blob` | Unproven — inventory name only; **no** contract | medium | Behavior vs oracle (entropy) → likely intentional pin with seeded PRNG | intentional pin + differential shape |
| `generate_series` | Not in default bun:sqlite | Intentional extension — ISOLATED `table-valued/basic.test.ts`; oracle lacks name (`pragma/inventory-sets.test.ts`) | low | Pin as sqlite-mem-only; do not claim oracle parity | intentional pin |

### Transactions / savepoints / PRNG

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| BEGIN/COMMIT/ROLLBACK/SAVEPOINT | Nested savepoints | Proven — `transactions/*`, `savepoints/`, fuzz `transactions.test.ts` | low | BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE success parity (locking N/A) | differential |
| ROLLBACK restores PRNG | Seeded random rewound | Proven — `determinism/basic.test.ts` (ISOLATED for PRNG; data via sequenceParity) | low | Differential PRNG+data combined under savepoints | property + differential |
| `random: "os"` not rewound | CSPRNG persists across ROLLBACK | Proven — `determinism/sqlite-like.test.ts` | intentional | — | — |
| Long stateful scripts | Multi-step DDL/DML/txn | Thin — `transactions/stateful.test.ts` (fixed script); fuzz stateful is DML-only | high | Full mixed DDL+DML+txn+snapshot+PRAGMA simulator with seed+path replay | simulation |

### Constraints (PK / UNIQUE / CHECK / FK / NOT NULL)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| PK / UNIQUE / NOT NULL / CHECK | Enforce + categories | Proven — `primary-keys/`, `unique/`, `check/`, `constraints/`, fuzz | low | `constraint_primary` vs `constraint_unique` category on IPK | errorParity |
| Foreign keys | Immediate + deferred + actions | Proven — `foreign-keys/*`, `foreign-keys/match.test.ts` (MATCH FULL≡SIMPLE as oracle) | low | FK to UNIQUE not PK; deeper deferred mid-txn | differential |
| Generated columns | STORED/VIRTUAL | Proven — `generated/basic.test.ts` + fuzz UNIQUE on generated | low | Deeper `table_xinfo` hidden flags | differential |

### Indexes

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Partial / expression / prefix | Correct results + uniqueness | Proven — `indexes/partial|expression|prefix` + fuzz `indexes.test.ts` | low | DESC/COLLATE in expr index depth | differential |
| INDEXED BY / NOT INDEXED | Oracle errors on missing index | Intentional no-op — `indexes/indexed-by.test.ts` pins missing-index divergence | intentional | Ensure `divergences.json` `indexed-by-discarded` cites the pin tests (today cites COMPATIBILITY.md only) | intentional pin hygiene |
| Covering / planner | Not observable beyond results | N/A for plan text; results Proven | low | — | — |

### Views / CTEs

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Views | CREATE/DROP + INSTEAD OF | Proven — `views/basic`, `views/with.test.ts` | low | — | differential |
| Non-recursive CTE | WITH / nested / shadowing | Proven — `cte/*`, fuzz | low | mixed recursive+non-recursive | differential |
| Recursive CTE | UNION/UNION ALL, LIMIT/ORDER | Proven — `recursive-cte/*` | low | VALUES + recursive mix | differential |
| MATERIALIZED hints | Both paths materialize | Intentional — `cte/thin-gaps.test.ts`, `CTE-mat-01` | intentional | — | — |

### Subqueries

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| EXISTS / IN / correlated | Scalar + EXISTS | Thin — `subqueries/*` | high | `NOT IN (SELECT)` NULL trap; multi-row scalar error; empty IN select edges | differential |

### JOINs

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| INNER / LEFT / RIGHT / FULL / CROSS / NATURAL | Null-extension + USING/ON | Proven — `joins/*`, catalog `JOI-*` | medium | Multi-column USING; NATURAL FULL edges | differential |

### Window functions

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Core + frames + EXCLUDE + FILTER | As COMPATIBILITY VERIFIED | Thin — frames/exclude/thin-gaps | medium | IGNORE/RESPECT NULLS; nth_value depth; illegal window in WHERE | differential |

### Triggers

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| BEFORE/AFTER/INSTEAD OF / RAISE | FOR EACH ROW | Proven — `triggers/*` | medium | `recursive_triggers` PRAGMA (recursion always on); FK+trigger interactions | differential |
| Snapshot of triggers | Not in SQLM | Intentional — `SNP-omit-01` | intentional | — | — |

### FTS3 / FTS4 / FTS5

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| MATCH / tokenizers / bm25 / highlight / snippet | Core surface | Thin / PARTIAL — `fts/*`, fuzz `fts.test.ts` | medium | Exhaustive matchinfo formats; external-content backfill; advanced trigger maintenance | differential / fuzz |
| Shadow-table `changes()` | Oracle shadow writes inflate changes | Intentional — `fts/changes.test.ts`, `FTS-chg-01` | intentional | — | — |
| fts3tokenize / fts4aux | CREATE stubs | Thin — comprehensive FTS tests | medium | Behavior beyond CREATE success | differential |
| `FTS-series-01` catalog | Construct ID | Smoke — `SELECT 1 AS v` in `catalog/fts.test.ts` | low | Promote to real FTS construct | differential |
| Snapshot of FTS | Not in SQLM | Intentional — `SNP-omit-03` | intentional | — | — |

### Virtual tables / TVFs / pragma_* TVFs

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| rtree / dbstat / bytecode / tables_used | Oracle modules | Proven (stubs where documented) — `modules/scope3-modules.test.ts` | low | — | — |
| `json_each` / `json_tree` | TVFs | Proven — `json/tvf-*` | medium | TVF on SQL NULL document | differential |
| All `pragma_*` eponymous TVFs | Correlated args (Kysely) | Proven — `pragma/tvf.test.ts`, `PRG-tvf-01` | low | — | — |
| `generate_series` | Extension | Unproven vs oracle (N/A) — ISOLATED | low | Intentional extension pin | intentional pin |

### PRAGMA surface (ORM-critical)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| table_info / table_xinfo / table_list / index_* / foreign_key_* / database_list | Introspection | Proven — `pragma/schema|basic|tvf`, integration Kysely | low | — | — |
| case_sensitive_like | Affects LIKE | Proven — like-glob-gaps | low | Snapshot exclusion of flag (not in SQLM) | intentional pin |
| compile_options / function_list | Content is engine’s | Intentional — inventory-sets + catalog | intentional | — | — |
| Storage pragmas | `:memory:` defaults | Thin — sampled getters | low | Writer no-op pins | intentional pin |
| `PRG-beh-01`…`07` catalog | Behavior constructs | Smoke — `SELECT 1 AS v` | medium | Replace smoke with real PRAGMA behavior SQL | differential |
| Unknown PRAGMA | Empty result | Proven — `PRG-unk-01` | low | — | — |

### ATTACH / DETACH

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| In-memory ATTACH | Second schema | Proven — `attach/basic.test.ts` | low | temp vs main same name | differential |
| ATTACH file path | File contents loaded | Intentional empty schema — `attach/file.test.ts`, `ATT-att-01` | intentional | — | — |
| Snapshot of ATTACH | Not restored | Intentional — `SNP-omit-02` | intentional | — | — |

### Parameter binding

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| `?` / `:name` / `@name` / `$name` | Slot order; prefixes distinct | Proven — `parameters/basic|edges`, audit | low | — | — |
| `?NNN` numbered | Reorder by index | Thin — ISOLATED only in `catalog/api.test.ts` (`?2`,`?1`) | high | Differential `?NNN` vs oracle | differential |
| Too many / too few binds | Error | Proven — `api/freeze.test.ts` matrixBoth | low | — | — |
| Reject NaN / Infinity / undefined / Date / DataView | datatype_mismatch / misuse | Thin — catalog `TYP-nan-*`, freeze ISOLATED for DataView; divergence `nan-infinity-bind` | high | Full rejection matrix vs oracle where comparable; API-only pins for JS types oracle cannot bind | differential + intentional pin |
| No sticky `bind()` / no named-object bind | API design | Proven — freeze + readme-pitfalls | intentional | — | — |

### Prepared statements / counters / exec

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| prepare / run / all / get / result | Single-statement | Proven — `api/basic`, schema-invalidation | low | — | — |
| Multi-statement `exec` | Runs all; discards rows | Proven ok — `api/basic` | high | Differential `changes` / `lastInsertRowid` / `total_changes` after multi-statement scripts (README: most recent statement) | differential |
| `total_changes()` | Exact cumulative | Thin — scope3 uses `>= 2` | medium | Exact parity vs oracle after sequences | differential |
| Schema invalidation | Re-prepare after ALTER/DROP | Proven — `api/schema-invalidation`, integration prepared-reuse | low | RENAME / DROP COLUMN edges | differential |

### Error categories / codes

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| syntax / no_such_* / constraint_* | Category (+ Tier A/B message) | Thin — `errors/*`, catalog `ERR-*` | high | Full bind garbage categories; CHECK on UPDATE; generated insert; MATCH non-FTS vs oracle category; empty SQL `misuse` differential category | errorParity |
| Failed UNIQUE leaves prior rows | Atomic statement | Proven — `errors/state.test.ts` | low | — | — |
| EXPLAIN stubs | Shape only | Intentional — `errors/explain.test.ts` | intentional | — | — |

### Snapshot / restore (SQLM)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Logical round-trip tables/views/indexes/counters/PRNG/clock | Custom SQLM (not `.sqlite`) | Proven — `snapshots/`, `catalog/snp.test.ts`, integration snapshot-sync | intentional | — | — |
| Omissions: triggers, ATTACH, vtabs, user_version | Not encoded | Proven pins — `SNP-omit-*` | intentional | `case_sensitive_like` omission pin | intentional pin |
| restore during txn | Rejected | Proven — `SNP-txn-01` | low | — | — |
| Format version / corrupt magic | Errors | Proven — `SNP-hdr-*` | low | — | — |

### Determinism

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Seeded random / fixed now | Default deterministic | Proven — `determinism/*`, catalog `DET-*` | intentional | — | — |
| `-0` → `+0` | Canonicalization | Proven — catalog `TYP-negzero-*`, DET | intentional | — | — |
| Row order after restore | Rowid order | Proven — snapshots preserve rowids | low | — | — |
| Fuzz seed / path replay | `0x5a17e0e1` + `SQLITE_MEM_FUZZ_PATH` | Proven — fuzz suite | low | Extend to simulation harness | simulation |

### Browser / package / example

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Pure ESM, no `node:`/`fs` on public path | Isomorphic package | Proven pack gate — `scripts/verify-package.ts` (dist bans `node:`/`bun:`) | — | — | — |
| In-browser SQL dialect parity | Same SQL → same results | **none** — no Playwright SQL suite; `test:browser` is optional perf smoke (`scripts/browser-perf.ts`) and is **not** in `check:full` or `.github/workflows/ci.yml` | blocker | Real-browser smoke + fixture differential (pre-recorded oracle JSON when Node unavailable) wired into CI | browser differential |
| React+Vite example | Exercises binds, multi-statement, txn, snapshot | Thin — snapshot/restore + binds in `examples/react-vite`; `runSql` uses `prepare` (single-statement) so multi-statement sample “Insert user” fails; no `transaction()` sample | high | Example + browser suite covering exec multi-statement, binds, transactions, snapshot | simulation / browser |

### Catalog smoke ratchet

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Smoke IDs in `compat/smoke-baseline.json` | Construct catalog must not stay smoke forever | Smoke — `CON-fk-09`, `DDL-auto-03`, `FTS-series-01`, `LIM-vals-01`, `PRG-beh-01`…`07` | medium | Promote each ID to real SQL (ratchet downward) | differential |

### Proof-system gaps (meta)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| Deterministic simulation harness | Long mixed sequences + snapshot + nested savepoints + PRAGMA | Proven (partial) — `tests/fuzz/dst/` + `mixed-stateful` (UPSERT/FK/trigger/RETURNING/ATTACH/FTS/schema variants) | medium | DROP/RENAME COLUMN dump parity in mixed arb; broader schema mutation | simulation |
| Expression / schema / query / bind / error fuzz expansion | Broad adversarial coverage | Proven (partial) — joins/subqueries/datetime/LIKE/windows/json/affinity-binds/triggers/generated/FK/counters; i64 overflow / TOOBIG edges | medium | Grammar-weighted generators | fuzz |
| Metamorphic oracles | TLP / NoREC | Proven (partial) — `tests/fuzz/metamorphic/` incl. INNER + LEFT join TLP | medium | FULL OUTER TLP; larger multi-join | metamorphic |
| Dual-path executor parity | Fast vs full SELECT/INSERT must agree | Proven — `tests/fuzz/fast-path.test.ts` (`ExecutionEnv.forceFullSelect` / `forceFullInsert`) | low | Extend to UPDATE/DELETE fast paths if added | property |
| SQLLogicTest | External corpus | Proven (partial) — trimmed `vendor/sqllogictest/` | medium | Larger upstream ingest | corpus |
| Property invariants without oracle | Snapshot≡restore; rollback PRNG; counters | Partial — ISOLATED determinism + snapshot + robustness bit-flip | medium | More README invariants | property |
| Fail-closed for claimed-but-unproven | Inventory + requirements gate | Proven for oracle names / requirements unknown=0 | medium | Optionally fail on smoke-baseline growth; browser gate | gate |
| Nightly soak | Multi-seed long runs | Proven — `fuzz-soak.yml` + `test:fuzz:soak` | — | — | soak |

### N/A (mission non-goals)

| Area | SQLite 3.51 behavior | Current coverage | Severity | What proof is missing | Suggested test type |
| --- | --- | --- | --- | --- | --- |
| On-disk `.sqlite` / C API / VFS / WAL / URI filenames | File format & C API | N/A — COMPATIBILITY | — | Keep NOT APPLICABLE; remap stale `uri.html` UNSUPPORTED → N/A in coverage hygiene | docs |
| better-sqlite3 extras | iterate/pluck/raw/safeIntegers/… | Intentional absent — `js-api-surface` | intentional | — | — |

---

## Intentional limitation pins

Machine-readable source: [`compat/divergences.json`](../compat/divergences.json).

| Divergence ID | Pin status | Evidence |
| --- | --- | --- |
| `oracle-platform-sqlite-version` | pinned | `tests/harness/oracle-version.test.ts`, gate |
| `snapshot-sqlm` | pinned | `SNP-hdr-01`, `SNP-rt-01` |
| `deterministic-random-now` | pinned | `DAT-now-01`, `DET-seed-01` |
| `negzero-canonicalization` | pinned | `TYP-negzero-*`, `DET-negzero-01` |
| `attach-empty-schema` | pinned | `ATT-att-01`, `attach/file.test.ts` |
| `explain-stub` | pinned | `PAR-explain-01`, `errors/explain.test.ts` |
| `indexed-by-discarded` | pinned in tests; **JSON cites COMPATIBILITY.md only** | `indexes/indexed-by.test.ts` — update `pinnedBy` |
| `materialized-hint-ignored` | pinned | `CTE-mat-01`, `cte/thin-gaps.test.ts` |
| `fts-shadow-counters` | pinned | `FTS-chg-01`, `fts/changes.test.ts` |
| `compile-options-function-list` | pinned | `PRG-comp-01`, `PRG-fn-01`, inventory-sets |
| `js-api-surface` | pinned | `API-ret-03`, readme-pitfalls |
| `snapshot-exclusions` | pinned | `SNP-omit-01`…`04`, TRG/ATT/FTS snap catalog |
| `json-api-unwrap` | pinned | `JSN-sub-03` |
| `nan-infinity-bind` | pinned | `TYP-nan-04`, `TYP-nan-05` |
| `double-quote-string-fallback` | pinned | `TOK-07` |
| `lone-surrogate-bind` | pinned | `UNI-surr-01` |
| `user-version-snapshot` | pinned | `SNP-omit-04`, `PRG-beh-05` (smoke — strengthen) |

**Candidate intentional pins to add (after tests):** `generate_series` extension; UUID seeded vs oracle entropy; `case_sensitive_like` not in SQLM; REGEXP without `regexp()` builtin (already error-parity).

---

## Next proof obligations (blocker → high)

Ordered after 2026-08-21 core SQL dialect proof wave (see [PROOF.md](PROOF.md)):

1. **medium — Implement pragma setters** for `defer_foreign_keys` / `recursive_triggers` / `application_id` (currently pinned no-ops).
2. **medium — Deepen FTS** remaining PARTIAL edges toward VERIFIED.
3. **major (WASM claim only) — `.sqlite` codec, UDFs, API adapters** — product work, not dialect tests.
4. **major — sqllogictest / multi-oracle / full in-browser contract** — external corpora and runtime matrix.
5. **docs — Keep GAP-ANALYSIS Phase 0 tables in sync** with PROOF.md (several P1/meta items already closed).

### Closed since prior “Next proof obligations” list

Browser SQL smoke in CI; `?NNN`; `NOT IN (SELECT)` NULL trap; multi-`exec` counters; bind rejection pins; error/subquery depth; UPSERT/UPDATE FROM/windows/JSON/date/collate/FK+trigger edges; mixed stateful simulation; smoke-baseline emptied; affinity/bind/malformed fuzz + determinism properties; **affinity combinatorial matrix**; **statement ABORT + OR×constraint grid**; **FK MATCH**; **views WITH + view DML reject**; **invalid date edges**; **indexes/conflicts/affinity-dml/generated fuzz**.


---

## How to re-verify this catalog

```bash
bun run test:sqlite-compat   # fail-closed gate + contract/fuzz/harness
bun run inventory            # oracle function/module names
bun run scenarios            # construct catalog
bun run build && bun run verify-package  # isomorphic ESM
# Browser dialect suite: not yet (Phase 2). Optional perf: bun run test:browser
```

When closing a row: change severity notes to **Proven**, cite `file:test` or catalog ID, and update [`COMPATIBILITY.md`](../COMPATIBILITY.md) / [`COMPATIBILITY-AUDIT.md`](../COMPATIBILITY-AUDIT.md) only with evidence.
