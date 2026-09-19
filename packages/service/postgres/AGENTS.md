# AGENTS.md — contributing to postgres-mem

Guidance for humans and coding agents editing this repository. For install and consumer API, see [README.md](README.md). For the feature matrix, see [COMPATIBILITY.md](COMPATIBILITY.md).

## Mission and non-goals

**Mission:** PostgreSQL 18 **SQL dialect** behavioral parity vs **PostgreSQL 18.3** (PGlite, `@electric-sql/pglite`). Same statements → same observable results (rows, errors, SQLSTATEs, row counts), proven by differential contracts and a fail-closed gate.

**Allowed intentional differences:**

1. Custom snapshot codec (`PGMM`), not `pg_dump` / on-disk clusters
2. Deterministic `random()` / `gen_random_uuid()` and fixed `now()` by default (injectable)
3. Single-session engine: no MVCC across connections, no wire protocol, no aborted-transaction (`25P02`) state
4. `NOT APPLICABLE` items: roles/auth enforcement, replication, VACUUM internals, storage params, full PL/pgSQL

**Non-goals:** speaking the wire protocol, matching `pg`/`postgres.js` client APIs, full PL/pgSQL, or multi-session concurrency.

## SQL pipeline

```
SQL string
 → tokenize() src/lexer/tokenize.ts
 → parse() src/parser/index.ts → parser.ts
 → Statement[] AST src/ast/nodes.ts
 → Statement.execute() src/api/statement.ts
 → executeStatement() src/executor/execute.ts
 → per-stmt executor select / dml / ddl / session / triggers
```

Public entry points: `Database.exec` / `query` / `prepare` / `copyFrom` in [`src/api/database.ts`](src/api/database.ts).

Everything is **typed values** (`TypedValue = { t: TypeId, v: Datum }` in [`src/types/value.ts`](src/types/value.ts)) — there is no SQLite-style affinity. Type resolution/casting lives in [`src/types/resolve.ts`](src/types/resolve.ts) and [`src/types/cast.ts`](src/types/cast.ts); `numeric` is an in-repo arbitrary-precision implementation ([`src/types/numeric.ts`](src/types/numeric.ts)).

## `src/` map

| Directory | Role |
| --- | --- |
| `api/` | Public `Database` / `Statement` facade, bind-value conversion |
| `ast/` | Discriminated-union AST (`nodes.ts`) |
| `lexer/` | Tokenizer (dollar quoting, E-strings, `::`, operators) |
| `parser/` | Recursive-descent parser |
| `executor/` | Statement dispatch, SELECT, DML, DDL, session (SET/SHOW/COPY/PREPARE), triggers, plpgsql-lite UDFs, window functions |
| `expressions/` | `evalExpr`, operators, pattern matching, `EngineCtx` |
| `functions/` | Scalar / aggregate / window / datetime / JSON / array / SRF / tsearch registries |
| `types/` | `TypedValue`, casts, comparison, numeric, datetime, jsonb, timezone |
| `storage/` | In-memory schemas, tables, sequences, `DatabaseState` |
| `schema/` | `pg_catalog` + `information_schema` virtual catalogs, `search_path` |
| `constraints/` | NOT NULL / PK / UNIQUE / CHECK / FK with referential actions |
| `transactions/` | BEGIN / COMMIT / SAVEPOINT (clones state + PRNG) |
| `runtime/` | Clock, PRNG, `DatabaseOptions` |
| `serialization/` | `PGMM` snapshot codec |
| `tsearch/` | `tsvector` / `tsquery` text search |
| `errors/` | `PostgresError` with SQLSTATE, `unsupported()` |

Hot / large files: `parser/parser.ts`, `executor/select.ts`, `executor/dml.ts`, `types/numeric.ts`.

## Critical conventions

- **AST `type` tags** are snake_case (`"create_table"`, `"drop_index"`). TypeScript interfaces are PascalCase (`CreateTableStmt`).
- **Identifiers** fold to **lowercase** unless double-quoted (PostgreSQL rule); quoted identifiers are case-sensitive.
- **Engine values** are `TypedValue` with PG internal type names (`int4`, `float8`, `numeric`, `timestamptz`, `_int4` for arrays). **Harness `SqlValue`** ([`tests/harness/types.ts`](tests/harness/types.ts)) is the normalized compare type — do not confuse them.
- **API `Statement`** vs **AST `Statement`**: the API class aliases the AST union as `AstStatement`.
- **`Database`** (API) vs **`DatabaseState`** (engine storage).
- Throw **`PostgresError`** with an `ErrorCategory` and a five-character **SQLSTATE**. Missing SQL must fail loud via `unsupported()` (`0A000`) — the inventory gate fails if the oracle exposes an unimplemented builtin/operator that isn't in `compat/unsupported-register.json`.
- The public API is **sync**; the oracle (PGlite) is **async** — contract helpers `await` both sides through the `ContractDb` adapter interface.
- TypeScript: `strict` + `noUncheckedIndexedAccess`. Imports use `.ts` extensions. Biome: 2-space, double quotes, 120 columns.
- Determinism invariants (seeded PRNG, fixed clock, PRNG rollback with transactions, byte-identical snapshots) must hold — see README.

## Change checklists

### New SQL statement

1. Add union member + interface in [`src/ast/nodes.ts`](src/ast/nodes.ts)
2. Parse in [`src/parser/parser.ts`](src/parser/parser.ts) (`parseStatement` dispatch)
3. Handle in [`src/executor/execute.ts`](src/executor/execute.ts) (+ `ddl.ts` / `dml.ts` / `session.ts` as needed)
4. Mutate `DatabaseState` if schema changes; keep `pg_catalog` / `information_schema` views consistent
5. Add differential contract under `tests/contract/<area>/`
6. Add/extend a scenario row in `compat/sections/*.ts` and its catalog test in `tests/contract/catalog/`

### New SQL function or operator

1. Implement and register in the right map under `src/functions/*` (or `src/expressions/operators.ts`) so [`scripts/postgres-inventory.ts`](scripts/postgres-inventory.ts) sees it; remove any matching entry from `compat/unsupported-register.json`
2. Contract tests under `tests/contract/functions/` (and related areas)
3. Run `bun run inventory` / `bun run test:postgres-compat` — oracle builtins must not be silently missing

### New contract test

1. Prefer helpers in [`tests/contract/helpers.ts`](tests/contract/helpers.ts):
 - `parity` — query both engines, compare rows
 - `parityTyped` — also compare column type names
 - `execParity` — writes (row counts + final state)
 - `sequenceParity` — multi-step (optional final-state compare)
 - `errorParity` / `queryErrorParity` — both must fail with the same SQLSTATE class
 - `rankParity` — REAL epsilon compare (ts_rank etc.)
 - `divergence` — engine-only assertion pinned to a `compat/divergences.json` entry
2. Or `matrixBoth` + `expectParity` from `tests/harness/`
3. **Do not** treat isolated internal unit tests as PostgreSQL proof. The differential suite is authoritative.
4. Gate: `bun run test:postgres-compat`

## Test layout

| Path | Role |
| --- | --- |
| `tests/contract/` | Differential SQL vs oracle (**authoritative**; default PGlite, optional native via `test:postgres-native`) |
| `tests/fuzz/` | fast-check property tests (seeded); differential, NoREC/TLP metamorphic, stateful DST |
| `tests/harness/` | Compare/normalize/classify helpers + harness unit tests |
| `tests/adapters/` | Wrappers for postgres-mem, PGlite, and native Postgres (`ContractDb`) |
| `tests/corpus/` | Fuzz regression corpus |
| `tests/meta/` | Canary definitions, skip register |

Examples of public API usage: `tests/contract/api/`, `tests/contract/parameters/`, `tests/contract/determinism/`, `examples/react-vite`.

### Fuzz replay

Default seed `0x5a17e0e1`. On failure the seed is printed:

```bash
bun test tests/fuzz
POSTGRES_MEM_FUZZ_SEED=12345 bun test tests/fuzz
POSTGRES_MEM_FUZZ_SEED=12345 POSTGRES_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
```

### Random walk (state-dependent DST)

`tests/fuzz/random-walk.test.ts` walks the SQL state space one enabled action at
a time and asserts result + logical-state parity after every step.

```bash
bun run test:walk
POSTGRES_MEM_WALK_STEPS=60 bun run test:walk
bun run test:walk:soak -- --depth 200 --runs 20
```

## Compat system

| Command | Role |
| --- | --- |
| `bun run test:postgres-compat` | Requirements + fail-closed gate + construct catalog + smoke ratchet + contract/fuzz/harness (PGlite oracle) |
| `bun run test:postgres-native` | Same differential suite vs real PostgreSQL 18.3 (embedded-postgres, or `POSTGRES_MEM_ORACLE_URL`) |
| `bun run inventory` | Oracle `pg_proc` / `pg_operator` vs engine registries (+ `--write-register`) |
| `bun run scenarios` | Construct-level scenario catalog (`compat/scenarios.ts`) + smoke gate |
| `bun run requirements` | Refresh PostgreSQL 18 SQL-commands docs → `compat/requirements.json` + `compat/coverage.json` |
| `bun run canaries` | Apply deliberate sabotages, assert the suite catches them |

Statuses: **VERIFIED** / **PARTIALLY VERIFIED** / **UNSUPPORTED** / **NOT APPLICABLE**. Do not market PARTIAL as complete. Coverage evidence is directory paths (e.g. `tests/contract/joins/`), not automatic from test filenames.

**Catalog vs proof:** `tests/contract/catalog/` IDs must execute; trivial probes are tracked in `compat/smoke-baseline.json` (ratchet — no new smoke stubs). Documented divergences bind to `compat/divergences.json` (regenerate `DIVERGENCES.md` with `bun run divergences`). Generated operator/CAST matrices: `tests/contract/matrices/`. Stateful dump-after-each fuzz: `tests/fuzz/stateful.test.ts`. Oracle `server_version` must be on the allow-list in `tests/harness/oracle-versions.ts` (18.3).

**PGlite quirk:** PGlite's WASM boot leaks `process.exitCode = 99` under Bun ([pglite#975](https://github.com/electric-sql/pglite/issues/975)); the adapter and scripts reset it — keep that workaround when touching `tests/adapters/pglite.ts`.

**Native oracle:** `POSTGRES_MEM_ORACLE=server` + `POSTGRES_MEM_ORACLE_URL` selects `PostgresServerAdapter`. Prefer `bun run test:postgres-native` (starts embedded-postgres 18.3). Optional Docker: `docker-compose.oracle.yml`.

Details: [COMPATIBILITY.md](COMPATIBILITY.md), audit: [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md).

## Local gates

Requires [Bun](https://bun.sh).

```bash
bun install
bun run check:full # same gates as GitHub Actions CI (except publish)
bun run check # format + lint + typecheck + postgres-compat suite
bun run format
bun run lint
bun run typecheck
bun run test:postgres-compat
bun run test:postgres-native # optional second oracle (real PostgreSQL 18.3)
bun test # contract + fuzz + harness
bun run build
```

## PR and commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commits and PR titles (enforced on PRs). Prefer squash merges with a conventional title so the npm bump is `feat` → minor / `fix` → patch. Direct pushes to `main` with any other subject still publish a patch. See [README.md](README.md#releasing).
