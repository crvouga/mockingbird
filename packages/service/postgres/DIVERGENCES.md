# Divergences

> Auto-generated from [`compat/divergences.json`](compat/divergences.json). Do not edit by hand — run `bun run divergences`.

Generated: 2026-09-01 · 18 entries

| ID | Scope | Predicate | Pinned by |
| --- | --- | --- | --- |
| `oracle-pglite-version` | oracle | The default differential oracle is PGlite (embedded PostgreSQL 18.x WASM); a secondary native-server oracle is available via POSTGRES_MEM_ORACLE=server. server_version must be 18.3 or 18.1 for either path. | `scripts/postgres-compat-gate.ts`, `tests/harness/oracle-versions.ts`, `scripts/run-postgres-native-tests.ts` |
| `deterministic-runtime` | engine | random()/gen_random_uuid() are seeded-deterministic and now() is fixed to 2000-01-01 UTC by default; both are injectable via DatabaseOptions; the PRNG participates in transaction rollback and snapshots | `DAT-now-01`, `DET-seed-01`, `DET-seed-02`, `DET-now-01`, `DET-now-02`, `DET-uuid-01`, `DET-rb-01`, `DET-snap-01`, `DET-setseed-01`, `DET-scan-01`, `tests/contract/determinism/basic.test.ts` |
| `pgmm-snapshot-codec` | engine | snapshot()/encode()/decode() use the custom PGMM binary codec (magic 'PGMM' + LE u32 version), not pg_dump or the on-disk PostgreSQL format | `SNP-rt-01`, `SNP-rt-02`, `SNP-rt-03`, `SNP-rt-04`, `SNP-rt-05`, `SNP-byte-01`, `SNP-hdr-01`, `SNP-hdr-02`, `SNP-hdr-03`, `SNP-hdr-04`, `SNP-txn-01`, `SNP-open-01`, `SNP-open-02`, `tests/contract/snapshots/basic.test.ts` |
| `copy-stdin-api` | api | COPY ... FROM STDIN is fed through the copyFrom(sql, text) API hook and COPY ... TO STDOUT returns the rendered text from exec; PGlite exposes a different (protocol-level) COPY interface | `CPY-from-01`, `CPY-from-02`, `CPY-from-03`, `CPY-from-04`, `CPY-from-05`, `CPY-csv-01`, `CPY-csv-02`, `CPY-csv-03`, `CPY-to-01`, `CPY-to-02`, `CPY-to-03`, `CPY-to-04`, `CPY-rt-01`, `CPY-api-01`, `tests/contract/copy/basic.test.ts` |
| `sync-api-surface` | api | The public Database/Statement API is synchronous (exec/query/prepare/transaction/snapshot/restore/close return values, not Promises); PGlite and pg clients are asynchronous | `API-exec-01`, `API-exec-02`, `API-query-01`, `API-prep-01`, `API-run-01`, `API-run-02`, `API-run-03`, `API-bind-02`, `API-bind-03`, `API-ret-01`, `API-ret-02`, `API-close-01`, `API-txn-01`, `API-txn-02`, `API-sync-01`, `API-copy-01`, `API-int8-01`, `API-int8-02`, `API-fn-01`, `tests/contract/api/basic.test.ts` |
| `dump-compat-noop` | sql | DO blocks and ALTER TABLE SET (storage/reloptions) execute as no-ops so schema dumps can load without intercepts; PL/pgSQL and storage parameters are NOT APPLICABLE | `API-dump-01`, `API-do-01`, `API-set-01` |
| `empty-script-rejected` | sql | exec of a statement-free script (comments/whitespace only) raises an empty-statement error; PostgreSQL accepts it as a no-op | `TOK-cmt-04` |
| `row-value-subquery-arity` | sql | Row-constructor arity mismatches surface at execution (21000) instead of parse time (42601), and multi-column row-value IN (SELECT ...) is rejected as unsupported | `PAR-row-03`, `EXP-in-03` |
| `float8-overflow-saturates` | sql | '1e400'::float8 saturates to Infinity instead of raising 22003 out of range | `TYP-float-04` |
| `round-half-away-from-zero` | sql | round(float8) rounds ties away from zero (round(2.5::float8) = 3); PostgreSQL rounds half to even (= 2) | `FUN-round-02` |
| `drop-cascade-view-retained` | sql | DROP TABLE ... CASCADE does not drop dependent views; the view remains and errors when queried | `DDL-drop-03` |
| `comment-on-not-stored` | sql | COMMENT ON parses and succeeds but the comment is not stored; obj_description() returns NULL | `DDL-comment-01` |
| `trigger-order-creation` | sql | Multiple triggers on the same event fire in creation order; PostgreSQL fires them in name order | `TRG-order-01` |
| `trigger-update-of-ignored` | sql | UPDATE OF column lists on triggers are parsed but ignored; the trigger fires for every UPDATE | `TRG-updof-01` |
| `instead-of-triggers-unsupported` | sql | CREATE TRIGGER ... INSTEAD OF on a view fails loud; PostgreSQL supports INSTEAD OF triggers on views | `TRG-instead-01` |
| `no-aborted-transaction-state` | sql | After a failed statement inside BEGIN, subsequent statements keep executing; PostgreSQL rejects them with 25P02 until ROLLBACK | `TXN-abort-01` |
| `version-banner` | catalog | version() returns 'PostgreSQL 18.3 (postgres-mem) on TypeScript, in-memory engine' instead of the real build banner | `CAT-ver-01` |
| `pg-get-viewdef-missing` | catalog | pg_get_viewdef() is not implemented and raises 42883 | `CAT-viewdef-01` |

## Specified behavior

### `oracle-pglite-version`

Harness bootstrap asserts current_setting('server_version') is in {18.3, 18.1}. Default CI uses PGlite; `bun run test:postgres-native` (and CI job test-native-oracle) runs the same suite against a real PostgreSQL 18.3 process.

### `deterministic-runtime`

By design, two Database instances with the same seed produce identical random streams and identical now() values. PostgreSQL is wall-clock and entropy driven. Tests assert memory behavior only.

### `pgmm-snapshot-codec`

Snapshots are byte-identical for equivalent logical state, refuse corrupt/truncated/future-version blobs, and cannot run inside a transaction. No PostgreSQL equivalent exists; tests assert memory behavior only.

### `copy-stdin-api`

Text and CSV COPY semantics (\N nulls, escapes, \. terminator, HEADER/DELIMITER/NULL options, column lists) follow PostgreSQL 18; the transport is the JS API rather than the wire protocol, so these are memory-only assertions.

### `sync-api-surface`

API shape mirrors sqlite-mem: run/all/get/result, $1..$n parameters, bigint for int8, canonical text for numeric/date/jsonb, misuse errors for wrong usage. Asserted memory-only because no PostgreSQL client shares this surface.

### `dump-compat-noop`

exec() loads schema dumps. DO $$ … $$ and ALTER TABLE … SET (fillfactor=…) succeed and change nothing. PGlite executes plpgsql; these cases are memory-only.

### `empty-script-rejected`

postgres-mem requires at least one statement per exec call.

### `row-value-subquery-arity`

Single-column IN subqueries have full parity; multi-column row-value subquery comparison is out of scope for this milestone and fails loud.

### `float8-overflow-saturates`

float8 text input uses JS Number parsing, which saturates. In-range values have full parity.

### `round-half-away-from-zero`

numeric round() has full parity; only the float8 overload diverges on exact .5 ties.

### `drop-cascade-view-retained`

Dependency tracking for CASCADE drops of views is not implemented; drop the view explicitly.

### `comment-on-not-stored`

COMMENT ON is accepted for compatibility; descriptions are not persisted.

### `trigger-order-creation`

Name your triggers so alphabetical order matches creation order if ordering matters.

### `trigger-update-of-ignored`

Column-filtered trigger firing is not implemented; guard inside the trigger body instead.

### `instead-of-triggers-unsupported`

INSTEAD OF triggers are out of scope for this milestone.

### `no-aborted-transaction-state`

The aborted-transaction latch is not implemented; each statement is validated independently.

### `version-banner`

server_version/server_version_num report 18.3/180003 for compatibility; the full banner names postgres-mem.

### `pg-get-viewdef-missing`

View definitions are visible via information_schema.views.view_definition (stored SQL text).

