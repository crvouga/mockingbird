# Divergences

> Auto-generated from [`compat/divergences.json`](compat/divergences.json). Do not edit by hand — run `bun run divergences`.

Generated: 2026-08-21 · 20 entries

| ID | Scope | Predicate | Pinned by |
| --- | --- | --- | --- |
| `oracle-platform-sqlite-version` | oracle | sqlite_version() is 3.51.0 (macOS system libsqlite) or 3.53.0 (Bun Linux/Windows amalgamation) | `scripts/sqlite-compat-gate.ts`, `tests/harness/oracle-version.test.ts` |
| `snapshot-sqlm` | snapshot | snapshot().encode() bytes are SQLM, not a .sqlite file | `SNP-hdr-01`, `SNP-rt-01` |
| `deterministic-random-now` | runtime | default random() and date('now') are seeded/fixed | `DAT-now-01`, `DET-seed-01`, `DET-negzero-01` |
| `negzero-canonicalization` | types | IEEE -0 becomes +0 on bind, affinity, and arithmetic | `TYP-negzero-01`, `TYP-negzero-02`, `TYP-negzero-03`, `DET-negzero-01` |
| `attach-empty-schema` | attach | ATTACH filename is ignored; attached schema is empty in-memory | `ATT-att-01` |
| `explain-stub` | explain | EXPLAIN / EXPLAIN QUERY PLAN shapes are stubs | `PAR-explain-01` |
| `indexed-by-discarded` | select | INDEXED BY / NOT INDEXED is accepted and ignored | `tests/contract/indexes/indexed-by.test.ts` |
| `materialized-hint-ignored` | cte | MATERIALIZED / NOT MATERIALIZED do not change the execution strategy | `CTE-mat-01` |
| `fts-shadow-counters` | fts | FTS shadow-table change counters may differ from bun:sqlite | `FTS-chg-01` |
| `compile-options-function-list` | pragma | pragma_compile_options and function_list contents are sqlite-mem's | `PRG-comp-01`, `PRG-fn-01` |
| `js-api-surface` | api | better-sqlite3 extras are absent; duplicate column names collapse in row objects | `API-ret-03`, `DML-ret-02`, `SEL-dup-01` |
| `snapshot-exclusions` | snapshot | triggers, ATTACH, virtual tables, and user_version are not in SQLM | `SNP-omit-01`, `SNP-omit-02`, `SNP-omit-03`, `SNP-omit-04`, `TRG-snap-01`, `ATT-snap-01`, `FTS-snap-01` |
| `json-api-unwrap` | json | JSON subtype is unwrapped to JS string at the API | `JSN-sub-03` |
| `nan-infinity-bind` | bind | JS NaN and Infinity binds are rejected | `TYP-nan-04`, `TYP-nan-05` |
| `double-quote-string-fallback` | lexer | SQLite may treat unknown double-quoted identifiers as strings; sqlite-mem rejects them | `TOK-07` |
| `lone-surrogate-bind` | unicode | JS lone surrogates in string binds are engine-defined | `UNI-surr-01` |
| `user-version-snapshot` | pragma | user_version is not encoded in SQLM | `PRG-beh-05`, `SNP-omit-04` |
| `pragma-setter-noop` | pragma | Some pragma setters are accepted but do not change engine state yet | `PRG-beh-02`, `PRG-beh-03`, `PRG-beh-07` |
| `generate-series-extension` | tvf | generate_series is a sqlite-mem extension | `FTS-series-01` |
| `datetime-localtime-utc` | datetime | localtime/utc modifiers do not apply host timezone conversion | `tests/contract/date-time/modifiers.test.ts` |

## Specified behavior

### `oracle-platform-sqlite-version`

Harness bootstrap asserts sqlite_version() is in {3.51.0, 3.53.0}. Dialect tests are version-tagged when 3.51≠3.53.

### `snapshot-sqlm`

Custom codec; logical Dump after Snapshot.open matches pre-snapshot Dump.

### `deterministic-random-now`

PRNG seed default 1; clock 2000-01-01T00:00:00.000Z unless random:os / now:system.

### `negzero-canonicalization`

Object.is(result, -0) is false for bound and computed zeros.

### `attach-empty-schema`

ATTACH creates an empty schema; no file contents are loaded.

### `explain-stub`

Plan text is not byte-identical to SQLite bytecode; results of the explained statement still match.

### `indexed-by-discarded`

Query results match the unhinted plan; missing-index errors are not raised.

### `materialized-hint-ignored`

Results still match the oracle; both hints take the materialized CTE path.

### `fts-shadow-counters`

MATCH results and rank order still match; db.changes after FTS maintenance may differ.

### `compile-options-function-list`

Names and flags describe this engine, not the oracle amalgamation.

### `js-api-surface`

bind/iterate/pluck/raw/pragma()/loadExtension/serialize/safeIntegers throw. stmt.result().values keeps positional duplicates.

### `snapshot-exclusions`

decode().open() outcome is pinned per omitted feature.

### `json-api-unwrap`

query() returns TEXT, not a JSON wrapper object.

### `nan-infinity-bind`

datatype_mismatch rather than storing NULL or Inf.

### `double-quote-string-fallback`

prepare/query of SELECT "not_a_column" throws in sqlite-mem.

### `lone-surrogate-bind`

sqlite-mem stores the JS string as UTF-16-unpaired text; oracle may replace or error.

### `user-version-snapshot`

PRAGMA user_version after decode().open() is the default unless re-set.

### `pragma-setter-noop`

defer_foreign_keys, recursive_triggers, and application_id getters remain 0 after SET.

### `generate-series-extension`

Present in sqlite-mem; not claimed vs bun:sqlite default inventory.

### `datetime-localtime-utc`

Modifiers are accepted as no-ops; storage remains UTC-like fixed strings.

