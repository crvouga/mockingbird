# AGENTS.md — contributing to sqlite-mem

Guidance for humans and coding agents editing this repository. For install and consumer API, see [README.md](README.md). For the feature matrix, see [COMPATIBILITY.md](COMPATIBILITY.md).

## Mission and non-goals

**Mission:** full SQLite3 **SQL dialect** behavioral parity vs **SQLite 3.51.0** (`bun:sqlite`). Same statements → same observable results (rows, errors, counters), proven by differential contracts and a fail-closed gate.

**Allowed intentional differences:**

1. Custom snapshot codec (`SQLM`), not on-disk `.sqlite` files
2. Deterministic `random()` / `randomblob()` and fixed `'now'` by default (injectable)
3. `NOT APPLICABLE` items: C API, VFS/pager/WAL, file locking, URI filenames

**Non-goals:** shipping a SQLite file format, native/WASM bindings, or matching better-sqlite3’s full Node API surface.

## SQL pipeline

```
SQL string
  → tokenize()          src/lexer/tokenize.ts
  → parse()             src/parser/index.ts → parser.ts
  → Statement[] AST     src/ast/nodes.ts
  → Statement.execute() src/api/statement.ts
  → executeStatement()  src/executor/execute.ts
  → per-stmt executor   select / dml / ddl / …
```

Public entry points: `Database.exec` / `query` / `prepare` in [`src/api/database.ts`](src/api/database.ts).

**Planner note:** [`src/planner/index.ts`](src/planner/index.ts) `preparePlan` is an **identity stub** (`Plan === Statement`) and is unused. Runtime index/PK access paths live in [`src/planner/access.ts`](src/planner/access.ts) (`tryIndexedTableRows`, `lookupTableRows`, `tryJoinProbe`), called from the executor.

SELECT has a **fast path** ([`src/executor/simple-select.ts`](src/executor/simple-select.ts)) and a **full path** ([`src/executor/select.ts`](src/executor/select.ts)). Fast paths return `null` when the shape is unsupported; then the full path runs. Changing join/WHERE/expression semantics in only one path will silently diverge.

## `src/` map

| Directory | Role |
| --- | --- |
| `api/` | Public `Database` / `Statement` facade |
| `ast/` | Discriminated-union AST (`nodes.ts`) |
| `lexer/` | Tokenizer |
| `parser/` | Recursive-descent parser |
| `planner/` | Access-path helpers (not a logical plan IR) |
| `executor/` | Statement dispatch, SELECT, DML, DDL, PRAGMA, triggers, ATTACH |
| `expressions/` | `evalExpr`, LIKE/GLOB, eval context |
| `functions/` | Scalar / aggregate / window / datetime / JSON / math / TVF registries |
| `types/` | Engine `SqlValue`, affinity, collation |
| `storage/` | In-memory tables, rows, `DatabaseState` |
| `indexes/` | Equality index store |
| `schema/` | `sqlite_master` / catalog |
| `constraints/` | NOT NULL / PK / UNIQUE / CHECK |
| `transactions/` | BEGIN / COMMIT / SAVEPOINT (clones state + PRNG) |
| `runtime/` | Clock, PRNG, `DatabaseOptions` |
| `serialization/` | `SQLM` snapshot codec |
| `json/` | JSON1 / JSONB internals |
| `vtable/` | FTS5 and other virtual-table modules |
| `errors/` | `SqliteError`, `unsupported()` |

Hot / large files: `parser/parser.ts`, `executor/select.ts`, `executor/dml.ts`.

## Critical conventions

- **AST `type` tags** are snake_case (`"create_table"`, `"drop_index"`). TypeScript interfaces are PascalCase (`CreateTableStmt`).
- **Identifiers** are case-folded (`toLowerCase`) as Map keys in storage and function registries.
- **Engine `SqlValue`** ([`src/types/value.ts`](src/types/value.ts)) may include `SqlReal` / `SqlJsonText`. **Harness `SqlValue`** ([`tests/harness/types.ts`](tests/harness/types.ts)) is the normalized compare type — do not confuse them.
- **API `Statement`** vs **AST `Statement`**: the API class aliases the AST union as `AstStatement`.
- **`Database`** (API) vs **`DatabaseState`** (engine storage).
- Throw **`SqliteError`** with an `ErrorCategory`. Missing SQL must fail loud via `unsupported()` — the inventory gate fails if the oracle exposes an unimplemented builtin/module.
- Fast-path helpers (`tryExecuteSimpleSelect`, `tryFastInsert`, `tryIndexedTableRows`, …): return `null` → fall through. Update **both** paths when semantics change.
- **Dual-path invariant:** residual `WHERE` filtering is skipped on an index/hash access path only when `whereFullyCovered(where, coveredColumns, …)` is true (see [`src/planner/access.ts`](src/planner/access.ts)). Any change to WHERE/join/insert semantics requires updating both fast and full paths **and** the fast≡full property tests under `tests/fuzz/fast-path.test.ts`.
- Internal invariants use always-on asserts in [`src/runtime/assert.ts`](src/runtime/assert.ts) (`assert`, `assertUnreachable`, `assertRowShape`).
- TypeScript: `strict` + `noUncheckedIndexedAccess`. Imports use `.ts` extensions. Biome: 2-space, double quotes, 120 columns.
- IEEE `-0` is canonicalized to `+0` on bind, affinity, and arithmetic. Keep determinism invariants (see README).

## Change checklists

### New SQL statement

1. Add union member + interface in [`src/ast/nodes.ts`](src/ast/nodes.ts)
2. Parse in [`src/parser/parser.ts`](src/parser/parser.ts) (`parseStatement` dispatch)
3. Handle in [`src/executor/execute.ts`](src/executor/execute.ts) (+ `ddl.ts` / `dml.ts` / `vtable.ts` as needed)
4. Mutate `DatabaseState` if schema changes
5. Add differential contract under `tests/contract/<area>/`
6. Optionally add evidence paths in `SOURCE_SEED` in [`scripts/sqlite-requirements.ts`](scripts/sqlite-requirements.ts), then `bun run requirements`

### New SQL function

1. Implement and register in the right map under `src/functions/*` (`getScalarFunctions()`, datetime, JSON, etc.) so [`scripts/sqlite-inventory.ts`](scripts/sqlite-inventory.ts) sees it
2. Contract tests under `tests/contract/functions/` (and related areas)
3. Run `bun run inventory` / `bun run test:sqlite-compat` — oracle builtins must not be missing

### New contract test

1. Prefer helpers in [`tests/contract/helpers.ts`](tests/contract/helpers.ts):
   - `parity` — query both engines
   - `execParity` — writes
   - `sequenceParity` — multi-step (optional final-state compare)
   - `errorParity` / `queryErrorParity` — both must fail
   - `ftsRankParity` — REAL epsilon compare
2. Or `matrixBoth` + `expectParity` from `tests/harness/`
3. **Do not** treat isolated internal unit tests as SQLite proof. The differential suite is authoritative.
4. Gate: `bun run test:sqlite-compat`

## Test layout

| Path | Role |
| --- | --- |
| `tests/contract/` | Differential SQL vs `bun:sqlite` (**authoritative**) |
| `tests/fuzz/` | fast-check property tests (seeded); same two backends |
| `tests/harness/` | Compare/normalize helpers + harness unit tests |
| `tests/adapters/` | Wrappers for sqlite-mem and `bun:sqlite` |

Examples of public API usage: `tests/contract/api/`, `tests/contract/parameters/`, `tests/contract/determinism/`, `examples/react-vite`.

### Fuzz replay

Default seed `0x5a17e0e1`. On failure the seed is printed:

```bash
bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
```

### Random walk (state-dependent DST)

`tests/fuzz/random-walk.test.ts` walks the SQL state space one enabled action at
a time and asserts result + logical-state parity after every step.

```bash
bun run test:walk
SQLITE_MEM_WALK_STEPS=80 bun run test:walk
bun run test:walk:soak -- --depth 200 --runs 20
```

## Compat system

| Command | Role |
| --- | --- |
| `bun run test:sqlite-compat` | Requirements + fail-closed gate + construct catalog + 𝔇 + smoke ratchet + contract/fuzz/harness |
| `bun run inventory` | Oracle `pragma_function_list` / modules vs memory registries |
| `bun run scenarios` | Construct-level scenario catalog (`compat/scenarios.ts`) + 𝔇 / smoke gates |
| `bun run requirements` | Refresh sqlite.org requirements → `compat/requirements.json` + `compat/coverage.json` |
| `bun run fts-surface` | FTS oracle surface → `compat/fts-oracle-surface.json` |

Statuses: **VERIFIED** / **PARTIALLY VERIFIED** / **UNSUPPORTED** / **NOT APPLICABLE**. Do not market PARTIAL as complete. Coverage evidence is directory paths (e.g. `tests/contract/joins/`), not automatic from test filenames.

**Catalog vs proof:** `tests/contract/catalog/` IDs must execute; smoke (`SELECT 1 AS v`) is tracked in `compat/smoke-baseline.json`. Documented divergences bind to `compat/divergences.json`. Generated operator/CAST matrices: `tests/contract/matrices/`. Stateful dump-after-each fuzz: `tests/fuzz/stateful.test.ts`. Oracle `sqlite_version()` must be 3.51.0 or 3.53.0.

Details: [COMPATIBILITY.md](COMPATIBILITY.md), audit: [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md).

## Local gates

Requires [Bun](https://bun.sh).

```bash
bun install
bun run check:full             # same gates as GitHub Actions CI (except publish)
bun run check                # format + lint + typecheck + sqlite-compat suite
bun run format
bun run lint
bun run typecheck
bun run test:sqlite-compat
bun test                     # contract + fuzz + harness
bun run build
```

## PR and commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commits and PR titles (enforced on PRs). Prefer squash merges with a conventional title so the npm bump is `feat` → minor / `fix` → patch. Direct pushes to `main` with any other subject still publish a patch. See [README.md](README.md#releasing).
