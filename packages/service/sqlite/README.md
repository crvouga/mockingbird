# sqlite-mem

[npm](https://www.npmjs.com/package/@crvouga/sqlite-mem) · [GitHub](https://github.com/crvouga/sqlite-mem)

Pure TypeScript, completely in-memory SQLite implementation aiming for **full SQLite3 SQL dialect parity** (same statements → same results).

- Runs in modern browsers and Node.js / Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies
- Entire database stored in memory
- **Synchronous** ESM-only API (no Promises, no `require`)
- **SQL dialect verified** against SQLite 3.51.0 / 3.53.0 (`bun:sqlite`) via differential contracts + fail-closed gate
- **Not** a drop-in for `sql.js` / `sqlite-wasm` APIs, on-disk `.sqlite` files, or user-defined functions
- Intentional differences: deterministic `random()` / `'now'` by default, and a custom snapshot format (not `.sqlite` files)

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
| [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md) | Phase 0 gap analysis vs full drop-in catalog |
| [docs/GAP-CATALOG.md](docs/GAP-CATALOG.md) | Current unproven / thin / intentional inventory |
| [DIVERGENCES.md](DIVERGENCES.md) | Auto-generated intentional divergences |
| [docs/SECRETS.md](docs/SECRETS.md) | npm / CI publish setup |
| [benchmarks/PERFORMANCE.md](benchmarks/PERFORMANCE.md) | Performance notes |

## Install

```bash
bun add @crvouga/sqlite-mem
# or
npm install @crvouga/sqlite-mem
```

Requires Node.js ≥ 20 or Bun ≥ 1.1. The published package is **ESM only** (`import` from `@crvouga/sqlite-mem`).

## Usage

```ts
import { Database, Snapshot } from "@crvouga/sqlite-mem";

const db = new Database();

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )
`);

db.prepare(`INSERT INTO users (name) VALUES (?)`).run("Alice");

const users = db.query<{ id: number; name: string }>(`SELECT * FROM users`);
console.log(users);

const seed = db.snapshot();
const db2 = seed.open();
const bytes = seed.encode();
const db3 = Snapshot.decode(bytes).open();
```

All methods are **synchronous** — do not `await` them. Browser and Node/Bun share the same in-memory JS surface (no filesystem; `ATTACH` opens a new empty in-memory schema, not a file).

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
import { Database, Snapshot, SqliteError } from "@crvouga/sqlite-mem";

interface DatabaseOptions {
  seed?: number | bigint;                 // default 1 — ignored when random is "os"
  random?: "deterministic" | "os";        // default "deterministic"; "os" is CSPRNG like SQLite
  now?: Date | (() => Date) | "system";   // default 2000-01-01T00:00:00.000Z; "system" is wall clock
}

interface Database {
  constructor(options?: DatabaseOptions);
  exec(sql: string): void;
  query<T = QueryRow>(sql: string, params?: BindValue[]): T[];
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  snapshot(): Snapshot;
  close(): void;
  [Symbol.dispose]?(): void;        // alias for close() when Symbol.dispose exists
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface Statement {
  run(...params: BindValue[]): RunResult;
  all<T = QueryRow>(...params: BindValue[]): T[];
  get<T = QueryRow>(...params: BindValue[]): T | undefined;
  result(...params: BindValue[]): ResultSet; // includes columns + values when zero rows
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface ResultSet {
  columns: string[];
  rows: QueryRow[];
  values: QueryValue[][];           // always present (empty array for zero rows)
  changes: number;
  lastInsertRowid: number | bigint;
}

class Snapshot {
  open(options?: DatabaseOptions): Database;
  encode(): Uint8Array;
  static decode(bytes: Uint8Array): Snapshot;
}

class SqliteError extends Error {
  readonly category: ErrorCategory; // syntax, no_such_table, constraint_unique, misuse, …
  readonly sqliteCode: string;      // always set; default "SQLITE_ERROR"
  readonly code: string;            // === sqliteCode (Node err.code convention)
}
```

Stick to `Database`, `Snapshot`, `Statement`, and `SqliteError` for application code. Advanced internals (`parse`, `tokenize`, `evalExpr`, snapshot codec pieces, `SqlValue` utilities, `Prng`, …) are available only from `@crvouga/sqlite-mem/unstable` and are **exempt from semver**.

### Method semantics

| Method | Behavior |
| --- | --- |
| `exec(sql)` | Runs all semicolon-separated statements; **discards** row results (`void`). Does **not** accept bind parameters. Read `db.changes` / `db.lastInsertRowid` afterward if needed (counters reflect the **most recent** completed statement, matching SQLite). |
| `query(sql, params?)` | **Single statement only** (trailing `;` is fine). Returns all rows. Multi-statement scripts throw `misuse`. |
| `prepare(sql)` | **Single statement only**. Parses immediately; AST is reused. Pass binds as rest args to `run` / `all` / `get` / `result` on each call. |
| `transaction(fn)` | If idle: `BEGIN` → `fn()` → `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. Nested SQL `BEGIN` still errors. `close()` inside `fn` throws `misuse`. |
| `snapshot()` | Freeze a reusable {@link Snapshot} template (no encode). Illegal inside a transaction. |
| `Snapshot.open()` | Copy-on-write fork from a template. Parent stays open. |
| `Snapshot.encode()` | Lazy SQLM blob for persistence / worker boot (computed once, cached). |
| `Snapshot.decode(bytes)` | Decode a blob once per `Uint8Array` (WeakMap); later `open()` calls are CoW. |
| `close()` | Idempotent; rolls back an open SQL transaction; further ops throw `misuse`. Also available as `[Symbol.dispose]` when supported. |

SQL `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` are first-class. Empty / comment-only SQL on `prepare` / `query` throws `misuse` (`empty statement`), matching SQLite prepare failure.

### Parameter binding

Supported styles: `?`, `?NNN`, `:name`, `@name`, `$name`.

- The JS API takes **rest args** (or a positional array into `query`) only — there is **no** sticky `bind()` and **no** `bind({ name: value })`.
- Named parameters occupy slots in **first-occurrence order**; repeated names share one slot.
- Prefixes are part of the name: `@x`, `$x`, and `:x` are **three different** parameters.
- Names are lowercased for lookup (`:Left` ≡ `:left`).
- Bindable: `null`, `string`, finite `number`, `bigint`, `boolean` → `0`/`1`, `Uint8Array` / `ArrayBuffer`.
- Rejected (`misuse`): `DataView`, typed-array views other than `Uint8Array`, `SharedArrayBuffer` / SAB-backed buffers.
- Rejected (`datatype_mismatch`): `undefined`, `Date`, plain objects, `NaN` / `Infinity`.

```ts
db.query(`SELECT ? AS a, :name AS b`, [1, "Alice"]);
db.prepare(`SELECT @id AS id`).get(42);
```

### Returned JavaScript types

| SQL storage | JS value | Notes |
| --- | --- | --- |
| NULL | `null` | Never `undefined` |
| INTEGER | `number` or `bigint` | `bigint` when outside `Number.MAX_SAFE_INTEGER` |
| REAL | `number` | Including integer-valued reals (`1.0` → `1`); use SQL `typeof()` to distinguish from INTEGER |
| TEXT | `string` | JSON subtype unwrapped to string |
| BLOB | `Uint8Array` | |

Duplicate column names collapse in row objects (last write wins). Use `stmt.result().values` for positional cells.

### Snapshots

- `db.snapshot()` returns a frozen in-memory {@link Snapshot}. Per-test isolation should `seed.open()` (copy-on-write, ~µs). Encoded bytes are **lazy** via `snapshot.encode()`.
- Format magic `SQLM` followed by an explicit little-endian format-version `u32` — **not** a portable `.sqlite` file and not loadable by the SQLite CLI.
- Round-trips ordinary tables, views, indexes (SQLM v4 compact index keys; v3 persisted full `IndexStore`; v1/v2 blobs rebuild indexes on hydrate), change counters, PRNG state, and clock.
- **Not** encoded: triggers, ATTACH’d schemas, virtual tables (FTS / RTREE / …), `userVersion`.
- Cannot `snapshot()` while a transaction is open.
- `Snapshot.decode(bytes)` does not mutate the input `Uint8Array`. The same buffer object is decoded once (WeakMap) and later opens are CoW.
- `open()` shares frozen tables until either side writes; idle `open().snapshot().encode()` is byte-identical to `snapshot().encode()`.
- `open()` uses a fixed clock from the snapshot unless you pass `{ now: "system" }`, which stays live.
- Equivalent databases produce byte-identical `encode()` output (schema/rows sorted) **within a single library version**.
- Per-test isolation (CI-tier, 200 users + 800 items): `Snapshot.open` ~µs; `encode()` / `decode().open()` is the persistence path. See [benchmarks/PERFORMANCE.md](benchmarks/PERFORMANCE.md).
- **Compatibility policy:** newer library versions can always decode older snapshots; older libraries cannot decode newer format versions (`snapshot_version` / `SQLITE_FORMAT`). Corrupt magic yields a distinct error.

## Determinism

The engine is deterministic by default. Invariants:

| Source | Default | Override / notes |
| --- | --- | --- |
| `random()` / `randomblob()` | Seeded xorshift64* (`seed: 1`) | `new Database({ seed })` or `{ random: "os" }` for CSPRNG (not rolled back / not restored) |
| `date('now')` / friends | Fixed `2000-01-01T00:00:00.000Z` | `new Database({ now: Date \| (() => Date) \| "system" })` — `"system"` is wall clock and is **not** frozen by `open()` |
| Table scans | Rowid order | Same order after `snapshot`/`open` |
| Snapshots | Sorted schema/rows + PRNG state + clock | Applied by `open()` into PRNG and `now` |
| Transactions | PRNG rolls back with `ROLLBACK`/`SAVEPOINT` | Matches data rollback |
| Numbers | IEEE `-0` canonicalized to `+0` | Bind, affinity, and arithmetic |

Fuzz / property tests use a fixed seed (`0x5a17e0e1`) and print it on failure:

```bash
bun test tests/fuzz
bun run test:pbt:random -- 50   # N random seeds, fail fast on first mismatch
SQLITE_MEM_FUZZ_SEED=12345 bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz  # exact replay
```

## Stability policy

The exports of the main entry (`@crvouga/sqlite-mem`) are **frozen**:

- **Never** outside a major: removals, renames, signature changes, or changes to documented behavior of the stable surface.
- **Allowed in minors:** additions (new methods, new optional `DatabaseOptions` fields, new `ErrorCategory` values). Consumers that `switch` on `category` must include a default case — new categories may appear without a major bump.
- **`@crvouga/sqlite-mem/unstable`** is exempt from semver and may change or disappear in any release.
- **Snapshots:** newer library → can restore older blobs; older library → cannot restore newer format versions; byte-identical snapshot guarantee holds only within one library version.

## Compatibility notes for integrators

Goal: **SQL dialect** behavioral parity vs SQLite **3.51.0** / **3.53.0** for the `@crvouga/sqlite-mem` sync API. Full matrix: [COMPATIBILITY.md](COMPATIBILITY.md). Contract: [docs/DROP-IN-CONTRACT.md](docs/DROP-IN-CONTRACT.md).

This is **not** a drop-in replacement for `sql.js`, `@sqlite.org/sqlite-wasm`, or better-sqlite3’s full Node API. There is no `.sqlite` file codec, no `create_function` / custom collations, no `stmt.step()` / `iterate()`, and `ATTACH 'file'` opens an empty in-memory schema.

**Intentional differences:** custom `SQLM` snapshots; seeded `random()` / fixed `'now'` by default (`{ random: "os" }` / `{ now: "system" }` match SQLite entropy and wall clock); no C API / on-disk DB / VFS. Machine-readable list: [DIVERGENCES.md](DIVERGENCES.md).

**Know these thin or partial areas** (do not assume full oracle fidelity):

- FTS3/4/5 — largely implemented; shadow-table change counters intentionally diverge; some edges partial
- `EXPLAIN` / `EXPLAIN QUERY PLAN` — stub shapes, not real bytecode
- `INDEXED BY` / `NOT INDEXED` — parsed and discarded (missing indexes do not error)
- `ATTACH 'file'` — filename is recorded; schema is always a new empty in-memory database
- `MATERIALIZED` / `NOT MATERIALIZED` — both execute as materialized
- `PRAGMA compile_options` / `function_list` — sqlite-mem’s set, not Bun’s native build
- Unknown statement `PRAGMA` succeeds with an empty result (SQLite-like). All oracle-exposed `pragma_*` eponymous TVFs are supported (`SELECT * FROM pragma_table_info('t')`, bare `FROM pragma_database_list`, …), including **correlated** args such as `FROM table_list AS tl, pragma_table_info(tl.name) AS p` (Kysely SQLite introspector). Storage/journal getters return bun `:memory:`-compatible defaults. `PRAGMA case_sensitive_like` is implemented.

**Also supported (oracle-parity):** boolean literals **`TRUE` / `FALSE`** (any case → integers `1` / `0`) and **`IS [NOT] TRUE` / `IS [NOT] FALSE`** (SQLite truthiness, including NULL). A column named `true`/`false` shadows the literal.

## Common pitfalls

1. **Do not `await`** — the API is sync.
2. **No named-object binds and no sticky `bind()`** — pass positional rest args / arrays in declaration order to `query` / `run` / `all` / `get` / `result`.
3. **`query` / `prepare` are single-statement only** — multi-statement scripts belong in `exec()` (which does not take bind parameters).
4. **`exec` returns `void` and takes no params** — use `db.prepare(…).run(…)` or `db.query(…)` for binds; use `db.changes` / `stmt.run()` for counters.
5. **`'now'` is not wall-clock** unless you pass `{ now: "system" }` or `{ now: () => new Date() }`. Default is year 2000. `open()` freezes a snapshot clock except when constructed with `"system"`.
6. **`random()` is seeded**, not OS entropy, unless you pass `{ random: "os" }`. Snapshots restore the seeded PRNG; OS entropy is not rewound.
7. **Snapshots are not `.sqlite` files** and do not round-trip FTS / triggers / ATTACH.
8. **No better-sqlite3 extras** — no `iterate`, `pluck`/`raw`, `safeIntegers` option, `pragma()` helper, `loadExtension`, or SQLite-file `serialize()`.
9. **Do not bind `Date` objects** — store unixepoch integers or ISO text. Do not bind `DataView` / non-`Uint8Array` typed arrays.
10. **Do not use `Number.isInteger` for SQL REAL vs INTEGER** — use SQL `typeof()`.
11. **Do not import `@crvouga/sqlite-mem/unstable` in application code** unless you accept breakage in any release.

Working examples beyond this README: `examples/react-vite`, `tests/contract/api/`, and `tests/contract/parameters/`.

## Development

Requires [Bun](https://bun.sh). For architecture, change checklists, and how to add contract tests, see **[AGENTS.md](AGENTS.md)**.

Parity is proven only by differential contracts against real SQLite (`bun:sqlite`). Isolated internal unit tests are not SQLite compatibility proof.

```bash
bun install
bun run check:full             # same gates as GitHub Actions CI (except publish)
bun run check                # format + lint + typecheck + sqlite-compat suite
bun run format               # write Biome formatting
bun run lint                 # Biome lint
bun run typecheck
bun run test:sqlite-compat   # requirements + inventory gate + differential suite
bun test                     # contract + fuzz + harness
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
| `fix: …` / `perf: …` | patch (`1.9.0` → `1.9.1`) |
| `feat: …` | minor (`1.9.0` → `1.10.0`) |
| `feat!: …` or `BREAKING CHANGE:` footer | major (`1.10.0` → `2.0.0`) |
| any other message on `main` (including Cursor-style subjects) | patch |

Examples:

```text
feat: add window function support
fix: handle NULL in UNIQUE constraints
feat!: rename snapshot() return type

Refactor AdoptedDatabase interface   # still publishes a patch
```

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

1. **Create the package on npm (once), then Trusted Publishing.** If https://www.npmjs.com/package/@crvouga/sqlite-mem 404s:

   ```bash
   npm login --auth-type=web
   bun run npm:seed -- --yes
   ```

   npm does not email a publish code — complete 2FA in the browser or authenticator app.

   Then on [package Access](https://www.npmjs.com/package/@crvouga/sqlite-mem/access) → Trusted Publisher → GitHub Actions (`crvouga/sqlite-mem`, workflow `ci.yml`). Do **not** create an Automation / granular access token for CI.
2. Confirm GitHub Actions is enabled and can create releases (default `GITHUB_TOKEN` is enough with this workflow’s permissions). No `NPM_TOKEN` repo secret.
3. Ensure the baseline tag exists and is pushed: `v0.1.0` (semver continues from there; the next `feat` publishes `0.2.0`).

Validate the checklist anytime with `bun run secrets:doctor`.

After that, every green push to `main` updates npm automatically (`feat`/`fix`/`BREAKING` pick the bump; anything else is a patch).

## License

MIT
