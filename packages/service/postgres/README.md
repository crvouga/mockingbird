# postgres-mem

[npm](https://www.npmjs.com/package/@crvouga/postgres-mem) · [GitHub](https://github.com/crvouga/postgres-mem)

Pure TypeScript, completely in-memory PostgreSQL implementation aiming for **PostgreSQL 18 SQL dialect parity** (same statements → same results).

- Runs in modern browsers and Node.js / Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies
- Entire database stored in memory
- **Synchronous** ESM-only API (no Promises, no `require`)
- **SQL dialect verified** against real PostgreSQL 18.3 (PGlite by default; optional native server via `test:postgres-native`) via differential contracts + fail-closed gate
- **Not** a drop-in for `pg` / `postgres.js` client APIs, the wire protocol, or on-disk clusters
- Intentional differences: deterministic `random()` / `now()` by default, and a custom snapshot format (not `pg_dump`)

See [COMPATIBILITY.md](COMPATIBILITY.md) for the matrix, [docs/DROP-IN-CONTRACT.md](docs/DROP-IN-CONTRACT.md) for the falsifiable claim, and [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md) for what is still unproven. Agents: [AGENTS.md](AGENTS.md).

## Documentation

| Doc | For |
| --- | --- |
| [README.md](README.md) | Install, API, pitfalls (this file) |
| [AGENTS.md](AGENTS.md) | Architecture, how to change code, test/compat gates |
| [COMPATIBILITY.md](COMPATIBILITY.md) | Feature matrix + verify commands |
| [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) | Audit evidence |
| [docs/DROP-IN-CONTRACT.md](docs/DROP-IN-CONTRACT.md) | Falsifiable drop-in claim (what “same” means) |
| [docs/PROOF.md](docs/PROOF.md) | Evidence argument + what is not proven |
| [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md) | Gap analysis vs the full PostgreSQL surface |
| [docs/GAP-CATALOG.md](docs/GAP-CATALOG.md) | Current unproven / thin / intentional inventory |
| [DIVERGENCES.md](DIVERGENCES.md) | Auto-generated intentional divergences |
| [docs/SECRETS.md](docs/SECRETS.md) | npm / CI publish setup |
| [benchmarks/PERFORMANCE.md](benchmarks/PERFORMANCE.md) | Performance notes |

## Install

```bash
bun add @crvouga/postgres-mem
# or
npm install @crvouga/postgres-mem
```

Requires Node.js ≥ 20 or Bun ≥ 1.1. The published package is **ESM only** (`import` from `@crvouga/postgres-mem`).

## Usage

```ts
import { Database, Snapshot } from "@crvouga/postgres-mem";

const db = new Database();

db.exec(`
  CREATE TABLE users (
    id serial PRIMARY KEY,
    name text NOT NULL
  )
`);

db.prepare(`INSERT INTO users (name) VALUES ($1)`).run("Alice");

const users = db.query<{ id: number; name: string }>(`SELECT * FROM users`);
console.log(users);

const seed = db.snapshot();
const db2 = seed.open();
const bytes = seed.encode();
const db3 = Snapshot.decode(bytes).open();
```

All methods are **synchronous** — do not `await` them. Browser and Node/Bun share the same in-memory JS surface (no filesystem, no server, no wire protocol).

## Example

A React + Vite SQL playground lives in [`examples/react-vite`](examples/react-vite):

```bash
cd examples/react-vite
bun install
bun run dev
```

From the repo root after that install: `bun run example`.

## API

```ts
import { Database, Snapshot, PostgresError } from "@crvouga/postgres-mem";

interface DatabaseOptions {
  seed?: number | bigint;                 // default 1 — ignored when random is "os"
  random?: "deterministic" | "os";        // default "deterministic"; "os" is CSPRNG like PostgreSQL
  now?: Date | (() => Date) | "system";   // default 2000-01-01T00:00:00.000Z; "system" is wall clock
  int8?: "bigint" | "number" | "string"; // default "bigint"; "number" is unsafe beyond MAX_SAFE_INTEGER
}

interface Database {
  constructor(options?: DatabaseOptions);
  exec(sql: string): void;
  registerFunction(spec: {
    name: string;
    args: string[];
    returns: string;
    strict?: boolean;
    fn: (...args: JsValue[]) => JsValue;
  }): void;
  query<T = QueryRow>(sql: string, params?: BindValue[]): T[];
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  copyFrom(sql: string, data: string): number;  // COPY t FROM STDIN payload (\copy analog)
  snapshot(): Snapshot;
  close(): void;
  [Symbol.dispose]?(): void;        // alias for close() when Symbol.dispose exists
  readonly changes: number;         // rows affected by the most recent INSERT/UPDATE/DELETE
}

class Snapshot {
  open(options?: DatabaseOptions): Database;
  encode(): Uint8Array;
  static decode(bytes: Uint8Array): Snapshot;
}

interface Statement {
  run(...params: BindValue[]): RunResult;
  all<T = QueryRow>(...params: BindValue[]): T[];
  get<T = QueryRow>(...params: BindValue[]): T | undefined;
  result(...params: BindValue[]): ResultSet;         // includes column metadata for zero rows
  textResult(...params: BindValue[]): TextResultSet; // every cell as canonical PostgreSQL text
}

interface RunResult {
  rowCount: number;   // PostgreSQL command-tag count
  command: string;    // e.g. "INSERT", "UPDATE", "SELECT"
}

interface ResultSet {
  columns: string[];
  columnTypes: string[];  // PG internal type names, e.g. "int4", "numeric"
  rows: QueryRow[];
  rowCount: number;
  command: string;
}

class PostgresError extends Error {
  readonly category: ErrorCategory; // syntax, undefined_table, constraint_unique, misuse, …
  readonly sqlState: string;        // five-character SQLSTATE, e.g. "42P01", "23505"
  readonly code: string;            // === sqlState (node-postgres err.code convention)
}
```

Stick to `Database`, `Snapshot`, `Statement`, and `PostgresError` for application code. Advanced internals (`parse`, `tokenize`, `executeStatement`, snapshot codec pieces, `Prng`, …) are available only from `@crvouga/postgres-mem/unstable` and are **exempt from semver**.

### Method semantics

| Method | Behavior |
| --- | --- |
| `exec(sql)` | Runs all semicolon-separated statements; **discards** row results (`void`). Does **not** accept bind parameters. Read `db.changes` afterward if needed (reflects the **most recent** completed DML statement). Dump-only `DO` blocks and `ALTER TABLE … SET (` storage parameters are no-ops. |
| `registerFunction(spec)` | Install a JavaScript scalar. Not stored in PGMM snapshots; `open()` of a live snapshot copies the impl by reference. |
| `query(sql, params?)` | **Single statement only** (trailing `;` is fine). Returns all rows. Multi-statement scripts throw `misuse`. |
| `prepare(sql)` | **Single statement only**. Parses immediately; AST is reused. Pass binds as rest args to `run` / `all` / `get` / `result` on each call. |
| `transaction(fn)` | If idle: `BEGIN` → `fn()` → `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. Nested SQL `BEGIN` inside is a no-op warning like PostgreSQL. `close()` inside `fn` throws `misuse`. |
| `copyFrom(sql, data)` | Executes `COPY table [(cols)] FROM STDIN` with `data` as the copy-in payload (text or csv per the COPY options). Returns rows copied. `COPY ... TO STDOUT` output is returned as result rows by `query`. |
| `snapshot()` | Freeze a reusable {@link Snapshot} template (no encode). Illegal inside a transaction (`25P01`). |
| `Snapshot.open()` | Copy-on-write fork from a template. Parent stays open. |
| `Snapshot.encode()` | Lazy PGMM blob for persistence / worker boot (computed once, cached). |
| `Snapshot.decode(bytes)` | Decode a blob once per `Uint8Array` (WeakMap); later `open()` calls are CoW. |
| `close()` | Idempotent; rolls back an open SQL transaction; further ops throw `misuse`. Also available as `[Symbol.dispose]` when supported. |

SQL `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` are first-class. Empty / comment-only SQL on `prepare` / `query` / `exec` throws `misuse` (`empty statement`).

### Parameter binding

Parameters are PostgreSQL-style **positional `$1..$n` only** (no `?`, no named parameters — matching the PostgreSQL wire convention).

- The JS API takes **rest args** (or a positional array into `query`) — there is **no** sticky `bind()`.
- Bindable: `null` / `undefined` (→ NULL), `string` (behaves like an untyped literal — coerced by context), `number` (integer-valued → `int4`/`int8`, otherwise `float8`), `bigint` (→ `int8`, range-checked), `boolean`, `Uint8Array` (→ `bytea`), `Date` (→ `timestamptz`).
- Rejected (`misuse` / `numeric_value_out_of_range`): plain objects, symbols, functions, bigints outside int8, invalid `Date`s.

```ts
db.query(`SELECT $1::int AS a, $2 AS b`, [1, "Alice"]);
db.prepare(`SELECT $1::int8 AS id`).get(42n);
```

### Returned JavaScript types

| PostgreSQL type | JS value | Notes |
| --- | --- | --- |
| NULL | `null` | Never `undefined` |
| `bool` | `boolean` | |
| `int2` / `int4` | `number` | |
| `int8` | `bigint` | Always bigint, like node-postgres with int8 parsing |
| `float4` / `float8` | `number` | |
| `bytea` | `Uint8Array` | |
| everything else | `string` | `numeric`, `text`, `date`/`timestamp[tz]`, `interval`, `uuid`, `json[b]`, arrays, enums, … surface as **canonical PostgreSQL text** (what `psql` prints) |

Duplicate column names collapse in row objects (last write wins). Use `stmt.result().values`-style access via `rows`/`textResult()` for positional cells.

### Snapshots

- `db.snapshot()` returns a frozen in-memory {@link Snapshot}. Per-test isolation should `seed.open()` (copy-on-write, ~µs). Encoded bytes are **lazy** via `snapshot.encode()`.
- Format magic `PGMM` followed by an explicit little-endian format-version `u32` — **not** `pg_dump` output and not loadable by real PostgreSQL.
- Round-trips schemas, tables, rows, sequences (counters included), indexes, views, enums, domains, SQL functions, change counters, PRNG state, and clock. JavaScript `registerFunction` impls are omitted.
- Cannot `snapshot()` while a transaction is open (`25P01`).
- `Snapshot.decode(bytes)` does not mutate the input `Uint8Array`. The same buffer object is decoded once (WeakMap) and later opens are CoW.
- `open()` shares frozen tables until either side writes; idle `open().snapshot().encode()` is byte-identical to `snapshot().encode()`.
- `open()` uses a fixed clock from the snapshot unless you pass `{ now: "system" }`, which stays live.
- Equivalent databases produce byte-identical `encode()` output (schema/rows sorted) **within a single library version**.
- Per-test isolation (CI-tier, 200 users + 800 items): `Snapshot.open` ~µs; `encode()` / `decode().open()` is the persistence path. See [benchmarks/PERFORMANCE.md](benchmarks/PERFORMANCE.md).
- **Compatibility policy:** newer library versions can always decode older snapshots; older libraries cannot decode newer format versions (`snapshot_version`). Corrupt magic yields a distinct error.

## Determinism

The engine is deterministic by default. Invariants:

| Source | Default | Override / notes |
| --- | --- | --- |
| `random()` / `gen_random_uuid()` | Seeded xorshift64* (`seed: 1`) | `new Database({ seed })` or `{ random: "os" }` for CSPRNG (not rolled back / not restored) |
| `now()` / `current_timestamp` / friends | Fixed `2000-01-01T00:00:00.000Z` | `new Database({ now: Date \| (() => Date) \| "system" })` — `"system"` is wall clock and is **not** frozen by `open()` |
| `setseed()` / `random()` | Deterministic stream | Matches the engine PRNG, repeatable |
| Table scans | Insertion order | Same order after `snapshot`/`restore` |
| Snapshots | Sorted schema/rows + PRNG state + clock | Restored into PRNG and `now` |
| Transactions | PRNG rolls back with `ROLLBACK`/`SAVEPOINT` | Matches data rollback |
| `float8 -0` | Sign preserved | `(-0)::text` is `'-0'`, matching PostgreSQL |

Fuzz / property tests use a fixed seed (`0x5a17e0e1`) and print it on failure:

```bash
bun test tests/fuzz
bun run test:pbt:random -- 50   # N random seeds, fail fast on first mismatch
POSTGRES_MEM_FUZZ_SEED=12345 bun test tests/fuzz
POSTGRES_MEM_FUZZ_SEED=12345 POSTGRES_MEM_FUZZ_PATH='0:1' bun test tests/fuzz  # exact replay
```

## Stability policy

The exports of the main entry (`@crvouga/postgres-mem`) are **frozen**:

- **Never** outside a major: removals, renames, signature changes, or changes to documented behavior of the stable surface.
- **Allowed in minors:** additions (new methods, new optional `DatabaseOptions` fields, new `ErrorCategory` values). Consumers that `switch` on `category` must include a default case — new categories may appear without a major bump.
- **`@crvouga/postgres-mem/unstable`** is exempt from semver and may change or disappear in any release.
- **Snapshots:** newer library → can restore older blobs; older library → cannot restore newer format versions; byte-identical snapshot guarantee holds only within one library version.

## Compatibility notes for integrators

Goal: **SQL dialect** behavioral parity vs PostgreSQL **18.3** for the `@crvouga/postgres-mem` sync API. Full matrix: [COMPATIBILITY.md](COMPATIBILITY.md). Contract: [docs/DROP-IN-CONTRACT.md](docs/DROP-IN-CONTRACT.md).

This is **not** a drop-in replacement for `pg`, `postgres.js`, or PGlite's client API. There is no wire protocol, no async client, no connection pooling, no `pg_dump` codec, and no multi-session concurrency.

**Intentional differences:** custom `PGMM` snapshots; seeded `random()` / fixed `now()` by default (`{ random: "os" }` / `{ now: "system" }` match PostgreSQL entropy and wall clock); single session — no MVCC across connections. Machine-readable list: [DIVERGENCES.md](DIVERGENCES.md).

**Know these thin or partial areas** (do not assume full oracle fidelity):

- `EXPLAIN` — stub plan shapes, not real planner output
- Failed statements inside `BEGIN` do **not** poison the transaction (`25P02` aborted-state is not implemented)
- Triggers fire in **creation order** (PostgreSQL: name order); `UPDATE OF` column lists are ignored; `INSTEAD OF` is unsupported
- `COMMENT ON` parses but comments are not stored
- `round(float8)` rounds ties away from zero (PostgreSQL: half-to-even); numeric `round()` has full parity
- `'1e400'::float8` saturates to `Infinity` instead of raising `22003`
- `MERGE`, `CALL`/procedures, cursors (`DECLARE`/`FETCH`), `LISTEN`/`NOTIFY`, and full PL/pgSQL (packages, NOTICE, cursors) fail loud (`0A000`)
- `VACUUM` / `ANALYZE` / `CLUSTER` / `REINDEX` / `CHECKPOINT` / `GRANT` / `REVOKE` / `LOCK` are parsed no-ops
- Collation is `C` semantics (byte order); locale/ICU-dependent ordering is out of scope

**Also supported (oracle-parity):** schemas + `search_path`, `pg_catalog` / `information_schema` introspection, sequences (`serial`, identity, `nextval`/`currval`/`setval`), enums, domains, `LANGUAGE sql` functions, plpgsql-lite UDFs (`DECLARE`, `EXCEPTION WHEN others`, `RETURN NEXT`), row-level triggers, recursive + data-modifying CTEs, window functions with full frame specs, `GROUPING SETS`/`ROLLUP`/`CUBE`, `DISTINCT ON`, `LATERAL`, arrays + `unnest` + subscripting, JSON/JSONB operator + function surface including `jsonb_path_query_first`, `tsvector` text search, `ON CONFLICT DO NOTHING/UPDATE`, `RETURNING`, `PREPARE`/`EXECUTE`/`DEALLOCATE`, `SET`/`SHOW`/`RESET` GUCs, `COPY` text and csv.

## Common pitfalls

1. **Do not `await`** — the API is sync.
2. **Parameters are `$1..$n` only** — no `?` placeholders, no named parameters, no sticky `bind()`.
3. **`query` / `prepare` are single-statement only** — multi-statement scripts belong in `exec()` (which does not take bind parameters).
4. **`exec` returns `void` and takes no params** — use `db.prepare(…).run(…)` or `db.query(…)` for binds; use `db.changes` / `stmt.run().rowCount` for counters.
5. **`now()` is not wall-clock** unless you pass `{ now: "system" }` or `{ now: () => new Date() }`. Default is year 2000. `open()` freezes a snapshot clock except when constructed with `"system"`.
6. **`random()` is seeded**, not OS entropy, unless you pass `{ random: "os" }`. Snapshots restore the seeded PRNG; OS entropy is not rewound.
7. **Snapshots are not `pg_dump` output** and cannot be loaded into real PostgreSQL.
8. **`int8` comes back as `bigint` by default** (`{ int8: "number" | "string" }` opts in). `numeric`/dates/json come back as **text** — parse them explicitly if you need JS numbers/objects.
9. **A failed statement does not abort the transaction** — real PostgreSQL rejects everything after an error inside `BEGIN` until `ROLLBACK`; postgres-mem keeps executing (documented divergence).
10. **Unquoted identifiers fold to lowercase** (PostgreSQL rule — not uppercase like the SQL standard).
11. **Do not import `@crvouga/postgres-mem/unstable` in application code** unless you accept breakage in any release.

Working examples beyond this README: `examples/react-vite`, `tests/contract/api/`, and `tests/contract/parameters/`.

## Development

Requires [Bun](https://bun.sh). For architecture, change checklists, and how to add contract tests, see **[AGENTS.md](AGENTS.md)**.

Parity is proven by differential contracts against real PostgreSQL — default oracle PGlite (18.3 in WASM), plus optional native PostgreSQL 18.3 via `bun run test:postgres-native`. Isolated internal unit tests are not PostgreSQL compatibility proof.

```bash
bun install
bun run check:full               # same gates as GitHub Actions CI (except publish)
bun run check                  # format + lint + typecheck + postgres-compat suite
bun run format                 # write Biome formatting
bun run lint                   # Biome lint
bun run typecheck
bun run test:postgres-compat   # requirements + inventory gate + differential suite (PGlite)
bun run test:postgres-native   # same differential suite vs real PostgreSQL 18.3
bun test                       # contract + fuzz + harness
bun run build
```

See [COMPATIBILITY.md](./COMPATIBILITY.md).

## Releasing

Publishing is fully automated. You never bump `version` or run `npm publish` by hand.

### How a release happens

1. Push or merge to `main`. Prefer [Conventional Commits](https://www.conventionalcommits.org/) so the bump is `feat` → minor / `fix` → patch / `BREAKING` → major; any other subject still publishes a patch.
2. CI runs commitlint, format/lint/typecheck, build, package verification, tests, browser smoke, and benchmarks.
3. If every gate is green, [semantic-release](https://semantic-release.gitbook.io/) analyzes commits since the last git tag, bumps semver, publishes to npm, and creates a GitHub Release.

| Commit | Version bump |
| --- | --- |
| `fix: …` / `perf: …` | patch (`1.0.1` → `1.0.2`) |
| `feat: …` | minor (`1.0.1` → `1.1.0`) |
| `feat!: …` or `BREAKING CHANGE:` footer | major (`1.1.0` → `2.0.0`) |
| any other message on `main` (including Cursor-style subjects) | patch |

PR titles must also follow Conventional Commits (enforced in CI). Prefer squash merges with a conventional title.

Local checks:

```bash
bun run check:full             # commitlint + quality + tests + browser + benchmarks
# dry-run needs a GitHub token for API calls; CI publish uses Trusted Publishing (no NPM_TOKEN)
bun run release:dry-run
```

`package.json` version is `0.0.0-development` on purpose — **git tags** (`v0.1.0`, …) are the source of truth.

### One-time setup (maintainers)

Do this once so CI can publish. Full checklist: **[docs/SECRETS.md](./docs/SECRETS.md)**.

1. **Create the package on npm (once), then Trusted Publishing.** If https://www.npmjs.com/package/@crvouga/postgres-mem 404s:

   ```bash
   npm login --auth-type=web
   bun run npm:seed -- --yes
   ```

   npm does not email a publish code — complete 2FA in the browser or authenticator app.

   Then on [package Access](https://www.npmjs.com/package/@crvouga/postgres-mem/access) → Trusted Publisher → GitHub Actions (`crvouga/postgres-mem`, workflow `ci.yml`). Do **not** create an Automation / granular access token for CI.
2. Confirm GitHub Actions is enabled and can create releases (default `GITHUB_TOKEN` is enough with this workflow’s permissions). No `NPM_TOKEN` repo secret.
3. Ensure the baseline tag exists and is pushed: `v0.1.0` (semver continues from there; the next `feat` publishes `0.2.0`).

Validate the checklist anytime with `bun run secrets:doctor`.

After that, every green push to `main` updates npm automatically (`feat`/`fix`/`BREAKING` pick the bump; anything else is a patch).

## License

MIT
