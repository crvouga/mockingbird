# @crvouga/mockingbird-service-sqlite

Pure TypeScript, completely in-memory SQLite engine aiming for **full SQLite3 SQL dialect parity**
(same statements, same results). Use it in tests (or the browser) wherever you want real SQLite SQL
semantics without native bindings: schema + migrations, constraints, transactions, JSON functions,
FTS, and copy-on-write snapshots for per-test isolation. It is also the default storage engine
behind every Mockingbird HTTP mock (Stripe, Junction, GeneByGene, ...).

> Formerly [`@crvouga/sqlite-mem`](https://www.npmjs.com/package/@crvouga/sqlite-mem)
> ([archived repo](https://github.com/crvouga/sqlite-mem)). Migrate by replacing the package name;
> the API is unchanged.

- Runs in modern browsers, Node.js and Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies; the whole database lives in memory
- **Synchronous**, ESM-only API (no Promises, no `require`)
- **SQL dialect verified** against SQLite 3.51.0 / 3.53.0 (`bun:sqlite`) via differential contracts
  and a fail-closed gate
- **Not** a drop-in for `sql.js` / `sqlite-wasm` APIs, on-disk `.sqlite` files, or user-defined functions
- Intentional differences: deterministic `random()` / `'now'` by default, and a custom snapshot
  format (not `.sqlite` files)

### Documentation

Files marked (shipped) are included in the npm package next to this README.

| Doc | For |
| --- | --- |
| [COMPATIBILITY.md](./COMPATIBILITY.md) (shipped) | Feature matrix + verify commands |
| [COMPATIBILITY-AUDIT.md](./COMPATIBILITY-AUDIT.md) (shipped) | Audit evidence |
| [AGENTS.md](./AGENTS.md) (shipped) | Contributor docs: architecture, how to change code, test/compat gates |
| [DROP-IN-CONTRACT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/docs/DROP-IN-CONTRACT.md) | Falsifiable drop-in claim (what "same" means) |
| [PROOF.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/docs/PROOF.md) | Evidence argument + what is not proven |
| [GAP-ANALYSIS.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/docs/GAP-ANALYSIS.md) | Phase 0 gap analysis vs the full drop-in catalog |
| [GAP-CATALOG.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/docs/GAP-CATALOG.md) | Current unproven / thin / intentional inventory |
| [DIVERGENCES.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/DIVERGENCES.md) | Auto-generated intentional divergences (machine-readable: `compat/divergences.json`, shipped) |
| [PERFORMANCE.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/benchmarks/PERFORMANCE.md) | Performance notes |

## Install

```bash
npm install -D @crvouga/mockingbird-service-sqlite
# or: bun add -d @crvouga/mockingbird-service-sqlite
```

Requires Node.js >= 20 or Bun >= 1.1 (`engines`); the rest of Mockingbird targets Node >= 22 /
Bun >= 1.2. The package is **ESM only** and has no runtime dependencies. Install it as a regular
dependency instead of `-D` if you ship it to the browser. The Mockingbird HTTP mocks already depend
on it; install it directly only to use the engine yourself or to pass a shared `Database` to them.

## Usage

```ts
import { Database, Snapshot } from "@crvouga/mockingbird-service-sqlite"

const db = new Database()

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)

const inserted = db.prepare(`INSERT INTO users (name) VALUES (?)`).run("Alice")
console.log(inserted) // { changes: 1, lastInsertRowid: 1 }

const users = db.query<{ id: number; name: string; created_at: string }>(`SELECT * FROM users`)
console.log(users) // [{ id: 1, name: "Alice", created_at: "2000-01-01 00:00:00" }]

// Snapshots: freeze a template, fork it cheaply, or persist it as bytes.
const seed = db.snapshot()
const db2 = seed.open()
const bytes = seed.encode()
const db3 = Snapshot.decode(bytes).open()
console.log(db2.query(`SELECT count(*) AS n FROM users`), db3.lastInsertRowid) // [{ n: 1 }] 1
```

All methods are **synchronous**; do not `await` them. Browser and Node/Bun share the same
in-memory surface (no filesystem; `ATTACH` opens a new empty in-memory schema, not a file).

### Per-test isolation with snapshots

Run migrations and fixtures once, `snapshot()` the result, and `open()` a copy-on-write fork per
test (microseconds, tables are shared until either side writes):

```ts
import { beforeEach, expect, test } from "bun:test"
import { Database, SqliteError } from "@crvouga/mockingbird-service-sqlite"

const template = new Database()
template.exec(`
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
  INSERT INTO accounts (email) VALUES ('seed@example.com');
`)
const seed = template.snapshot()

let db: Database
beforeEach(() => {
  db = seed.open()
})

test("unique violation surfaces SQLITE_CONSTRAINT_UNIQUE", () => {
  let error: unknown
  try {
    db.prepare(`INSERT INTO accounts (email) VALUES (?)`).run("seed@example.com")
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(SqliteError)
  expect((error as SqliteError).code).toBe("SQLITE_CONSTRAINT_UNIQUE")
})

test("each test starts from the seed", () => {
  expect(db.query(`SELECT email FROM accounts`)).toEqual([{ email: "seed@example.com" }])
})
```

### As Mockingbird's storage

Every Mockingbird HTTP mock accepts a `sqlite` option typed as the `SqliteClient` port bundled
with each mock package (`exec`, `prepare(sql).run/all/get`, `transaction`). This package's
`Database` satisfies it and is what a mock creates when you omit the option. Pass your own to share
one database between several mocks (each keeps its records under its own namespace, e.g.
`"stripe"`, `"junction"`), to inspect what a mock stored, or to snapshot a warmed-up mock:

```js
import { Database } from "@crvouga/mockingbird-service-sqlite"
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const sqlite = new Database({ now: "system" })
const stripe = new StripeAPI({ sqlite })
const junction = new JunctionAPI({ sqlite })

// ... drive the mocks to a fixture state, then fork it per test:
const warmed = sqlite.snapshot()
const freshStripe = () => new StripeAPI({ sqlite: warmed.open() })
```

The mocks create their own tables (`mockingbird_records`, `mockingbird_sequences`,
`schema_migrations`) on construction, and each mock's `reset()` clears only its own namespace, so
resetting one mock leaves the others' data in a shared database intact. Any other client with the same sync surface (better-sqlite3, a
wrapped `bun:sqlite`) also satisfies the port.

### Method semantics

| Method | Behaviour |
| --- | --- |
| `exec(sql)` | Runs all semicolon-separated statements; **discards** row results (`void`). Does **not** accept bind parameters. Read `db.changes` / `db.lastInsertRowid` afterwards if needed (counters reflect the **most recent** completed statement, matching SQLite). |
| `query(sql, params?, { at? }?)` | **Single statement only** (trailing `;` is fine). Returns all rows. `at` queries an immutable checkpoint without changing live state. Multi-statement scripts throw `misuse`. |
| `prepare(sql)` | **Single statement only**. Parses immediately; the AST is reused. Pass binds as rest args to `run` / `all` / `get` / `result` on each call. |
| `transaction(fn)` | If idle: `BEGIN`, `fn()`, `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. A nested SQL `BEGIN` still errors. `close()` inside `fn` throws `misuse`. |
| `snapshot()` | Freeze a reusable `Snapshot` template (no encode). Illegal inside a transaction. |
| `checkpoint()` / `branch(at?)` | Name a COW snapshot as a checkpoint; open an isolated branch from it (or current state). |
| `Snapshot.open()` | Copy-on-write fork from a template. The parent stays open. |
| `Snapshot.encode()` | Lazy SQLM blob for persistence / worker boot (computed once, cached). |
| `Snapshot.decode(bytes)` | Decode a blob once per `Uint8Array` (WeakMap); later `open()` calls are copy-on-write. |
| `close()` | Idempotent; rolls back an open SQL transaction; further operations throw `misuse`. Also available as `[Symbol.dispose]` when the runtime defines `Symbol.dispose`. |

SQL `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` are first-class. Empty or
comment-only SQL on `prepare` / `query` throws `misuse` (`empty statement`), matching SQLite
prepare failure.

### Parameter binding

Supported styles: `?`, `?NNN`, `:name`, `@name`, `$name`.

- The JS API takes **rest args** (or a positional array into `query`) only; there is **no** sticky
  `bind()` and **no** `bind({ name: value })`.
- Named parameters occupy slots in **first-occurrence order**; repeated names share one slot.
- Prefixes are part of the name: `@x`, `$x`, and `:x` are **three different** parameters.
- Names are lowercased for lookup (`:Left` is `:left`).
- Bindable: `null`, `string`, finite `number`, `bigint`, `boolean` (stored as `0`/`1`),
  `Uint8Array` / `ArrayBuffer`.
- Rejected (`misuse`): `DataView`, typed-array views other than `Uint8Array`, `SharedArrayBuffer` /
  SAB-backed buffers.
- Rejected (`datatype_mismatch`): `undefined`, `Date`, plain objects, `NaN` / `Infinity`.

```ts
import { Database } from "@crvouga/mockingbird-service-sqlite"

const db = new Database()
console.log(db.query(`SELECT ? AS a, :name AS b`, [1, "Alice"])) // [{ a: 1, b: "Alice" }]
console.log(db.prepare(`SELECT @id AS id`).get(42)) // { id: 42 }
```

### Returned JavaScript types

| SQL storage | JS value | Notes |
| --- | --- | --- |
| NULL | `null` | Never `undefined` |
| INTEGER | `number` or `bigint` | `bigint` when outside `Number.MAX_SAFE_INTEGER` |
| REAL | `number` | Including integer-valued reals (`1.0` becomes `1`); use SQL `typeof()` to distinguish from INTEGER |
| TEXT | `string` | JSON subtype unwrapped to string |
| BLOB | `Uint8Array` | |

Duplicate column names collapse in row objects (last write wins). Use `stmt.result().values` for
positional cells.

### Snapshots

- `db.snapshot()` returns a frozen in-memory `Snapshot`. Per-test isolation should `seed.open()`
  (copy-on-write, microseconds). Encoded bytes are **lazy** via `snapshot.encode()`.
- Format: magic `SQLM` followed by an explicit little-endian format-version `u32`. **Not** a
  portable `.sqlite` file and not loadable by the SQLite CLI.
- Round-trips ordinary tables, views, indexes (SQLM v4 compact index keys; v3 persisted full
  `IndexStore`; v1/v2 blobs rebuild indexes on hydrate), change counters, PRNG state, and clock.
- **Not** encoded: triggers, ATTACH'd schemas, virtual tables (FTS / RTREE / ...), `userVersion`.
- Cannot `snapshot()` while a transaction is open.
- `Snapshot.decode(bytes)` does not mutate the input `Uint8Array`. The same buffer object is
  decoded once (WeakMap) and later opens are copy-on-write.
- `open()` shares frozen tables until either side writes; idle `open().snapshot().encode()` is
  byte-identical to `snapshot().encode()`.
- `open()` uses a fixed clock from the snapshot unless you pass `{ now: "system" }`, which stays live.
- Equivalent databases produce byte-identical `encode()` output (schema/rows sorted) **within a
  single library version**.
- **Compatibility policy:** newer library versions can always decode older snapshots; older
  libraries cannot decode newer format versions (`snapshot_version` / `SQLITE_FORMAT`). Corrupt
  magic yields a distinct error.

### Determinism

The engine is deterministic by default:

| Source | Default | Override / notes |
| --- | --- | --- |
| `random()` / `randomblob()` | Seeded xorshift64* (`seed: 1`) | `new Database({ seed })`, or `{ random: "os" }` for CSPRNG (not rolled back / not restored) |
| `date('now')` / friends | Fixed `2000-01-01T00:00:00.000Z` | `new Database({ now: Date \| (() => Date) \| "system" })`; `"system"` is wall clock and is **not** frozen by `open()` |
| Table scans | Rowid order | Same order after `snapshot`/`open` |
| Snapshots | Sorted schema/rows + PRNG state + clock | Applied by `open()` into PRNG and `now` |
| Transactions | PRNG rolls back with `ROLLBACK`/`SAVEPOINT` | Matches data rollback |
| Numbers | IEEE `-0` canonicalized to `+0` | Bind, affinity, and arithmetic |

### Compatibility notes for integrators

Goal: **SQL dialect** behavioural parity vs SQLite **3.51.0** / **3.53.0** for the sync API. Full
matrix: [COMPATIBILITY.md](./COMPATIBILITY.md). Contract:
[DROP-IN-CONTRACT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/docs/DROP-IN-CONTRACT.md).

This is **not** a drop-in replacement for `sql.js`, `@sqlite.org/sqlite-wasm`, or better-sqlite3's
full Node API. There is no `.sqlite` file codec, no `create_function` / custom collations, no
`stmt.step()` / `iterate()`, and `ATTACH 'file'` opens an empty in-memory schema. Intentional
differences: custom `SQLM` snapshots; seeded `random()` / fixed `'now'` by default
(`{ random: "os" }` / `{ now: "system" }` match SQLite entropy and wall clock); no C API / on-disk
DB / VFS.

**Thin or partial areas** (do not assume full oracle fidelity):

- FTS3/4/5: largely implemented; shadow-table change counters intentionally diverge; some edges partial
- `EXPLAIN` / `EXPLAIN QUERY PLAN`: stub shapes, not real bytecode
- `INDEXED BY` / `NOT INDEXED`: parsed and discarded (missing indexes do not error)
- `ATTACH 'file'`: the filename is recorded; the schema is always a new empty in-memory database
- `MATERIALIZED` / `NOT MATERIALIZED`: both execute as materialized
- `PRAGMA compile_options` / `function_list`: this engine's set, not Bun's native build
- Unknown statement `PRAGMA` succeeds with an empty result (SQLite-like). All oracle-exposed
  `pragma_*` eponymous table-valued functions are supported (`SELECT * FROM pragma_table_info('t')`,
  bare `FROM pragma_database_list`, ...), including **correlated** args such as
  `FROM table_list AS tl, pragma_table_info(tl.name) AS p` (Kysely SQLite introspector).
  Storage/journal getters return bun `:memory:`-compatible defaults. `PRAGMA case_sensitive_like`
  is implemented.

**Also supported (oracle parity):** boolean literals **`TRUE` / `FALSE`** (any case, as integers
`1` / `0`) and **`IS [NOT] TRUE` / `IS [NOT] FALSE`** (SQLite truthiness, including NULL). A column
named `true`/`false` shadows the literal.

### Common pitfalls

1. **Do not `await`**: the API is sync.
2. **No named-object binds and no sticky `bind()`**: pass positional rest args / arrays in declaration order to `query` / `run` / `all` / `get` / `result`.
3. **`query` / `prepare` are single-statement only**: multi-statement scripts belong in `exec()` (which does not take bind parameters).
4. **`exec` returns `void` and takes no params**: use `db.prepare(...).run(...)` or `db.query(...)` for binds; use `db.changes` / `stmt.run()` for counters.
5. **`'now'` is not wall-clock** unless you pass `{ now: "system" }` or `{ now: () => new Date() }`. The default is year 2000. `open()` freezes a snapshot clock except when constructed with `"system"`.
6. **`random()` is seeded**, not OS entropy, unless you pass `{ random: "os" }`. Snapshots restore the seeded PRNG; OS entropy is not rewound.
7. **Snapshots are not `.sqlite` files** and do not round-trip FTS / triggers / ATTACH.
8. **No better-sqlite3 extras**: no `iterate`, `pluck`/`raw`, `safeIntegers` option, `pragma()` helper, `loadExtension`, or SQLite-file `serialize()`.
9. **Do not bind `Date` objects**: store unixepoch integers or ISO text. Do not bind `DataView` / non-`Uint8Array` typed arrays.
10. **Do not use `Number.isInteger` for SQL REAL vs INTEGER**: use SQL `typeof()`.
11. **Do not import `@crvouga/mockingbird-service-sqlite/unstable` in application code** unless you accept breakage in any release.
12. **Known issue:** a column-level `UNIQUE` followed by another column constraint (for example
    `email TEXT UNIQUE NOT NULL`, `UNIQUE DEFAULT ...`, `UNIQUE CHECK (...)`) is currently not
    enforced. Put `UNIQUE` last (`email TEXT NOT NULL UNIQUE`), use a table constraint
    (`UNIQUE (email)`), or `CREATE UNIQUE INDEX`; all of those are enforced.

## API

Stable runtime exports of the main entry:

| Export | Description |
| --- | --- |
| `Database` | Class. `new Database(options?: DatabaseOptions)` — one in-memory SQLite database. Satisfies Mockingbird's `SqliteClient` port. |
| `Snapshot` | Class. Frozen template from `db.snapshot()` or `Snapshot.decode(bytes)`; `open(options?)` forks a `Database`, `encode()` serializes. |
| `Statement` | Class returned by `db.prepare(sql)` (not constructed directly): `run`, `all`, `get`, `result`. |
| `SqliteError` | Error class thrown for SQL and API errors: `category` (`ErrorCategory`), `sqliteCode` / `code` (SQLite result-code name, e.g. `"SQLITE_CONSTRAINT_UNIQUE"`; default `"SQLITE_ERROR"`). |

Signatures (types are exported too: `DatabaseOptions`, `RunResult`, `ResultSet`, `ErrorCategory`,
`BindValue`, `QueryRow`, `QueryValue`):

```text
interface DatabaseOptions {
  seed?: number | bigint                 // default 1; ignored when random is "os"
  random?: "deterministic" | "os"        // default "deterministic"; "os" is CSPRNG like SQLite
  now?: Date | (() => Date) | "system"   // default 2000-01-01T00:00:00.000Z; "system" is wall clock
}

class Database {
  constructor(options?: DatabaseOptions)
  exec(sql: string): void
  query<T = QueryRow>(sql: string, params?: readonly BindValue[], options?: { at?: Snapshot }): T[]
  prepare(sql: string): Statement
  transaction<T>(fn: () => T): T
  snapshot(): Snapshot
  checkpoint(): Snapshot
  branch(at?: Snapshot): Database
  close(): void                             // also [Symbol.dispose] when available
  readonly changes: number
  readonly lastInsertRowid: number | bigint
  readonly totalChanges: number
  readonly seed: number | bigint
  readonly randomMode: "deterministic" | "os"
}

class Statement {
  run(...params: BindValue[]): RunResult
  all<T = QueryRow>(...params: BindValue[]): T[]
  get<T = QueryRow>(...params: BindValue[]): T | undefined
  result(...params: BindValue[]): ResultSet   // includes columns + values when zero rows
}

interface RunResult { changes: number; lastInsertRowid: number | bigint }
interface ResultSet {
  columns: string[]
  rows: QueryRow[]
  values: QueryValue[][]                     // always present (empty array for zero rows)
  changes: number
  lastInsertRowid: number | bigint
}

class Snapshot {
  open(options?: DatabaseOptions): Database
  encode(): Uint8Array
  static decode(bytes: Uint8Array): Snapshot
}

class SqliteError extends Error {
  readonly category: ErrorCategory   // "syntax", "no_such_table", "constraint_unique", "misuse", ...
  readonly sqliteCode: string        // always set; default "SQLITE_ERROR"
  readonly code: string              // === sqliteCode (Node err.code convention)
}
```

Stick to `Database`, `Snapshot`, `Statement`, and `SqliteError` in application code. Advanced
internals (`parse`, `tokenize`, `evalExpr`, snapshot codec pieces, `SqlValue` utilities, `Prng`,
...) are available only from `@crvouga/mockingbird-service-sqlite/unstable` and are **exempt from
semver**.

### Stability policy

The exports of the main entry (`@crvouga/mockingbird-service-sqlite`) are **frozen**:

- **Never** outside a major: removals, renames, signature changes, or changes to documented
  behaviour of the stable surface.
- **Allowed in minors:** additions (new methods, new optional `DatabaseOptions` fields, new
  `ErrorCategory` values). Consumers that `switch` on `category` must include a default case.
- **`@crvouga/mockingbird-service-sqlite/unstable`** is exempt from semver and may change or
  disappear in any release.
- **Snapshots:** newer library versions restore older blobs; older library versions cannot restore
  newer format versions; the byte-identical guarantee holds only within one library version.

## Development

For contributors to the mockingbird repo only. Requires [Bun](https://bun.sh). For
architecture, change checklists, and how to add contract tests, see [AGENTS.md](./AGENTS.md).

Parity is proven only by differential contracts against real SQLite (`bun:sqlite`). Isolated
internal unit tests are not SQLite compatibility proof.

```bash
bun install
bun run check:full           # same gates as GitHub Actions CI (except publish)
bun run check                # format + lint + typecheck + sqlite-compat suite
bun run format               # write Biome formatting
bun run lint                 # Biome lint
bun run typecheck
bun run test:sqlite-compat   # requirements + inventory gate + differential suite
bun test                     # contract + fuzz + harness
bun run build
```

Fuzz / property tests use a fixed seed (`0x5a17e0e1`) and print it on failure:

```bash
bun test tests/fuzz
bun run test:pbt:random -- 50   # N random seeds, fail fast on first mismatch
SQLITE_MEM_FUZZ_SEED=12345 bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz  # exact replay
```

A React + Vite SQL playground lives in
[`examples/react-vite`](https://github.com/crvouga/mockingbird/tree/main/packages/service/sqlite/examples/react-vite)
(`bun run example` from this package after `bun install` there). More working examples:
[`tests/contract/api/`](https://github.com/crvouga/mockingbird/tree/main/packages/service/sqlite/tests/contract/api)
and [`tests/contract/parameters/`](https://github.com/crvouga/mockingbird/tree/main/packages/service/sqlite/tests/contract/parameters).

Released automatically from the [Mockingbird monorepo](https://github.com/crvouga/mockingbird)
(see [Releasing](https://github.com/crvouga/mockingbird/blob/main/docs/RELEASING.md)). License: MIT ([LICENSE](./LICENSE)).

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt) · [report an issue or request a feature](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md).
