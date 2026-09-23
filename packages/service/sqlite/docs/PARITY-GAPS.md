# Differential parity gaps

**Superseded for current inventory:** use [`docs/GAP-CATALOG.md`](GAP-CATALOG.md) (Phase 0, 2026-08-20). This file remains a historical P0 probe list; many “LIKELY DIVERGENCE” items below were closed in the 2026-08-19 hardening pass — see GAP-CATALOG “Closed since PARITY-GAPS”.

Construct-level coverage now lives in [`compat/scenarios.ts`](../compat/scenarios.ts). Run `bun run scenarios` for mapped vs promoted sections. IDs are `TOK-01`, `WIN-frame-04`, …; tests live under [`tests/contract/catalog/`](../tests/contract/catalog/).

Parity is proven **only** by `parity` / `execParity` / `errorParity` / `sequenceParity` / `matrixBoth` against `bun:sqlite` (and `divergence()` for README-specified differences). Isolated `new Database()` tests do not count for SQL dialect IDs.

Do not mark a [COMPATIBILITY.md](../COMPATIBILITY.md) row **VERIFIED** from page-level `SOURCE_SEED` alone.

**Session:** Goal 1.1 coverage audit (2026-08-18), plus construct catalog (2026-08-19).

## Legend

| Label | Meaning |
| --- | --- |
| **COVERED** | Differential happy path **and** meaningful edges vs oracle |
| **THIN** | Some differential tests; important real-app forms missing |
| **GAP** | No differential test |
| **ISOLATED** | sqlite-mem-only unit test; not oracle proof |
| **LIKELY DIVERGENCE** | Implementation suggests mismatch; add a failing contract before fixing |
| **P0** | Likely in application SQL |
| **P1** | Less common |
| **P2** | Exotic, or already documented as partial |

Checked items (`[x]`) are already differentially covered. Unchecked items are work remaining.

## Method

[COMPATIBILITY.md](../COMPATIBILITY.md) and `compat/coverage.json` mark large areas **VERIFIED** via page-level `SOURCE_SEED` in [`scripts/sqlite-requirements.ts`](../scripts/sqlite-requirements.ts) (for example `lang_insert.html` → `tests/contract/insert/` + `tests/contract/upsert/`). That is **directory existence**, not construct-level coverage.

Current matrix (`compat/coverage.json`): 1901 SQL_BEHAVIOR requirements → 1372 VERIFIED / 351 PARTIALLY_VERIFIED / 178 UNSUPPORTED. UNSUPPORTED is mostly unmapped sqlite.org pages:

| Page | Count | Notes |
| --- | --- | --- |
| `optoverview.html` | 114 | Query planner essay — N/A for observable SQL results |
| `uri.html` | 42 | URI filenames — mission says NOT APPLICABLE, coverage says UNSUPPORTED |
| `deterministic.html` | 11 | Function determinism flags |
| `vtab.html` | 5 | Virtual-table C API |
| `dbstat.html` | 2 | Module exists (`tests/contract/modules/scope3-modules.test.ts`) |
| `whynotgit.html` / `undoredo.html` / `isolation.html` / `lang.html` | 1 each | Essays / index pages, not dialect |

`SOURCE_SEED` also keys pages the sqlite.org dump never ingested, so they never appear in `coverage.json` even when COMPATIBILITY.md claims them: `fts5.html`, `json1.html`, `windowfunctions.html`, `lang_with.html`, `rowvalue.html`, `expridx.html`, `nulls.html`. Some VERIFIED notes in `coverage.json` are stale vs current seed (e.g. “RTREE pending”).

**LIKELY DIVERGENCE** items are hypotheses (missing or approximate implementation). Probe with a failing contract first, then fix or document.

Inventory (`tests/contract/functions/inventory.test.ts`) proves **name presence** of oracle builtins, not behavioral parity.

---

## Next probes (P0 LIKELY DIVERGENCE)

Work these first: failing differential contract, then fix or document. Ordered by likelihood of appearing in real app SQL.

1. **Comparison affinity** — `1 = '1'`, `WHERE int_col = '1'` (`compareSql` by storage class; no affinity on `=`)
2. **SQL `TRUE` / `FALSE` literals** and `IS TRUE` / `IS FALSE` (not in lexer; `IS TRUE` becomes column `TRUE`)
3. **`NOT IN (SELECT …)` NULL trap**
4. **rowid reuse after DELETE** on plain INTEGER PRIMARY KEY — **`nextRowid` never decreases**; behaves like AUTOINCREMENT. SQLite without AUTOINCREMENT reuses max+1 after deleting the highest rowid
5. **`weekday N` date modifier** (`applyModifier` returns null)
6. **`generate_series` vs oracle** (currently ISOLATED)
7. **`REGEXP`** (lexer keyword; parser never consumes it → syntax error)
8. **`WITH` on `UPDATE` / `DELETE` / `INSERT … VALUES`** (AST has `with`; only `INSERT … SELECT` threads it)
9. **`last_insert_rowid()` inside AFTER INSERT triggers** — outer insert’s rowid is recorded *after* triggers fire
10. **INSTEAD OF triggers never fire**; `INSERT INTO view` → `no_such_table`

---

## P0 — app-code areas

### 1. UPSERT — THIN

Evidence: [`tests/contract/upsert/`](../tests/contract/upsert/), [`tests/fuzz/upsert.test.ts`](../tests/fuzz/upsert.test.ts)

- [x] `ON CONFLICT(pk) DO UPDATE SET … = excluded.…` and current-row arithmetic
- [x] `DO NOTHING` with explicit target (PK + composite UNIQUE)
- [x] Composite conflict target; secondary UNIQUE still enforced during PK upsert
- [x] Partial unique index: `ON CONFLICT DO NOTHING` and `ON CONFLICT(email) WHERE … DO UPDATE`
- [x] Expression unique index `ON CONFLICT(lower(email))`
- [x] UPSERT + `RETURNING`
- [x] `DO UPDATE … WHERE` (skip update if predicate false)
- [x] `INSERT … SELECT … ON CONFLICT`
- [x] `ON CONFLICT` with no target on a table that has multiple unique constraints
- [ ] `INSERT OR IGNORE` / `OR REPLACE` vs UPSERT on the same table (conflict oracles exist separately in [`tests/contract/conflicts/`](../tests/contract/conflicts/))
- [ ] UPSERT against INTEGER PRIMARY KEY AUTOINCREMENT + `last_insert_rowid`
- [ ] `excluded.*` star; UPSERT + WITHOUT ROWID; `ON CONFLICT(rowid)`

### 2. CTEs — THIN

Evidence: [`tests/contract/cte/`](../tests/contract/cte/), [`tests/contract/recursive-cte/`](../tests/contract/recursive-cte/), [`tests/fuzz/cte.test.ts`](../tests/fuzz/cte.test.ts)

- [x] Non-recursive WITH, multiple CTEs, CTE shadowing a table
- [x] Recursive UNION ALL sequences; UNION cycle dedup; >1000 steps
- [x] `MATERIALIZED` / `NOT MATERIALIZED` are stored on the `Cte` AST and syntax/result parity is covered, but both hints currently execute through the materialized CTE path (documented; `tests/contract/cte/thin-gaps.test.ts`)
- [ ] **LIKELY DIVERGENCE:** `WITH` on `UPDATE` / `DELETE` / `INSERT … VALUES` — AST has `with`, but [`executeUpdate`](../src/executor/dml.ts) / [`executeDelete`](../src/executor/dml.ts) never call `executeWith`. Only `INSERT … SELECT` threads `stmt.with` into the select
- [x] Recursive CTE `LIMIT` / `ORDER BY` (SQLite search-limit)
- [x] Nested WITH
- [ ] CTE referenced from a view; VALUES + recursive mix
- [x] `INSERT INTO t SELECT * FROM cte`; column-count mismatch `errorParity`
- [ ] Mixed recursive + non-recursive CTEs

### 3. Window functions — THIN

Evidence: [`tests/contract/window-functions/`](../tests/contract/window-functions/), [`tests/fuzz/windows.test.ts`](../tests/fuzz/windows.test.ts)

- [x] `row_number` / `rank` / `dense_rank` / `lag` / `lead` / running `sum`
- [x] Named `WINDOW`; ROWS `n PRECEDING/FOLLOWING`; default peer frame
- [x] `EXCLUDE NO OTHERS|CURRENT ROW|GROUP|TIES` (ROWS + one RANGE)
- [x] `ntile` / `cume_dist` / `percent_rank` — one query in [`tests/contract/functions/scope3-builtins.test.ts`](../tests/contract/functions/scope3-builtins.test.ts)
- [x] Aggregate `FILTER (WHERE …)` (non-window) in [`tests/contract/aggregates/edges.test.ts`](../tests/contract/aggregates/edges.test.ts)
- [x] `GROUPS` frames with numeric `PRECEDING` / `FOLLOWING` peer-group offsets
- [x] `RANGE BETWEEN n PRECEDING AND m FOLLOWING` (numeric offsets)
- [x] Window `FILTER (WHERE …)` (`sum(x) FILTER (WHERE …) OVER (…)`)
- [x] `lag`/`lead` with offset + default
- [ ] `nth_value` beyond the one `first/last/nth` test
- [ ] `IGNORE NULLS` / `RESPECT NULLS` (SQLite 3.51 window option)
- [x] Empty `OVER ()`
- [ ] Window in WHERE (must fail); `BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING`

### 4. JSON1 — mostly COVERED, a few holes

Evidence: [`tests/contract/json/`](../tests/contract/json/), [`tests/fuzz/json.test.ts`](../tests/fuzz/json.test.ts)

- [x] `json` / extract / set/insert/replace/remove/patch / quote / type / valid / error_position / pretty
- [x] `->` / `->>`; jsonb encode + mutate; `json_each` / `json_tree`; `json_group_array/object`
- [x] `json_array_insert` middle + nested — **conditional** `parity` if oracle has the name; plus ISOLATED memory-only tests in [`tests/contract/json/modify.test.ts`](../tests/contract/json/modify.test.ts)
- [x] `json_group_array(expr ORDER BY …)`
- [ ] JSON aggregate `FILTER`
- [x] `json_valid` second argument flags for canonical JSON vs JSON5
- [ ] `json_valid` JSONB flags (`0x04` / `0x08`)
- [ ] `json_pretty` indent argument — **implemented**, untested
- [x] SQL `NULL` vs JSON `null` in `json_set` / `json_object`
- [x] `json_remove` multiple paths; `json_set` multiple path/value pairs
- [ ] `jsonb_replace` / `jsonb_group_object`
- [ ] `json_each`/`json_tree` on SQL NULL document

### 5. Date/time + modifiers — THIN / LIKELY DIVERGENCE

Evidence: [`tests/contract/date-time/`](../tests/contract/date-time/), [`src/functions/datetime.ts`](../src/functions/datetime.ts)

- [x] `date`/`time`/`datetime` with `+1 day`, `start of month`, `unixepoch` on `datetime(0,…)`
- [x] `strftime` `%Y-%m-%d` / `%H:%M:%S`
- [x] `weekday N`
- [ ] **LIKELY DIVERGENCE:** `subsec` / `auto` / `ceiling` / `floor` modifiers — absent
- [ ] `start of year` / `start of day` implemented, untested
- [ ] **LIKELY DIVERGENCE:** `timediff` uses 365.2425-day years and 30.436875-day months — probably not oracle-identical
- [ ] `julianday`; `unixepoch()`; `strftime('%s'|'%j'|'%W'|'%f')`; chained `unixepoch` + calendar mods
- [ ] `localtime`/`utc` are no-ops (intentional if documented; currently untested)
- [ ] Invalid dates (`2024-02-30`) NULL vs error; timezone offsets in input strings

### 6. LIKE / GLOB — THIN

Evidence: [`tests/contract/expressions/operators.test.ts`](../tests/contract/expressions/operators.test.ts), [`tests/contract/expressions/edges.test.ts`](../tests/contract/expressions/edges.test.ts)

- [x] LIKE case-insensitive ASCII; ESCAPE `!`; NOT LIKE; GLOB `*` `?` `[abc]` `[a-c]` `[^]`
- [x] `NULL LIKE x`, `x LIKE NULL`, empty pattern, LIKE on BLOB
- [x] Unicode case (`'ß' LIKE 'SS'`) — SQLite NOCASE is ASCII-only
- [x] `PRAGMA case_sensitive_like` — [`tests/contract/expressions/like-glob-gaps.test.ts`](../tests/contract/expressions/like-glob-gaps.test.ts)
- [ ] LIKE vs column `COLLATE BINARY` (LIKE ignores collation) — COLLATE is collected on LIKE operands but **not used**; `likeMatch` is ASCII-CI unless `PRAGMA case_sensitive_like=ON`
- [ ] **GAP / LIKELY DIVERGENCE:** `REGEXP` is a lexer keyword and an inventory name, but **not parsed** as an operator ([`parseExprPrec`](../src/parser/parser.ts) handles LIKE/GLOB/MATCH only) and has **no evaluator**
- [x] `ESCAPE ''` (SQLite error); `NOT GLOB`
- [ ] Multi-char ESCAPE

### 7. COLLATE NOCASE — THIN

Evidence: [`tests/contract/collate/`](../tests/contract/collate/)

- [x] `ORDER BY … COLLATE NOCASE`; `'a'='A' COLLATE NOCASE`; RTRIM; BINARY
- [x] UNIQUE index `COLLATE NOCASE`; column-declared COLLATE on `=` and `ORDER BY`
- [x] WITHOUT ROWID PK `COLLATE NOCASE` ([`tests/contract/without-rowid/basic.test.ts`](../tests/contract/without-rowid/basic.test.ts))
- [ ] `CREATE TABLE t(x TEXT UNIQUE COLLATE NOCASE)` (constraint vs index)
- [x] COLLATE on JOIN / `GROUP BY` / `BETWEEN` / CHECK
- [ ] COLLATE on generated column
- [ ] RTRIM on UNIQUE; NOCASE on non-TEXT storage

### 8. Type affinity coercions — THIN

Evidence: [`tests/contract/types/`](../tests/contract/types/)

- [x] INSERT affinity for INTEGER/REAL/TEXT/BLOB/NUMERIC; CAST; mixed `ORDER BY` storage classes
- [x] STRICT tables (separate, COVERED)
- [ ] **Comparison affinity** (`1 = '1'`, `'1.0' = 1`, `WHERE int_col = '1'`) — **LIKELY DIVERGENCE:** [`compareSql`](../src/types/value.ts) compares by storage class (numbers never equal text); [`evalExpr`](../src/expressions/eval.ts) does not apply column affinity before `=`. Highest-likelihood app-code miss
- [ ] INTEGER PRIMARY KEY `NULL` insert (rowid assign); `'1'` vs `1.0` into IPK
- [ ] Full type-name table (`VARCHAR`, `CLOB`, `FLOAT`, `BOOLEAN`, `DATE`)

### 9. IS / IS NOT — THIN

Evidence: [`tests/contract/null/semantics.test.ts`](../tests/contract/null/semantics.test.ts), [`tests/contract/expressions/distinct-from.test.ts`](../tests/contract/expressions/distinct-from.test.ts)

- [x] `IS NULL` / `IS NOT NULL`; `IS DISTINCT FROM` / `IS NOT DISTINCT FROM` (incl. `1` vs `1.0`)
- [ ] **LIKELY DIVERGENCE:** SQL `TRUE`/`FALSE` literals — **not in lexer** ([`src/lexer/tokenize.ts`](../src/lexer/tokenize.ts)); `SELECT TRUE` is likely `no_such_column` vs oracle `1`
- [ ] `IS TRUE` / `IS FALSE` / `IS NOT TRUE` — `parseIsRhs` only special-cases `NULL`
- [ ] postfix `ISNULL` / `NOTNULL` — **parsed** ([`parsePostfix`](../src/parser/parser.ts)), untested
- [ ] `IS` with BLOBs
- [ ] `x IS y` / `x IS NOT y` for non-NULL values (`1 IS 1.0`, `'a' IS 'a'`) — SQLite NULL-safe equality

### 10. Generated columns — THIN + ISOLATED

Evidence: [`tests/contract/generated/basic.test.ts`](../tests/contract/generated/basic.test.ts)

- [x] STORED + VIRTUAL `SELECT` after insert of base columns
- [ ] ISOLATED: “cannot insert into generated” is `new Database()` only — needs `errorParity`
- [ ] UPDATE of generated; index on generated; generated as UNIQUE/PK
- [ ] `PRAGMA table_xinfo` `hidden` 2 vs 3 (code comments uncertainty; pragma is **implemented**, untested)
- [ ] Generated referencing another generated; affinity of generated

### 11. Foreign keys + ON DELETE/UPDATE — mostly COVERED

Evidence: [`tests/contract/foreign-keys/`](../tests/contract/foreign-keys/)

- [x] Insert reject/accept; NULL child; default RESTRICT on parent DELETE
- [x] ON DELETE CASCADE / SET NULL / SET DEFAULT / RESTRICT
- [x] ON UPDATE CASCADE / SET NULL / SET DEFAULT / RESTRICT (TEXT + INTEGER PK)
- [x] Composite CASCADE; deferred INITIALLY DEFERRED/IMMEDIATE; `foreign_keys=OFF`
- [x] Explicit `ON DELETE NO ACTION` vs RESTRICT when DEFERRABLE
- [ ] `MATCH SIMPLE|FULL`; `PRAGMA foreign_key_check` / `foreign_key_list` (list **implemented**, untested)
- [ ] FK actions + triggers; parent REPLACE
- [ ] `ON DELETE SET DEFAULT` when the default parent row is missing (must fail)
- [ ] Combined `ON DELETE CASCADE ON UPDATE SET NULL`; FK referencing UNIQUE (not PK)

### 12. Partial indexes — mostly COVERED

Evidence: [`tests/contract/indexes/partial.test.ts`](../tests/contract/indexes/partial.test.ts)

- [x] Unique partial allows dups outside predicate; rejects inside; UPDATE into index; UPSERT WHERE; SELECT still correct
- [ ] Non-unique partial as lookup path with extra predicate
- [ ] `WHERE` with NULL / expression / collation; UPDATE that leaves the index

### 13. Expression indexes — mostly COVERED

Evidence: [`tests/contract/indexes/expression.test.ts`](../tests/contract/indexes/expression.test.ts)

- [x] `UNIQUE (lower(email))`; `json_extract`; `a+b`; ON CONFLICT on expression
- [ ] DESC / COLLATE in expression index; multi-column expressions; partial + expression together

---

## P0 — additional drop-in holes

Not in the original 13 app-code areas, but high likelihood of breaking a drop-in.

- [ ] **TRUE/FALSE literals** — LIKELY DIVERGENCE (see [IS / IS NOT](#9-is--is-not--thin))
- [ ] **`generate_series`** — ISOLATED only ([`tests/contract/table-valued/basic.test.ts`](../tests/contract/table-valued/basic.test.ts)); must be `parity` vs oracle
- [ ] **`MATCH` on non-FTS** — ISOLATED `unsupported` ([`tests/contract/errors/unsupported.test.ts`](../tests/contract/errors/unsupported.test.ts)); oracle category unknown (often `SQLITE_ERROR` / no MATCH function)
- [ ] **Bind / API garbage** — GAP: NaN/Infinity/`undefined`/too many/too few params; README claims rejection ([`toSqlValue`](../src/executor/env.ts) throws `SqliteError` `datatype_mismatch` for non-finite numbers) with no differential test
- [ ] **`-0` bind** — ISOLATED in [`tests/contract/determinism/basic.test.ts`](../tests/contract/determinism/basic.test.ts)
- [ ] **i64 / MAX_SAFE_INTEGER±1** — GAP; [`tests/contract/parameters/audit.test.ts`](../tests/contract/parameters/audit.test.ts) stays inside MAX_SAFE_INTEGER because bun:sqlite lacks `safeIntegers` (document as API difference; still need SQL-literal i64 tests)
- [ ] **rowid reuse after DELETE** on plain INTEGER PRIMARY KEY — **LIKELY DIVERGENCE:** [`allocateRowid`](../src/storage/table.ts) never decreases `nextRowid`. AUTOINCREMENT non-reuse is covered; the flag is stored but allocation is **identical** to plain IPK. No `sqlite_sequence` table
- [ ] **`total_changes()`** asserted as `>= 2` not exact ([`tests/contract/functions/scope3-builtins.test.ts`](../tests/contract/functions/scope3-builtins.test.ts))
- [ ] **Conflict oracles** `OR ABORT` / `OR FAIL` / `OR ROLLBACK` — **LIKELY DIVERGENCE:** parsed into AST modes; executor throws the same UNIQUE error for all of them. IGNORE/REPLACE covered. FAIL vs ABORT (statement vs transaction) and ROLLBACK of the tx are not distinguished
- [x] **Triggers:** BEFORE INSERT, `UPDATE OF`, `RAISE(ABORT)`, `RAISE(IGNORE)`, INSTEAD OF view writes, and trigger-visible `last_insert_rowid` have differential coverage. Remaining: `recursive_triggers` PRAGMA (recursion is always on, depth 1000)
- [x] **PRAGMA surface + `pragma_*` TVFs** — all oracle-exposed `pragma_*` eponymous TVFs registered ([`tests/contract/pragma/tvf.test.ts`](../tests/contract/pragma/tvf.test.ts)); statement getters share [`pragma-engine`](../src/executor/pragma-engine.ts). `case_sensitive_like` is a statement-form pragma (no oracle TVF). Storage pragma writers still mostly no-op/empty
- [ ] **RETURNING** on UPSERT; `RETURNING` excluded columns / `old`/`new` names
- [ ] **UPDATE … FROM** — one inner join; missing multi-match, LEFT FROM, correlated
- [ ] **`NOT IN (SELECT …)` NULL trap** — high-likelihood app SQL; only list-form `NOT IN` is tested ([`tests/contract/null/edges.test.ts`](../tests/contract/null/edges.test.ts)); `IN (SELECT)` is tested without NULL
- [ ] **Comma joins** `FROM a, b WHERE …` — parser treats comma as CROSS JOIN; only JSON TVF `FROM t, json_each(…)` is tested
- [ ] **`USING` multi-column**; NATURAL FULL
- [ ] Coverage hygiene: `uri.html` is UNSUPPORTED but mission says NOT APPLICABLE; `dbstat.html` UNSUPPORTED while the module exists; `fts5.html` / `json1.html` / `windowfunctions.html` / `lang_with.html` / `rowvalue.html` / `expridx.html` / `nulls.html` are absent from the sqlite.org dump so they never appear in `coverage.json`; `undoredo.html` / `whynotgit.html` are not dialect; stale VERIFIED notes in `coverage.json` vs current `SOURCE_SEED`

---

## Rest of SQL surface

### Statement types (AST vs differential tests)

| Statement | Status | Evidence | Main gaps |
| --- | --- | --- | --- |
| `select` | COVERED–THIN | select, joins, limits, distinct, ordering, grouping, subqueries, unions, cte | unordered SELECT stability; `LIMIT -1`; comma joins |
| `insert` | COVERED–THIN | insert, conflicts, upsert, returning, defaults | INSERT DEFAULT VALUES is covered; UPSERT holes above |
| `update` | COVERED–THIN | update (incl. “old row values” in SET), update-from | UPDATE LIMIT; WITH; OR ABORT/FAIL/ROLLBACK |
| `delete` | COVERED–THIN | delete | DELETE LIMIT / ORDER BY; WITH |
| `create_table` / `drop_table` | COVERED | schema, constraints, ddl-if, create-table-as, strict, without-rowid | named constraints; `IF NOT EXISTS` edges thin |
| `alter_table` | COVERED | alter-table/* | DROP generated; ADD PK/UNIQUE/CHECK (SQLite still limited) |
| `create_index` / `drop_index` | COVERED | indexes/* | DESC index sort; `INDEXED BY` is no-op (documented) |
| `create_view` / `drop_view` | THIN | views/basic | INSTEAD OF; view WITH; INSERT into simple view |
| `create_trigger` / `drop_trigger` | THIN | triggers/basic | BEFORE, UPDATE OF, INSTEAD OF, RAISE, recursive |
| `create_virtual_table` | PARTIAL | fts/*, modules/scope3 | documented FTS/RTREE partials |
| `begin` / `commit` / `rollback` | COVERED | transactions | `BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` parsed; `mode` unused in executor (in-memory locking N/A — still need success parity) |
| `savepoint` / `release` | COVERED | savepoints, transactions | |
| `pragma` | COVERED–THIN | pragma/* | TVFs covered; some statement writers still no-op |
| `attach` / `detach` | COVERED–THIN | attach | temp vs main same name; ATTACH file N/A |
| `analyze` / `reindex` / `vacuum` | THIN | misc/analyze-vacuum | VACUUM INTO parsed then **ignored**; REINDEX collation |
| `explain` | PARTIAL (documented) | errors/unsupported | stub shapes |

### Expression / operator map

| Construct | Status | Notes |
| --- | --- | --- |
| Arithmetic / concat / bitwise | COVERED | operators + edges |
| AND/OR/NOT three-valued | COVERED | null/semantics |
| CASE / CAST | COVERED | |
| BETWEEN / IN list | COVERED | NULL list edges covered |
| IN / EXISTS subquery | COVERED–THIN | missing `NOT IN (SELECT)` NULL trap; multi-row scalar error; empty IN select |
| LIKE / GLOB | THIN | see §6 |
| MATCH | FTS COVERED; non-FTS ISOLATED | |
| REGEXP | GAP / LIKELY DIVERGENCE | keyword only |
| IS / IS DISTINCT FROM | THIN | see §9 |
| `->` `->>` | COVERED | row-values + json/operators |
| Row values `=` `<` `IN` `IS` | COVERED | |
| COLLATE | THIN | see §7 |
| Parameters `?` `?NNN` `:n` `@n` `$n` | COVERED–THIN | too many/few; `?NNN` holes |
| Hex int `0x…` | GAP | |
| Blob `X'…'` / `X''` | COVERED | blobs/basic |
| Quoted identifiers / keywords | COVERED | lexer + parser |
| Very long names; embedded `""` | GAP | |

### Built-in functions (behavioral, not inventory)

Inventory gate: 0 missing oracle **names**. Behavioral contracts are a small subset.

| Bucket | Status | Tested (differential) | Untested / thin |
| --- | --- | --- | --- |
| Core scalars | THIN | abs, round, coalesce/ifnull/nullif, typeof, length, lower/upper/trim, substr/replace, hex/quote, printf, changes, min/max scalar, substring, zeroblob, group_concat | soundex, char/unicode extra args, unistr/unistr_quote, likelihood edges, sqlite_log, format flags |
| Date/time | THIN | date/time/datetime/strftime happy path | see §5; julianday, unixepoch(), timediff, CURRENT_* vs now |
| Math | THIN | sin/cos/tan/pi/degrees/radians, ln/log/pow/sqrt/mod, floor/ceil/trunc/sign | acosh/asinh/atan2/exp, ieee754 pair, NaN→NULL |
| JSON | COVERED–THIN | see §4 | |
| Window | THIN | see §3 | |
| UUID | GAP | name in inventory only | `uuid()` / `uuid_str` / `uuid_blob` vs oracle (seeded PRNG vs random) |
| FTS aux | PARTIAL | fts suite | matchinfo formats |
| TVF | COVERED–THIN | json_each/tree + pragma_* differential; generate_series ISOLATED | generate_series needs parity |

### PRAGMA map

| PRAGMA | Engine | Differential |
| --- | --- | --- |
| `foreign_keys` | yes | yes (statement + TVF) |
| `table_info` / `table_xinfo` | yes | yes (statement + TVF) |
| `database_list` | yes | yes (bare + `()` TVF) |
| `user_version` / `schema_version` | yes | yes (get; set statement) |
| `index_list` / `index_info` / `index_xinfo` | yes | yes (TVF) |
| `foreign_key_list` / `foreign_key_check` | yes | yes (TVF) |
| `table_list` / `collation_list` | yes | yes (TVF) |
| `integrity_check` / `quick_check` | yes (`'ok'`) | yes (TVF) |
| storage getters (`page_size`, `journal_mode`, …) | yes (bun `:memory:` defaults) | yes (sampled) |
| `function_list` / `module_list` / `pragma_list` / `compile_options` | yes | shape / presence (content may differ) |
| all other oracle `pragma_*` TVFs | yes | resolve smoke test |
| unknown statement → empty | yes | yes |
| `case_sensitive_like` | yes (statement form) | [`tests/contract/expressions/like-glob-gaps.test.ts`](../tests/contract/expressions/like-glob-gaps.test.ts) |

---

## Goal 1.2 — Error parity (scoped, not started)

Match **category** (`ErrorCategory`), not message text. Both engines must fail together and succeed together.

Existing differential error coverage:

- [x] `no_such_table` / `no_such_column`
- [x] `constraint_unique` / `constraint_notnull` / `constraint_check`
- [x] `constraint_foreign` (insert + ON DELETE/UPDATE RESTRICT)
- [x] `datatype_mismatch` on INTEGER PRIMARY KEY (`'abc'`, `1.5`)
- [x] `syntax` (`SELECT FROM`)
- [x] UNION column-count mismatch → `other`
- [x] ambiguous join column → `other`
- [x] failed UNIQUE leaves prior rows intact ([`tests/contract/errors/state.test.ts`](../tests/contract/errors/state.test.ts))

Gaps:

- [ ] `constraint_primary` vs `constraint_unique` on INTEGER PRIMARY KEY (primary-keys test does not assert category)
- [ ] too many / too few bind parameters
- [ ] bind `undefined` / `Date` / `NaN` / `Infinity` / plain object — category vs oracle (oracle may differ; document if API-only)
- [ ] CHECK on UPDATE
- [ ] FK SET DEFAULT with missing default parent
- [ ] generated-column insert (currently ISOLATED)
- [ ] MATCH non-FTS (currently ISOLATED)
- [ ] `OR ABORT` / `OR FAIL` / `OR ROLLBACK` vs default ABORT
- [ ] empty SQL → `misuse` (README claim; no differential)
- [ ] every public method with garbage → `SqliteError` (Goal 3.1)

`ErrorCategory` taxonomy: `syntax`, `no_such_table`, `no_such_column`, `constraint_unique`, `constraint_primary`, `constraint_notnull`, `constraint_check`, `constraint_foreign`, `constraint`, `transaction`, `datatype_mismatch`, `unsupported`, `misuse`, `other`.

---

## Goal 1.3 — Edge-value corpus (scoped, not started)

Need a **shared** corpus run through bind → store → index → compare → select back. Almost none of these are a named corpus today.

- [ ] empty string vs NULL
- [ ] `''` vs `zeroblob(0)` (zeroblob(0) is tested as a scalar; not vs `''` through a BLOB column + index)
- [ ] `-0` vs `+0` (ISOLATED bind/expression only)
- [ ] `MAX_SAFE_INTEGER ± 1`
- [ ] i64 min/max; `9223372036854775807 + 1` overflow
- [ ] NaN/Infinity rejection at bind; `'inf'` / `'nan'` text affinity
- [ ] surrogate pairs; invalid UTF-8/16 in TEXT
- [ ] BLOBs containing null bytes (partial: `X'00…'` roundtrip)
- [ ] very long identifiers
- [ ] quoted identifiers with embedded quotes (`"a""b"`)
- [ ] keywords as column names (COVERED for select/from/where/group/order/table/index/join)

---

## Goal 1.4 — Semantics under mutation (scoped, not started)

- [x] UPDATE SET uses old row values ([`tests/contract/update/basic.test.ts`](../tests/contract/update/basic.test.ts) `label=label\|\|value`)
- [x] AUTOINCREMENT does not reuse deleted ids — **caveat:** this also matches **plain IPK** in sqlite-mem (`nextRowid` never decreases). Oracle plain IPK **does** reuse. The AUTOINCREMENT test does not prove AUTOINCREMENT-specific behavior vs plain IPK
- [x] `last_insert_rowid` after sequential INSERT (not inside triggers)
- [x] `changes()` after INSERT/UPDATE/DELETE
- [x] prepared stmt after ALTER ADD COLUMN / DROP TABLE / recreate ([`tests/contract/api/schema-invalidation.test.ts`](../tests/contract/api/schema-invalidation.test.ts))
- [ ] **LIKELY DIVERGENCE:** rowid reuse after DELETE on **plain** INTEGER PRIMARY KEY — never reused
- [ ] **LIKELY DIVERGENCE:** `last_insert_rowid` inside AFTER INSERT triggers (stale until outer insert finishes)
- [ ] `total_changes()` exact vs `changes()`
- [ ] ORDER BY stability without unique key (SQLite does **not** promise stability — document if we match insertion/rowid order)
- [ ] **LIKELY DIVERGENCE:** no `sqlite_sequence` table; AUTOINCREMENT flag stored but allocation identical to plain IPK

---

## Goal 1.5 — Fuzz expansion (scoped, not started)

Existing: seeded fast-check (`0x5a17e0e1` + `SQLITE_MEM_FUZZ_PATH` replay) across expressions, DML, joins, CTE, windows, JSON, FTS, constraints, transactions, combinations.

Missing vs the Goal 1.5 ask:

- [ ] Grammar-driven **multi-statement stateful sessions** with byte-for-byte equality after **each** statement
- [ ] Minimized named regression contract **before** each fuzz-found fix (process rule; not a current harness)
- [ ] Hostile values from the Goal 1.3 corpus in the generator
- [ ] WITH on DML, REGEXP, TRUE/FALSE, comparison affinity in the grammar (once those constructs exist)

---

## Goal 1.6 — API contract vs better-sqlite3 users (scoped, not started)

README: no `iterate`, `pluck`/`raw`, `safeIntegers`, `pragma()` helper, `loadExtension`, file `serialize()`.

Shared-shape items that need a **single checklist table** (to be written into README/COMPATIBILITY after tests):

| Topic | Differential today | Gap |
| --- | --- | --- |
| `prepare` / `run` / `get` / `all` | yes ([`tests/contract/api/basic.test.ts`](../tests/contract/api/basic.test.ts)) | `result()` / zero-row columns |
| `changes` / `lastInsertRowid` types | `changes()` SQL covered; JS `db.changes` ISOLATED | bigint switchover vs bun without `safeIntegers` |
| Statement reuse after schema change | yes | RENAME / DROP COLUMN |
| Binding rules | named prefixes, NULL/BLOB | too many/few; no named-object bind (document) |
| `transaction()` nest / rollback | yes | nested SQL `BEGIN` still errors (README) |
| `close()` / use-after-close | ISOLATED `misuse` | in-flight prepared statements; idempotent close vs oracle |

---

## Isolated tests that must not be treated as proof

Convert to `errorParity`/`parity` or label as engine-only:

- `generate_series` ([`tests/contract/table-valued/basic.test.ts`](../tests/contract/table-valued/basic.test.ts))
- generated-column insert error ([`tests/contract/generated/basic.test.ts`](../tests/contract/generated/basic.test.ts))
- MATCH non-FTS ([`tests/contract/errors/unsupported.test.ts`](../tests/contract/errors/unsupported.test.ts))
- `json_array_insert` memory-only block (conditional `parity` exists when oracle has the name)
- `-0` bind, CURRENT_DATE clock, snapshot restore ([`tests/contract/determinism/basic.test.ts`](../tests/contract/determinism/basic.test.ts), [`tests/contract/api/basic.test.ts`](../tests/contract/api/basic.test.ts), [`tests/contract/snapshots/basic.test.ts`](../tests/contract/snapshots/basic.test.ts))
- `load_extension` unauthorized ([`tests/contract/functions/inventory.test.ts`](../tests/contract/functions/inventory.test.ts))
- SQLM snapshot round-trip (by nature cannot vs bun:sqlite; still needs unknown-version + edge corpus)

---

## Documented intentional differences (do not “fix”)

Keep these listed rather than treating them as parity bugs:

- Custom SQLM snapshots (not on-disk `.sqlite` files)
- Seeded `random()` / fixed `'now'` by default (`random: "os"` / `now: "system"` optional)
- No C API / on-disk DB / VFS
- EXPLAIN stubs; INDEXED BY no-op (missing indexes do not error)
- Unknown statement `PRAGMA` returns empty result (SQLite-like); `pragma_*` eponymous TVFs are implemented
- FTS shadow-table `changes()` divergence
- BigInt vs bun:sqlite without `safeIntegers`
- `ATTACH` opens an empty in-memory schema, not a file
- `pragma_compile_options` / `pragma_function_list` row *sets* reflect sqlite-mem (not bun’s native build)
- `MATERIALIZED` / `NOT MATERIALIZED` both execute as materialized

Candidates to **add** to COMPATIBILITY.md if probes confirm (do not document until a contract fails or we decide not to implement):

- `TRUE`/`FALSE` literals
- `REGEXP` operator
- Date `weekday N` / `subsec` / `auto` / `ceiling` / `floor`
- `timediff` calendar arithmetic
- Comparison affinity
- `WITH` on UPDATE/DELETE/INSERT VALUES
- `INTERSECT ALL` / `EXCEPT ALL` (parser never consumes `ALL` after INTERSECT/EXCEPT)
- Plain INTEGER PRIMARY KEY never reuses rowids (AUTOINCREMENT-like)
- INSTEAD OF triggers never fire; cannot INSERT into views
- `OR ABORT` / `OR FAIL` / `OR ROLLBACK` identical to default abort
- VACUUM INTO parsed then ignored (`:memory:` no-op)

---

## Goal 2 / 3 notes from this audit (not started)

Do not treat these as Goal 1.1 work. They are scoped so the next session can interleave.

**Goal 2 (perf):** [`benchmarks/TARGETS.md`](../benchmarks/TARGETS.md) already has measured targets (PK lookup, snapshots, bundle gzip ~79 KB). Still missing vs the hardening ask: `benchmarks/budgets.json` CI fail-on-regression, allocation/retained-heap benches, size-diff PR comment, pathological-input O(n²) benches, `PERFORMANCE.md` complexity notes.

**Goal 3 (hygiene):**

- [ ] Public API always `SqliteError` — constructor `fixedClock` throws **`RangeError`** today ([`src/runtime/clock.ts`](../src/runtime/clock.ts))
- [ ] `close()` / use-after-close on every method including in-flight statements (partial ISOLATED)
- [ ] SQLM unknown version — **implemented** (`unsupported sqlite-mem snapshot version`, category `unsupported`); no test
- [ ] SQLM round-trip matrix across corpus types
- [ ] CI Node 20/22/24 matrix — tests run on **Bun 1.3.14 only**; Node is used for semantic-release, not the differential suite
- [x] Large-dataset + CPU-throttled browser page — `bun run test:browser` / `scripts/browser-perf.ts`
- [x] Doc-claims test mapping README pitfalls — [`tests/contract/api/readme-pitfalls.test.ts`](../tests/contract/api/readme-pitfalls.test.ts)

---

## Session log

| Date | Session | Outcome |
| --- | --- | --- |
| 2026-08-18 | Goal 1.1 | Construct-level gap list vs `tests/contract/` + implementation. No code changes. |
| 2026-08-18 | Goal 1.1 follow-up | Folded impl-audit facts: plain IPK never reuses rowids; AUTOINCREMENT ≡ IPK (no `sqlite_sequence`); INSTEAD OF never fires; OR ABORT/FAIL/ROLLBACK not distinguished; `last_insert_rowid` stale in AFTER INSERT; WITH ignored on INSERT VALUES. |
| 2026-08-19 | Hardening pass | Closed P0 divergences; deepened UPSERT/CTE/windows/JSON/COLLATE/LIKE/triggers; FTS+fuzz+EXPLAIN; Phase 2 benches/budgets/throttle/rowid-cache; Phase 3 integration + README pitfalls. Suite 872 pass. |
| 2026-08-19 | SQL-gap contracts | `random: "os"` / `now: "system"`; `PRAGMA case_sensitive_like`; documented-divergence tests for EXPLAIN, INDEXED BY, ATTACH file, FTS changes, pragma sets, MATERIALIZED, dbstat/bytecode/tables_used. |
