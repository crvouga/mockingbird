# Compatibility

Goal: **PostgreSQL 18 SQL dialect behavioral parity** as a drop-in for the same statements against the reference oracle. Compatibility is proven by the differential contract suite and the fail-closed gate:

```bash
bun run test:postgres-compat
```

See [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the latest evidence-based audit report.

Reference oracle: **PostgreSQL 18.3** via PGlite (`@electric-sql/pglite`, real Postgres compiled to WASM, in-process). Inventory: `bun run inventory`. Construct catalog: `bun run scenarios` → [`compat/scenarios.ts`](compat/scenarios.ts). Divergences: [`compat/divergences.json`](compat/divergences.json). Requirements matrix: `bun run requirements` → `compat/requirements.json` + `compat/coverage.json`.

The Node `/server` entry participates in protocol fleets. Acceptance tests use `pg@8.23.0`
for authenticated readiness, shutdown, namespace isolation, full-catalog reset/snapshot/restore and
clock controls. This supervisor surface does not change the SQL dialect compatibility contract.

## Proof surface

Differential tests compare a **tuple** per statement: rows (normalized to canonical PostgreSQL text where typed), column names and type names where requested, error SQLSTATE class + normalized message, command tag / `rowCount`, and transaction status, plus a **logical state dump** (catalog names, column definitions, row payloads, sequence values) after write sequences.

A catalog ID appearing in a test file is **not** proof by itself. Trivial probes are tracked in [`compat/smoke-baseline.json`](compat/smoke-baseline.json) and ratcheted downward (currently **0 smoke stubs** across 998 catalog scenarios). Generated operator/cast matrices live under [`tests/contract/matrices/`](tests/contract/matrices/). Observed mem≠oracle diffs must bind to a `compat/divergences.json` entry or be a **FAILURE** — unexplained diffs are not allowed.

Intentional differences are finite and machine-readable in `compat/divergences.json` (PGMM snapshots, seeded `random()`/`now()`, sync single-session API, no aborted-transaction state, EXPLAIN stubs, trigger-order/`UPDATE OF` edges, float8 rounding/overflow edges, …). The wire server supports isolated database catalogs, startup selection, database lifecycle DDL, and copy-on-write template cloning. Human-readable: [DIVERGENCES.md](DIVERGENCES.md).

The wire server supports protocol-v3 text and CSV `COPY FROM STDIN` / `COPY TO STDOUT`, including
incremental `CopyData`, client aborts, and statement-atomic rollback. Binary COPY remains outside
the compatibility surface.

The wire server keeps settings per connection and applies the startup packet's run-time parameters
(libpq `options=-c name=value` / `--name=value`, split like `pg_split_opts`, then parameters sent by
name) as session defaults that `RESET` returns to. Malformed options, unknown parameters, bad
values and read-only parameters end the connection with the `FATAL` SQLSTATEs PostgreSQL 18.3
reports (`42601`, `42704`, `22023`, `55P02`), pinned by `tests/wire/startup-options.test.ts`.
Known gaps: parameters the engine has no setting for are `42704`, `postgres` switches other than
`-c` / `--` are `0A000`, `ParameterStatus` is not re-sent when a reported setting changes,
`SET LOCAL` does not carry across the statements of a wire transaction block, `DISCARD ALL` is a
no-op, and with no schema of `search_path` present an unqualified `CREATE` goes to `public` where
PostgreSQL raises `3F000`.

The wire server's opt-in durable mode (`serve({ durable })`, `--durable <dir>`) persists the
cluster before a commit is acknowledged, so acknowledged commits survive a killed process. It is
snapshot persistence of PGMM bytes behind an injectable storage port, with an atomic file-backed
implementation. It is not a write-ahead log and not PostgreSQL's on-disk format: there is no
`pg_wal`, no data directory another PostgreSQL could open, no physical replication or
point-in-time recovery, and each commit costs an encode of the database it changed. See the README
for the guarantees and their limits (`tests/wire/durable*.test.ts`, `tests/wire/file-storage.test.ts`).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Differential contracts (+ fuzz where applicable) cover happy path **and** meaningful edges vs oracle |
| **PARTIALLY VERIFIED** | Implemented; coverage thin or known edges remain |
| **UNSUPPORTED** | Missing from SQL surface (must fail loud; gate fails if oracle-exposed and unregistered) |
| **NOT APPLICABLE** | Outside the SQL-dialect surface (roles/auth, replication, storage). The wire protocol is provided by the optional `/server` entry, documented in the README. |

## Scope bound

Anything a PostgreSQL application can invoke through SQL against the PGlite **18.3** oracle must match observable behavior, except:

1. **Snapshot format** — custom binary codec (`PGMM`), not `pg_dump` / on-disk clusters (logical state still round-trips). Decoding PGMM v3 preserves bigint-backed SQL datums (including small `bigint`, `money`, `time`, `timestamp`, and `timestamptz` values) using their catalog types, so arithmetic remains valid after repeated restores, including materialized views (`tests/contract/snapshots/basic.test.ts`).
2. **Deterministic `random()` / `now()`** — seeded PRNG and fixed clock by default (injectable).
3. **Single-session sync API** — no concurrent sessions or `25P02` aborted-transaction state. The optional wire server separately provides per-session `READ COMMITTED` workspaces and row locks.
4. **NOT APPLICABLE** rows in `compat/coverage.json` (roles, replication, VACUUM internals, LISTEN/NOTIFY, cursors, full PL/pgSQL, extensions other than `pgcrypto`'s `digest()` and `pg_trgm`'s `similarity` / `<%` / `gin_trgm_ops`).

The oracle exposes **2787 builtin functions** and **74 operators** in `pg_catalog`; postgres-mem implements **306 functions** and **41 operators**, and every remaining item is an explicit entry in [`compat/unsupported-register.json`](compat/unsupported-register.json) with a reason (trigger/internal plumbing, admin/monitoring, unsupported type families, …). The gate fails closed on silence.

## Requirements coverage (PostgreSQL 18 SQL commands)

`bun run requirements` ingests the PostgreSQL 18 SQL-commands documentation index: **183 commands** → 56 NOT APPLICABLE, 127 SQL-behavior. Of the SQL-behavior commands: **43 VERIFIED**, **26 PARTIALLY VERIFIED**, **58 UNSUPPORTED** (fail-loud, registered). Full detail: `compat/coverage.json`.

## Feature matrix (summary)

| Area | Status | Notes |
| --- | --- | --- |
| Core DML / SELECT / joins / CTE / ON CONFLICT / RETURNING | VERIFIED | Contract + fuzz |
| Types: bool/int2/4/8, float4/8, numeric, text/varchar/char, bytea, uuid | VERIFIED | numeric is in-repo arbitrary precision |
| Date/time: date, time, timestamp[tz], interval + arithmetic | VERIFIED | Timezone conversions for named zones; some interval corners partial |
| Casts (implicit/assignment/explicit) | VERIFIED | Generated cast matrices from oracle |
| Arrays + unnest + subscripts/slices | VERIFIED | |
| JSON / JSONB operators + functions | VERIFIED | JSONB CASE branches preserve the JSONB type for selected untyped NULL/literal results, including empty LATERAL sources and nested views. Type hints cover column references, casts, JSON extraction operators and nested CASE without executing unselected result expressions; arbitrary function-result branch inference remains partial (`tests/contract/regressions/jsonb-case-types.test.ts`) |
| Window functions (frames, EXCLUDE) | VERIFIED | |
| GROUPING SETS / ROLLUP / CUBE, DISTINCT ON, LATERAL, set ops | VERIFIED | |
| Recursive + data-modifying CTEs | VERIFIED | |
| Constraints: PK / UNIQUE / NOT NULL / CHECK / FK actions | VERIFIED | DEFERRABLE parsed, checked at statement end |
| Sequences / serial / identity | VERIFIED | Includes pg_dump identity sequence names and options |
| Schemas + search_path + pg_catalog / information_schema | VERIFIED | Catalog columns are the commonly-queried subset |
| Enums, domains, generated columns | VERIFIED | |
| `ALTER COLUMN SET / DROP NOT NULL`, `SET / DROP DEFAULT` | VERIFIED | PostgreSQL's errors for existing NULLs (`23502`), primary-key and identity columns, column references and subqueries in a default, and literals that are not valid input for the column type. Every action of one `ALTER TABLE` applies or none does. An undefined function in a default is reported when a row first uses it, not by `ALTER TABLE` (`tests/contract/alter-table/set-not-null.test.ts`, `set-default.test.ts`) |
| `information_schema.columns.column_default` | PARTIALLY VERIFIED | Rendered the way `pg_get_expr` prints the analyzed default: constants of every type, casts, SQL value functions, `nextval`, the built-in functions with a signature on record, operators, `ARRAY[...]`, `CASE`, `IN`, `BETWEEN`, `LIKE`. Functions outside that table print an untyped literal argument as `text`; `CURRENT_TIMESTAMP(n)`, `current_schema()` and unary `+` lose the detail the parser drops; a nested `CASE` is printed on one line. `pg_attrdef` lists the same text (next section) |
| `ALTER COLUMN SET STORAGE`, `STORAGE` column clause, `pg_attribute.attstorage` | VERIFIED | SQL and catalog contract only: `PLAIN` / `EXTERNAL` / `EXTENDED` / `MAIN` / `DEFAULT`, per-type defaults, `LIKE ... INCLUDING STORAGE`, PostgreSQL's errors for an unknown mode (`22023`), a non-toastable type (`0A000`) and a missing column. **No TOAST**: values are never compressed or moved out of line, so the mode changes nothing about how rows are held. `SET STORAGE` on a materialized view fails loud (`0A000`); `SET COMPRESSION` is unsupported (`tests/contract/alter-table/set-storage.test.ts`) |
| `CREATE UNLOGGED TABLE / SEQUENCE`, `SET LOGGED / UNLOGGED`, `pg_class.relpersistence` | VERIFIED | SQL and catalog contract only: `p` / `u` / `t` for tables, their indexes and owned sequences; contents, indexes and constraints are kept across a conversion; PostgreSQL's errors for temporary tables, for logged / unlogged / temporary foreign-key combinations (`42P16`) and for a second change in one statement. **No WAL and no crash recovery**: an unlogged table is stored exactly like a logged one, is not truncated after a crash, and is included in snapshots (`tests/contract/alter-table/set-logged.test.ts`) |
| Index identity: `pg_class` / `pg_index` / `pg_indexes` / `pg_am` / `pg_constraint.conindid` | VERIFIED | Every index is a relation with its own oid, distinct from its table, kept through `ALTER INDEX / TABLE / SCHEMA ... RENAME`, `SET SCHEMA`, transactions and snapshots; `DROP` + `CREATE` and `REINDEX CONCURRENTLY` make a new one. The index behind a `PRIMARY KEY` or `UNIQUE` constraint appears in all of them and follows `ADD / RENAME / DROP CONSTRAINT`; dropping it directly is `2BP01`. Snapshots written before indexes had oids load with distinct ones. `pg_index` has the flag columns only: `indexprs` / `indpred` are the text `pg_get_expr()` returns, and `indkey`, `indclass`, `indoption`, `indcollation` are absent. A constraint's index name must be free among the schema's relations (`42P07`), and a generated name steps past one that is taken (`t_pkey1`) (`tests/contract/catalogs/index-definitions.test.ts`) |
| `pg_get_indexdef(oid)`, `pg_get_indexdef(oid, column, pretty)`, `pg_indexes.indexdef` | VERIFIED | `UNIQUE`, `USING` method, `DESC` / `NULLS FIRST / LAST`, `INCLUDE`, non-default operator classes, `COLLATE`, `NULLS NOT DISTINCT`, `WITH (...)`, quoted identifiers (every non-unreserved keyword), and expressions and predicates printed as PostgreSQL prints the analyzed tree: typed constants, the implicit casts operator resolution adds, `= ANY (ARRAY[...])` for `IN`, `~~` for `LIKE`, expanded `BETWEEN`, flattened `AND` / `OR`, `CASE` layout, SQL-syntax functions. Column positions past the end or negative are `''`, an oid that is not an index is NULL, and pretty-printing drops the schema and redundant parentheses. Differential over a 127-index construct matrix; expressions outside it (subqueries, row constructors, `SIMILAR TO`, array slices) are best-effort. Access methods other than btree are recorded and rendered, not implemented differently (`tests/contract/catalogs/index-definitions.test.ts`) |
| `pg_index.indisvalid`, `CREATE / DROP INDEX CONCURRENTLY`, `REINDEX` | VERIFIED | Completed indexes are valid, ready and live. A concurrent unique build that hits duplicates fails (`23505`) and leaves the index in the catalog, invalid and not enforced; `DROP INDEX` removes it and `REINDEX INDEX / TABLE / SCHEMA / DATABASE` repairs it once the data allows; a failed `REINDEX INDEX CONCURRENTLY` leaves `name_ccnew`. The commands PostgreSQL refuses in a transaction block are `25001`. An *interrupted* build (cancel, deadlock) cannot be provoked in the oracle: `Database.fault({ concurrentIndexBuild: "57014" })` and `server.fault({ failConcurrentIndexBuild })` arm one for tests, in the build-phase state (`indisready = false`); the state a failure in the later validation scan leaves (`indisready = true`, still enforcing) is not modelled (divergence `concurrent-index-build-fault`). `REINDEX` has no physical index to rebuild (`tests/contract/catalogs/index-validity.test.ts`, `tests/wire/index-catalog.test.ts`) |
| `COMMENT ON INDEX`, `pg_description`, `obj_description` | VERIFIED | Stored on the index: replace, clear with `NULL` or `''`, removed with the index / table / schema, kept through renames, transactional, in snapshots, isolated per wire transaction; `42P01` / `3F000` / `42809` for a missing index, a missing schema, a relation that is not an index. Comments on every other kind of object are still accepted and not stored (divergence `comment-on-not-stored`) (`tests/contract/catalogs/index-comments.test.ts`) |
| `regnamespace`, `to_regnamespace` | VERIFIED | Input (`-`, an all-digit oid, or exactly one identifier, case-folded unless quoted), output (quoted like `quote_ident`, numeric when no schema has the oid, `-` for zero), casts from text / name / oid / integers, implicit use as `oid` in comparisons, `pg_toast` / `pg_catalog` / `information_schema`; `3F000`, `42602` and `22003` as PostgreSQL raises them. `public` has a generated oid, not 2200 (`tests/contract/catalogs/regnamespace.test.ts`) |
| `pg_stat_user_tables`, `pg_stat_user_indexes`, `ANALYZE` | PARTIALLY VERIFIED | PostgreSQL 18's columns and types; one row per user table and materialized view (and per index), `relid` joins `pg_class.oid`, follows create / drop / rename / schema moves, restored with snapshots. `n_live_tup` is the exact row count, immediately; `ANALYZE` validates its targets (`42P01`, `42703`, `42701`, `42601`) and records `analyze_count` / `last_analyze` from the database clock. Not tracked (read zero / NULL): scans, tuples inserted / updated / deleted, dead tuples, vacuum; `idx_scan` counts only the unique-key lookups made for `SELECT`. `VACUUM ANALYZE` does not count. Temporary tables are listed under the schema they were created in, not `pg_temp` (divergence `pg-stat-counters-immediate`) (`tests/contract/catalogs/table-statistics.test.ts`) |
| Storage-default session settings | VERIFIED | `default_tablespace` (empty/database default or `pg_default`) and `default_table_access_method` (`heap`), SHOW/current_setting/set_config/RESET and transaction-local scope. Unknown methods/tablespaces fail with `22023`. Physical storage placement is not modelled (`tests/contract/misc/storage-defaults.test.ts`) |
| Materialized view indexes | PARTIALLY VERIFIED | Ordinary/partial/unique indexes, creation before population, catalog links, unique enforcement and atomic failure on refresh, snapshot roundtrip. Physical access methods and concurrent refresh are not modelled (`tests/contract/views/materialized-indexes.test.ts`) |
| Constraint triggers | PARTIALLY VERIFIED | AFTER ROW multi-event triggers, DEFERRABLE INITIALLY DEFERRED/IMMEDIATE, final-state execution at commit, failed-commit rollback, SET CONSTRAINTS and savepoints; definitions survive snapshots, pending events cannot be exported. Uses the existing plpgsql-lite subset (`tests/contract/triggers/deferred.test.ts`, `tests/wire/deferred.test.ts`) |
| Triggers (row-level, LANGUAGE sql-expressible) | PARTIALLY VERIFIED | Creation-order firing, `UPDATE OF` ignored, no INSTEAD OF (documented) |
| Statement triggers and transition tables | PARTIALLY VERIFIED | `BEFORE` / `AFTER` `FOR EACH STATEMENT` triggers on `INSERT`, `UPDATE` and `DELETE` fire once per statement in trigger-name order, also when no row changes (`INSERT ... ON CONFLICT DO UPDATE` fires the `INSERT` and the `UPDATE` ones). `AFTER` triggers take `REFERENCING { OLD \| NEW } TABLE [AS] name` for one `INSERT`, `UPDATE` or `DELETE` event: the body reads the statement's rows (`OLD` and `NEW` position-aligned for `UPDATE`) as relations with the table's columns, quoted names stay case-sensitive, and `pg_trigger.tgoldtable` / `tgnewtable` and snapshots carry them. The clause errors match PostgreSQL (`42P17` for BEFORE, wrong event, duplicate or equal names; `0A000` for several events, column lists, `TRUNCATE`, `ROW` variables). Not modelled: `FOR EACH ROW` triggers with transition tables (`0A000`), statement triggers for `TRUNCATE` and for cascaded foreign-key actions (`tests/contract/triggers/transition-tables.test.ts`, `tests/wire/issue-465-466.test.ts`) |
| CREATE FUNCTION LANGUAGE sql / plpgsql-lite | PARTIALLY VERIFIED | Scalar + set-returning; plpgsql subset: DECLARE, EXCEPTION WHEN others, CASE, FOR-IN-SELECT, RETURN NEXT |
| Anonymous `DO [LANGUAGE plpgsql]` blocks | PARTIALLY VERIFIED | Run through the plpgsql-lite interpreter: `DECLARE`, assignment, `IF` / `CASE`, `PERFORM`, `FOR ... IN <query>`, `RAISE [level] 'fmt %', args [USING ERRCODE, MESSAGE]`, a bare `RAISE` in a handler, `EXECUTE <expr>`, and DDL / DML statements. `EXCEPTION WHEN <condition> [OR ...]` takes condition names, class conditions (`integrity_constraint_violation`), `SQLSTATE '23505'` and `OTHERS`; a caught error takes back what the block wrote (an implicit savepoint) and `SQLERRM` / `SQLSTATE` are visible in the handler. The block is atomic and rolls back with its transaction. `RAISE NOTICE` / `WARNING` / `INFO` / `LOG` / `DEBUG` are discarded (no notice channel) and `DETAIL` / `HINT` options of `RAISE EXCEPTION` are evaluated but not carried on the error. Anything else (`SELECT ... INTO`, `EXECUTE ... INTO` / `USING`, `GET DIAGNOSTICS`, `LOOP` / `WHILE` / integer `FOR`, cursors, labels, nested `DECLARE`) fails loud with `0A000`; `LANGUAGE sql` is `0A000` and an unknown language `42704`, as in PostgreSQL (`tests/contract/regressions/do-blocks.test.ts`, `tests/wire/do-block.test.ts`) |
| `ALTER TABLE ... ADD CONSTRAINT ... { UNIQUE \| PRIMARY KEY } USING INDEX` | VERIFIED | Promotes an existing unique, non-partial, plain-column, default-order btree index of the table: the index keeps its oid, is renamed to the constraint (or keeps its name when none is given), `pg_constraint.conindid` points at it, `PRIMARY KEY` makes the columns `NOT NULL` (`23502` while a null is stored), and `DROP CONSTRAINT` removes both. Refusals match PostgreSQL's SQLSTATEs (`42704`, `55000`, `42809`, `42P07`, `42P16`). `DEFERRABLE` / `INITIALLY` in the clause are accepted like on a plain `ADD CONSTRAINT` (constraint deferral is not modelled for unique keys) (`tests/contract/regressions/constraint-using-index.test.ts`) |
| Text search (tsvector / tsquery / @@ / ts_rank) | PARTIALLY VERIFIED | `simple`-style config; no ispell/synonym dictionaries |
| `CREATE EXTENSION pgcrypto` / `digest()` | PARTIALLY VERIFIED | `digest(bytea, text)` and `digest(text, text)` for md5, sha1, sha224, sha256, sha384, sha512. `crypt`, `hmac`, `gen_salt`, and PGP functions are not installed. OpenSSL-only names (sha3, blake2, ripemd160, sm3) are not available. Extensions other than `pgcrypto` and `pg_trgm` still fail loud (`0A000`) |
| `pg_available_extensions`, `pg_available_extension_versions`, `pg_extension` | VERIFIED | List exactly what `CREATE EXTENSION` can install here: `pgcrypto` (1.3, 1.4), `pg_trgm` (1.3 to 1.6) and the built-in `plpgsql` (1.0), with `installed_version`, schema and version following `CREATE` / `DROP EXTENSION`, rollback and snapshots. A stock PostgreSQL server lists every contrib module it ships; those are absent here (zero rows, and `CREATE EXTENSION` is `0A000`). An older version installs the same partial function set as the default one. `DROP EXTENSION` reports dependents (`2BP01`) and `CASCADE` removes dependent defaults, generated columns, CHECK constraints, views and indexes; `DROP EXTENSION plpgsql` and `ALTER EXTENSION` fail loud (`0A000`) (`tests/contract/extensions/catalogs.test.ts`) |
| `CREATE EXTENSION pg_trgm` | PARTIALLY VERIFIED | `similarity(text, text)`, `<%` at the default word-similarity threshold 0.6, and a single-column `gin_trgm_ops` index on a `text` or `varchar` column or expression (`lower(name) public.gin_trgm_ops`; an expression of another type is `42804`, an unknown column or function inside it fails as in PostgreSQL). `gist_trgm_ops`, multicolumn `gin_trgm_ops`, and non-default thresholds are not installed. |
| `CREATE EXTENSION vector` (pgvector), `vector(n)`, `<=>` | UNSUPPORTED | Not modelled, and not a divergence from the oracle: stock PostgreSQL 18 has no pgvector either, so `CREATE EXTENSION vector` is `0A000 extension "vector" is not available`, `vector(3)` and `'[1,2,3]'::vector` are `42704`, `pg_available_extensions` has no `vector` row, and nothing is created by the failed statements. A deterministic model would have to be written from the pgvector README alone (no oracle build ships it), which this package does not do (issue #533; `tests/contract/regressions/issue-catalog-fns.test.ts`) |
| `pg_attrdef`, `pg_get_expr(adbin, adrelid)` | VERIFIED | One row per column that has a default expression or is a stored generated column (identity columns and `DEFAULT NULL` have none); `adrelid`, `adnum`, `oid` join `pg_attribute` / `pg_class`, and follow `CREATE TABLE`, `ADD COLUMN`, `SET / DROP DEFAULT` and `DROP TABLE`. `adbin` is `text` holding what `pg_get_expr` prints (PostgreSQL has a `pg_node_tree`), so `pg_get_expr(adbin, adrelid)` returns it unchanged and agrees with `information_schema.columns.column_default`. The row `oid` is derived from the table oid and column number, not allocated. This is the query SQLAlchemy's `Inspector.get_columns` and Alembic's reflection send (`tests/contract/regressions/issue-catalog-fns.test.ts`) |
| `pg_depend`, `pg_inherits`, `pg_collation`, `pg_opclass`, `pg_authid`, `pg_locks`, `pg_stat_activity` | PARTIALLY VERIFIED | Selectable with PostgreSQL 18's columns, and rows only for what the engine models: `pg_depend` has sequence ownership (`a` for `serial`, `i` for identity), column defaults and index-on-column rows (none for constraints, views, types, namespaces or TOAST); `pg_inherits` is empty (no inheritance); `pg_collation` has `default`, `C`, `POSIX`, `ucs_basic`; `pg_opclass` has the default btree class of each type and the gin classes (oids are not PostgreSQL's); `pg_authid` has the one role `postgres` (a stock server also lists the `pg_*` predefined roles); `pg_locks` shows the session's own `AccessShareLock` and virtual transaction lock; `pg_stat_activity` has the current backend (`query` is empty, `backend_type` is `client backend`, other wire sessions are not listed) (`tests/contract/regressions/issue-catalog-fns.test.ts`) |
| `hashtext`, `hashtextextended`, `sha224`, `sha256`, `sha384`, `sha512` | VERIFIED | `hash_any` / `hash_any_extended` over the UTF-8 bytes, so a key (an advisory-lock key, a shard) equals the one a real server computes, for every tail length, seeds of either sign and multi-byte text; `sha*(bytea)` need no extension. Strict (NULL in, NULL out). Used as `pg_advisory_xact_lock(hashtextextended($1, $2))` over the wire (`tests/contract/regressions/issue-catalog-fns.test.ts`, `tests/wire/catalog-fns.test.ts`) |
| `to_regclass`, `regclass` / `oid` casts and comparisons | VERIFIED | `to_regclass(text)` is `regclassin` without the errors: NULL for a missing, malformed or over-qualified name; `oid = regclass` both ways, `oid::regclass` / `integer::regclass` (printed schema-qualified only when the schema is not on the `search_path`, the number for an unknown oid), and `regclass` literals that name an index, a sequence or a `pg_catalog` relation (`'pg_class'::regclass`). A literal naming nothing is still `42P01` (`tests/contract/regressions/issue-catalog-fns.test.ts`) |
| `jsonb_to_record`, `jsonb_to_recordset`, `json_to_record`, `json_to_recordset` | VERIFIED | With the column definition list `AS r(a int, b text)` (also with `LATERAL` and joins): missing keys and JSON `null` are NULL, nested values go into `json` / `jsonb` / `text` / array columns, scalars use the column type's input (`1.5` into `int` is `22P02`; `varchar(n)` overflow is `22001`), and PostgreSQL's errors for non-arrays, non-objects, a missing list (`42601`) and a duplicate column (`42701`). `json_*` variants print a nested value into a `text` column in jsonb spelling (`{"c": 1}`), not the source text. `jsonb_populate_record(set)` (needs composite types) is not implemented |
| SQL/JSON path: `jsonb_path_exists / match / query / query_array / query_first` (and `_tz`), `@?`, `@@` | PARTIALLY VERIFIED | `lax` / `strict`, `$`, `@`, `$var` (with the `vars` and `silent` arguments), `.key`, `."key"`, `.*`, `[n]`, `[a to b]`, `[*]`, `last`, filters `? (...)` with `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `\|\|`, `!`, `exists`, `like_regex`, `starts with`, `is unknown`, arithmetic, and the methods `type()`, `size()`, `double()`, `ceiling()`, `floor()`, `abs()`; lax auto-unwrapping, strict-mode errors with PostgreSQL's SQLSTATEs, and the `jsonpath` text output in PostgreSQL's canonical spelling (`$."a"?(@ > 1)`), all differential. Refused as `0A000`: `.**`, `.keyvalue()`, the datetime methods and the `.bigint()` / `.string()` / `.boolean()` conversions (`_tz` variants behave like the plain ones: there is no datetime support to make time-zone dependent). A `like_regex` pattern is not validated when the path is parsed (`tests/contract/regressions/issue-jsonpath.test.ts`) |
| `enum_first`, `enum_last`, `enum_range` | VERIFIED | One- and two-argument forms, open bounds (`NULL`), reversed bounds give `{}`, the argument is only read for its type (`enum_range(NULL::mood)`) (`tests/contract/regressions/issue-catalog-fns.test.ts`) |
| Column label of an unnamed select-list expression | VERIFIED | PostgreSQL's `FigureColname`: the outermost cast names the column by its type as the grammar spells it (`1::int` is `int4`, `x::boolean` is `bool`, `a::jsonb::text` is `text`) unless a column or function sits inside it (`id::text` is `id`); `= ANY(...)` is `?column?`, `OVERLAPS` is `overlaps` |
| `RowDescription` type modifier (`atttypmod`) | PARTIALLY VERIFIED | Described and executed results report it for columns read from a table (also through aliases, subqueries and CTEs) and for casts to a typed name: `varchar(n)` / `char(n)` as `n + 4`, `numeric(p,s)`, `time` / `timestamp` / `timestamptz` / `interval` precision, `-1` otherwise, so `psql \gdesc` prints `character varying(32)`. Not carried: results of set operations, `VALUES`, array element types, and `RETURNING` (`tests/wire/catalog-fns.test.ts`) |
| `inet`, `cidr`, `macaddr` | PARTIALLY VERIFIED | Input and output (IPv4 and IPv6 compression and embedded-IPv4 spellings, classful `cidr` abbreviations, the seven `macaddr` forms), PostgreSQL's errors (`22P02`, `invalid cidr value`), equality, numeric ordering (family, network, mask length), `DISTINCT` / `GROUP BY` / `min` / `max`, indexes and primary keys, arrays, text casts (`inet::text` always shows the mask), `inet` / `cidr` casts, and `family`, `masklen`, `host`, `network`, `broadcast`, `netmask`. The containment and arithmetic operators (`<<`, `>>=`, `&&`, `+`, `-`, `~`, `&`, `\|`), `abbrev`, `hostmask`, `set_masklen`, `text(inet)`, `macaddr8` and binary-format transfer are not implemented; a few malformed `macaddr` spellings PostgreSQL's `sscanf` tolerates (`08002b:01020`) are refused (`tests/contract/regressions/issue-catalog-fns.test.ts`) |
| Range, multirange, geometric, `xml`, `pg_lsn`, `macaddr8`, snapshot types | UNSUPPORTED | `int4range`, `daterange`, `point`, `box`, ... fail with `0A000` (`type "int4range" is not supported`) instead of the `42704` of a name that is not a type, in casts and column definitions; nothing is created. An enum or domain with the same name is still used first |
| COPY FROM/TO (text, csv) | VERIFIED | Via `copyFrom` API hook / rows out |
| PREPARE / EXECUTE / DEALLOCATE, SET / SHOW / RESET | VERIFIED | GUC subset, including PostgreSQL dump and migration-client preambles |
| Transactions / savepoints | VERIFIED | No `25P02` aborted state (documented divergence) |
| Collation / ordering | PARTIALLY VERIFIED | `C` semantics pinned; locale/ICU out of scope |
| Regex (`~`, `~*`, POSIX functions) | PARTIALLY VERIFIED | JS regex flavor mapped to POSIX ERE; documented edges |
| EXPLAIN | PARTIALLY VERIFIED | Stub plan shapes |
| MERGE / CALL / cursors / LISTEN / full PL/pgSQL | UNSUPPORTED | Fail loud `0A000`, registered |
| Roles / GRANT / VACUUM / LOCK | NOT APPLICABLE | Parsed no-ops where harmless |
| Wire protocol / multi-session concurrency | PARTIALLY VERIFIED | `READ COMMITTED` workspaces; `FOR UPDATE`, `NOWAIT`, `SKIP LOCKED`, and deadlock detection; per-connection settings and startup `options` / run-time parameters |
| On-disk PostgreSQL format | NOT APPLICABLE | PGMM snapshots are the persistence format, also for the wire server's opt-in durable mode (snapshot persistence, not WAL) |

## How to verify

```bash
bun run test:postgres-compat # requirements + gate + contract/fuzz/harness
bun run inventory            # oracle pg_proc/pg_operator inventory
bun run requirements         # refresh PostgreSQL 18 requirements + coverage
bun run scenarios            # catalog + smoke ratchet
bun run build                # ESM browser build
```

Do not treat isolated unit tests of internal modules as proof of PostgreSQL compatibility. The differential suite is authoritative for SQL behavior; `test:postgres-compat` is the release gate.

**Parity claim:** Verified against **PostgreSQL 18.3** (PGlite). Features marked **VERIFIED** are oracle-proven. **PARTIALLY VERIFIED** rows must not be marketed as complete. **NOT APPLICABLE** is the only allowed permanent omission from the SQL drop-in claim.

## Fleet administration and portability

The wire fleet adapter supports dynamic isolated namespace listeners, finite numeric seeds,
boot/reset logical clocks, connection admission limits, private pre-ready initialization listeners
and bounded read-only inspection of the same wire engine. `mockingbird.postgres/v1` archives carry
PGMM bytes for every database plus clock, fault and PRNG state, decoded before restoring. Live
sessions remain a capture/reset conflict. Cross-service latency/fault profiles are rejected for
PostgreSQL; clock profiles are supported. This adds fleet orchestration around existing SQL and
snapshot semantics, not a broader SQL compatibility claim. Acceptance evidence is
`packages/adapters/node/fleet.management.test.ts` using the unmodified `pg` wire client.
See [Fleets](../../../docs/FLEETS.md).

## Schema preflight and row-version metadata

`analyzeSchema(sql, options)` (the package's main export) checks plain schema SQL in a discarded
in-memory database and returns a JSON-serializable report, including the installed build version,
statement offsets/lines/columns, object names, SQLSTATEs, independent failures and identifiable
missing prerequisites. Defaults cap input at 1 MiB, statements at 1,000 and diagnostics at 100;
configurable hard caps are 4 MiB, 10,000 and 1,000. It does not execute data statements, contact an
oracle or change an existing database. Accepted statements remain explicitly **unknown** for full
semantic compatibility, including deferred SQL/PL/pgSQL bodies and dynamic SQL. A detected gap sets
`compatible: false`; otherwise it stays `null`, never a claim of a verified import. Source-tree
execution identifies the version as `source-tree`; published builds embed their package version.
Lexical errors that prevent reliable statement recovery terminate the scan.

SQL and PL/pgSQL function definitions retain comma-separated `SET` lists (including `search_path`),
apply them during calls and restore the caller's settings on return or error. Portable snapshots
retain these settings. Sequence functions accept explicit `regclass` input, and
`pg_get_serial_sequence` finds owned serial, identity and explicitly owned sequences using exact
column-name case; ownership follows sequence/table/column renames and snapshots.

Stored tables expose `xmin` and `alias.xmin` as hidden `xid` system columns. INSERT, UPDATE, upsert,
COPY and referential-action writes stamp row versions with a local transaction identity; explicit
transactions share that identity, including wire workspace replay and commit. Rollback restores
committed row metadata. Snapshots preserve identities and continue allocation above retained IDs;
legacy PGMM snapshots without metadata expose frozen xid `2`. Each database/namespace owns its
allocator. These identities are version markers, not permanent globally unique row identifiers.
The implementation does not add full MVCC, VACUUM/freeze maintenance, physical tuple metadata or
xid wraparound management; it fails when the 32-bit allocation space is exhausted.

Evidence: `tests/contract/regressions/issue-queue.test.ts` (PostgreSQL 18.3 differential contracts),
`tests/contract/api/schema-report.test.ts`, and `tests/wire/issue-queue.test.ts`.
