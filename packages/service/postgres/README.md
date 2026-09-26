# @crvouga/mockingbird-service-postgres

Pure TypeScript, completely in-memory PostgreSQL engine aiming for **PostgreSQL 18 SQL dialect
parity** (same statements, same results). Use it in tests (or the browser) wherever you want real
PostgreSQL SQL semantics without a server: schema + migrations, constraints and SQLSTATE errors,
transactions, CTEs, window functions, JSONB, sequences, and copy-on-write snapshots for per-test
isolation.

> Formerly [`@crvouga/postgres-mem`](https://www.npmjs.com/package/@crvouga/postgres-mem)
> ([archived repo](https://github.com/crvouga/postgres-mem)). Migrate by replacing the package
> name; the API is unchanged.

- Runs in modern browsers, Node.js and Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies; the whole database lives in memory
- **Synchronous**, ESM-only API (no Promises, no `require`)
- **SQL dialect verified** against real PostgreSQL 18.3 (PGlite by default; optional native server)
  via differential contracts and a fail-closed gate
- In-process it is **not** a drop-in for the `pg` / `postgres.js` client APIs or on-disk clusters, but it also ships an **optional wire-protocol server** (`@crvouga/mockingbird-service-postgres/server`, Node/Bun) that unmodified clients connect to over TCP
- Intentional differences: deterministic `random()` / `now()` by default, and a custom snapshot
  format (not `pg_dump`)

It is not a Mockingbird HTTP mock and is not the storage engine Mockingbird's HTTP mocks use (they
use the SQLite-dialect [`@crvouga/mockingbird-service-sqlite`](https://github.com/crvouga/mockingbird/tree/main/packages/service/sqlite#readme)
through the `SqliteClient` port). Use this package as the database for your own code under test.

### Documentation

Files marked (shipped) are included in the npm package next to this README.

| Doc | For |
| --- | --- |
| [COMPATIBILITY.md](./COMPATIBILITY.md) (shipped) | Feature matrix + verify commands |
| [COMPATIBILITY-AUDIT.md](./COMPATIBILITY-AUDIT.md) (shipped) | Audit evidence |
| [AGENTS.md](./AGENTS.md) (shipped) | Contributor docs: architecture, how to change code, test/compat gates |
| [DROP-IN-CONTRACT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/docs/DROP-IN-CONTRACT.md) | Falsifiable drop-in claim (what "same" means) |
| [PROOF.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/docs/PROOF.md) | Evidence argument + what is not proven |
| [GAP-ANALYSIS.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/docs/GAP-ANALYSIS.md) | Gap analysis vs the full PostgreSQL surface |
| [GAP-CATALOG.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/docs/GAP-CATALOG.md) | Current unproven / thin / intentional inventory |
| [DIVERGENCES.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/DIVERGENCES.md) | Auto-generated intentional divergences (machine-readable: `compat/divergences.json`, shipped) |
| [PERFORMANCE.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/benchmarks/PERFORMANCE.md) | Performance notes |

## Install

```bash
npm install -D @crvouga/mockingbird-service-postgres
# or: bun add -d @crvouga/mockingbird-service-postgres
```

Requires Node.js >= 20 or Bun >= 1.1 (`engines`); the rest of Mockingbird targets Node >= 22 /
Bun >= 1.2. The package is **ESM only** and has no runtime dependencies. Install it as a regular
dependency instead of `-D` if you ship it to the browser.

## Usage

```ts
import { Database, Snapshot } from "@crvouga/mockingbird-service-postgres"

const db = new Database()

db.exec(`
  CREATE TABLE users (
    id serial PRIMARY KEY,
    email text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`)

db.prepare(`INSERT INTO users (email) VALUES ($1)`).run("ada@example.com")

const users = db.query<{ id: number; email: string; created_at: string }>(`SELECT * FROM users`)
console.log(users) // [{ id: 1, email: "ada@example.com", created_at: "2000-01-01 00:00:00+00" }]

// Snapshots: freeze a template, fork it cheaply, or persist it as bytes.
const seed = db.snapshot()
const db2 = seed.open()
const bytes = seed.encode()
const db3 = Snapshot.decode(bytes).open()
console.log(db2.query(`SELECT count(*) AS n FROM users`), db3.changes) // [{ n: 1n }] 1
```

All methods are **synchronous**; do not `await` them. Browser and Node/Bun share the same
in-memory surface (no filesystem). For a real TCP listener separate processes can connect to, see
the [wire-protocol server](#wire-protocol-server-separate-processes) (Node/Bun only).

### Per-test isolation with snapshots

Run migrations and fixtures once, `snapshot()` the result, and `open()` a copy-on-write fork per
test (microseconds, tables are shared until either side writes):

```ts
import { beforeEach, expect, test } from "bun:test"
import { Database, PostgresError } from "@crvouga/mockingbird-service-postgres"

const template = new Database()
template.exec(`
  CREATE TABLE accounts (id serial PRIMARY KEY, email text UNIQUE NOT NULL);
  INSERT INTO accounts (email) VALUES ('seed@example.com');
`)
const seed = template.snapshot()

let db: Database
beforeEach(() => {
  db = seed.open()
})

test("unique violation surfaces SQLSTATE 23505", () => {
  let error: unknown
  try {
    db.prepare(`INSERT INTO accounts (email) VALUES ($1)`).run("seed@example.com")
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(PostgresError)
  expect((error as PostgresError).code).toBe("23505")
  expect((error as PostgresError).category).toBe("constraint_unique")
})

test("each test starts from the seed", () => {
  expect(db.query(`SELECT email FROM accounts`)).toEqual([{ email: "seed@example.com" }])
})
```

### Adapting it to code written against `pg`

There is no async client, so put a small shim behind whatever query interface your code uses. With
`{ int8: "string" }`, `int8` / `bigserial` / `count(*)` come back as strings, like node-postgres's
default:

```ts
import { type BindValue, Database } from "@crvouga/mockingbird-service-postgres"

const db = new Database({ int8: "string", now: "system" })

/** Minimal pg.Pool-shaped facade: `query(text, values)` resolving to `{ rows, rowCount, command }`. */
export const pool = {
  query: async <T = Record<string, unknown>>(text: string, values: BindValue[] = []) => {
    const result = db.prepare(text).result(...values)
    return { rows: result.rows as T[], rowCount: result.rowCount, command: result.command }
  },
}

await pool.query(`CREATE TABLE notes (id bigserial PRIMARY KEY, body text)`)
const inserted = await pool.query<{ id: string }>(
  `INSERT INTO notes (body) VALUES ($1) RETURNING id`,
  ["hello"],
)
console.log(inserted.rows[0]?.id, inserted.rowCount) // "1" 1
```

Differences from node-postgres to account for: timestamps, dates, `numeric` and `json`/`jsonb` come
back as PostgreSQL text (node-postgres parses timestamps to `Date` and JSON to objects);
`prepare`/`query` accept one statement at a time (use `exec` for scripts); errors are
`PostgresError` with `code` set to the SQLSTATE, like `pg`'s `DatabaseError.code`.

### Wire-protocol server (separate processes)

When another process must connect over TCP — `pg`, `postgres.js`, a JDBC client, `psql`, a service
in a local multi-service stack — start the frontend/backend v3 server instead of a shim. It needs
`node:net`, so it is a separate Node/Bun entry (`/server`) and the main package stays browser-safe.

```ts
import { serve } from "@crvouga/mockingbird-service-postgres/server"

const server = await serve({ port: 0 }) // 0 → a free port, reported as server.port
// postgres://postgres@127.0.0.1:${server.port}/db  — no initdb, no OS user, pure TypeScript
await server.close()
```

Or from the command line (installs a `mockingbird-postgres` bin):

```bash
mockingbird-postgres serve --port 55432            # trust auth
mockingbird-postgres serve --password secret --log # SCRAM-SHA-256, log each statement
```

`serve({ database })` shares an existing `Database`, and `serve({ database: snapshot })` boots every
server from one frozen template, so a seeded stack starts from the same bytes each time.
`server.snapshot()` freezes the live state; `server.fault({ dropConnection | delayStatementMs |
failCommit })` arms the next statement or connection for a drop, a delay, or a `40001` commit
failure.

One engine is shared by every connection. The engine runs one statement at a time, so a connection
inside an explicit `BEGIN` block holds it until `COMMIT`/`ROLLBACK` and other connections queue
behind it — which keeps read-committed visibility (an uncommitted row is never seen by another
connection) by serializing transaction blocks rather than by MVCC. Across connections the server
adds what a single engine does not: per-session advisory locks (`pg_advisory_lock` /
`pg_try_advisory_lock` / `_xact_` / `_unlock`) with in-order waiters and deadlock detection
(`40P01`), `LISTEN`/`NOTIFY` delivered to idle listeners, `CancelRequest` (a blocked statement ends
`57014` and the session stays usable), and per-connection aborted-transaction state (a failed
statement in a block is `25P02` until `ROLLBACK`, with `ReadyForQuery` reporting `I`/`T`/`E`).
SCRAM-SHA-256 and trust auth, the extended query protocol (`Parse`/`Bind`/`Describe`/`Execute`/
`Sync`) with text and binary parameters and results, real type OIDs in `RowDescription`, and
`23505`/`23502` errors carrying the constraint, table and column the engine names, all work over
the wire.

**Not modelled by the server:** row-level lock contention, so `SELECT … FOR UPDATE SKIP LOCKED`
parses and returns rows but does not distribute disjoint rows across concurrent workers (there are
no row locks); `COPY` streaming (`CopyInResponse`/`CopyData`) — use `copyFrom` on a shared
`Database`; and the binary parameter formats beyond the common scalar types (a client that sends
another binary type gets `0A000`, and can switch that parameter to text).

### Method semantics

| Method | Behaviour |
| --- | --- |
| `exec(sql)` | Runs all semicolon-separated statements; **discards** row results (`void`). Does **not** accept bind parameters. Read `db.changes` afterwards if needed (reflects the **most recent** completed DML statement). Dump-only `DO` blocks and `ALTER TABLE ... SET (` storage parameters are no-ops. |
| `registerFunction(spec)` | Install a JavaScript scalar. Not stored in PGMM snapshots; `open()` of a live snapshot copies the implementation by reference. |
| `query(sql, params?, { at? }?)` | **Single statement only** (trailing `;` is fine). Returns all rows. `at` queries an immutable checkpoint without changing live state. Multi-statement scripts throw `misuse`. |
| `prepare(sql)` | **Single statement only**. Parses immediately; the AST is reused. Pass binds as rest args to `run` / `all` / `get` / `result` / `textResult` on each call. |
| `transaction(fn)` | If idle: `BEGIN`, `fn()`, `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. A nested SQL `BEGIN` inside is a no-op warning like PostgreSQL. `close()` inside `fn` throws `misuse`. |
| `copyFrom(sql, data)` | Executes `COPY table [(cols)] FROM STDIN` with `data` as the copy-in payload (text or csv per the COPY options). Returns rows copied. `COPY ... TO STDOUT` output is returned as result rows by `query`. |
| `snapshot()` | Freeze a reusable `Snapshot` template (no encode). Illegal inside a transaction (`25P01`). |
| `checkpoint()` / `branch(at?)` | Name a COW snapshot as a checkpoint; open an isolated branch from it (or current state). |
| `Snapshot.open()` | Copy-on-write fork from a template. The parent stays open. |
| `Snapshot.encode()` | Lazy PGMM blob for persistence / worker boot (computed once, cached). |
| `Snapshot.decode(bytes)` | Decode a blob once per `Uint8Array` (WeakMap); later `open()` calls are copy-on-write. |
| `close()` | Idempotent; rolls back an open SQL transaction; further operations throw `misuse`. Also available as `[Symbol.dispose]` when the runtime defines `Symbol.dispose`. |

SQL `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` are first-class. Empty or
comment-only SQL on `prepare` / `query` / `exec` throws `misuse` (`empty statement`).

### Parameter binding

Parameters are PostgreSQL-style **positional `$1..$n` only** (no `?`, no named parameters, matching
the PostgreSQL wire convention).

- The JS API takes **rest args** (or a positional array into `query`); there is **no** sticky `bind()`.
- Bindable: `null` / `undefined` (NULL), `string` (behaves like an untyped literal, coerced by
  context), `number` (integer-valued becomes `int4`/`int8`, otherwise `float8`), `bigint` (`int8`,
  range-checked), `boolean`, `Uint8Array` (`bytea`), `Date` (`timestamptz`).
- Rejected (`misuse` / `numeric_value_out_of_range`): plain objects, symbols, functions, bigints
  outside int8, invalid `Date`s.

```ts
import { Database } from "@crvouga/mockingbird-service-postgres"

const db = new Database()
console.log(db.query(`SELECT $1::int AS a, $2 AS b`, [1, "Alice"])) // [{ a: 1, b: "Alice" }]
console.log(db.prepare(`SELECT $1::int8 AS id`).get(42n)) // { id: 42n }
```

### Returned JavaScript types

| PostgreSQL type | JS value | Notes |
| --- | --- | --- |
| NULL | `null` | Never `undefined` |
| `bool` | `boolean` | |
| `int2` / `int4` | `number` | |
| `int8` | `bigint` | Default; `{ int8: "number" }` or `{ int8: "string" }` changes it (`"number"` is unsafe beyond `Number.MAX_SAFE_INTEGER`) |
| `float4` / `float8` | `number` | |
| `bytea` | `Uint8Array` | |
| everything else | `string` | `numeric`, `text`, `date`/`timestamp[tz]`, `interval`, `uuid`, `json[b]`, arrays, enums, ... surface as **canonical PostgreSQL text** (what `psql` prints) |

Duplicate column names collapse in row objects (last write wins). Use `stmt.textResult()` (rows as
positional `(string | null)[]` arrays plus `columns`) when you need every cell.

### Snapshots

- `db.snapshot()` returns a frozen in-memory `Snapshot`. Per-test isolation should `seed.open()`
  (copy-on-write, microseconds). Encoded bytes are **lazy** via `snapshot.encode()`.
- Format: magic `PGMM` followed by an explicit little-endian format-version `u32`. **Not**
  `pg_dump` output and not loadable by real PostgreSQL.
- Round-trips schemas, tables, rows, sequences (counters included), indexes, views, enums,
  domains, SQL functions, change counters, PRNG state, and clock. JavaScript `registerFunction`
  implementations are omitted.
- Cannot `snapshot()` while a transaction is open (`25P01`).
- `Snapshot.decode(bytes)` does not mutate the input `Uint8Array`. The same buffer object is
  decoded once (WeakMap) and later opens are copy-on-write.
- `open()` shares frozen tables until either side writes; idle `open().snapshot().encode()` is
  byte-identical to `snapshot().encode()`.
- `open()` uses a fixed clock from the snapshot unless you pass `{ now: "system" }`, which stays live.
- Equivalent databases produce byte-identical `encode()` output (schema/rows sorted) **within a
  single library version**.
- **Compatibility policy:** newer library versions can always decode older snapshots; older
  libraries cannot decode newer format versions (`snapshot_version`). Corrupt magic yields a
  distinct error.

### Determinism

The engine is deterministic by default:

| Source | Default | Override / notes |
| --- | --- | --- |
| `random()` / `gen_random_uuid()` | Seeded xorshift64* (`seed: 1`) | `new Database({ seed })`, or `{ random: "os" }` for CSPRNG (not rolled back / not restored) |
| `now()` / `current_timestamp` / friends | Fixed `2000-01-01T00:00:00.000Z` | `new Database({ now: Date \| (() => Date) \| "system" })`; `"system"` is wall clock and is **not** frozen by `open()` |
| `setseed()` / `random()` | Deterministic stream | Matches the engine PRNG, repeatable |
| Table scans | Insertion order | Same order after snapshot/restore |
| Snapshots | Sorted schema/rows + PRNG state + clock | Restored into PRNG and `now` |
| Transactions | PRNG rolls back with `ROLLBACK`/`SAVEPOINT` | Matches data rollback |
| `float8 -0` | Sign preserved | `(-0)::text` is `'-0'`, matching PostgreSQL |

### Compatibility notes for integrators

Goal: **SQL dialect** behavioural parity vs PostgreSQL **18.3** for the sync API. Full matrix:
[COMPATIBILITY.md](./COMPATIBILITY.md). Contract:
[DROP-IN-CONTRACT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/postgres/docs/DROP-IN-CONTRACT.md).

The in-process API has no async client, no connection pooling and no `pg_dump` codec; the optional
[wire-protocol server](#wire-protocol-server-separate-processes) adds a TCP listener and coordinates
several connections over the one engine, but by serializing transaction blocks, not by MVCC.
Intentional differences: custom `PGMM` snapshots; seeded `random()` / fixed `now()` by default
(`{ random: "os" }` / `{ now: "system" }` match PostgreSQL entropy and wall clock).

**Thin or partial areas** (do not assume full oracle fidelity):

- `EXPLAIN`: stub plan shapes, not real planner output
- The in-process API does **not** poison a transaction after a failed statement (no `25P02`); the wire-protocol server does, per connection
- Triggers fire in **creation order** (PostgreSQL: name order); `UPDATE OF` column lists are ignored; `INSTEAD OF` is unsupported
- `COMMENT ON` parses but comments are not stored
- `round(float8)` rounds ties away from zero (PostgreSQL: half-to-even); numeric `round()` has full parity
- `'1e400'::float8` saturates to `Infinity` instead of raising `22003`
- In the engine `MERGE`, `CALL`/procedures, cursors (`DECLARE`/`FETCH`), `LISTEN`/`NOTIFY`, and full PL/pgSQL (packages, NOTICE, cursors) fail loud (`0A000`); the wire-protocol server implements `LISTEN`/`NOTIFY` itself
- `VACUUM` / `ANALYZE` / `CLUSTER` / `REINDEX` / `CHECKPOINT` / `GRANT` / `REVOKE` / `LOCK` are parsed no-ops
- Collation is `C` semantics (byte order); locale/ICU-dependent ordering is out of scope

**Also supported (oracle parity):** schemas + `search_path`, `pg_catalog` / `information_schema`
introspection, sequences (`serial`, identity, `nextval`/`currval`/`setval`), enums, domains,
`LANGUAGE sql` functions, plpgsql-lite UDFs (`DECLARE`, `EXCEPTION WHEN others`, `RETURN NEXT`),
row-level triggers, recursive + data-modifying CTEs, window functions with full frame specs,
`GROUPING SETS`/`ROLLUP`/`CUBE`, `DISTINCT ON`, `LATERAL`, arrays + `unnest` + subscripting,
JSON/JSONB operator + function surface including `jsonb_path_query_first`, `tsvector` text
search, `ON CONFLICT DO NOTHING/UPDATE`, `RETURNING`, `PREPARE`/`EXECUTE`/`DEALLOCATE`,
`SET`/`SHOW`/`RESET` GUCs, `COPY` text and csv.

### Common pitfalls

1. **Do not `await`**: the API is sync.
2. **Parameters are `$1..$n` only**: no `?` placeholders, no named parameters, no sticky `bind()`.
3. **`query` / `prepare` are single-statement only**: multi-statement scripts belong in `exec()` (which does not take bind parameters).
4. **`exec` returns `void` and takes no params**: use `db.prepare(...).run(...)` or `db.query(...)` for binds; use `db.changes` / `stmt.run().rowCount` for counters.
5. **`now()` is not wall-clock** unless you pass `{ now: "system" }` or `{ now: () => new Date() }`. The default is year 2000. `open()` freezes a snapshot clock except when constructed with `"system"`.
6. **`random()` is seeded**, not OS entropy, unless you pass `{ random: "os" }`. Snapshots restore the seeded PRNG; OS entropy is not rewound.
7. **Snapshots are not `pg_dump` output** and cannot be loaded into real PostgreSQL.
8. **`int8` comes back as `bigint` by default** (`count(*)` included); `{ int8: "number" | "string" }` opts out. `numeric`, dates and JSON come back as **text**; parse them explicitly if you need JS numbers/objects.
9. **A failed statement does not abort the transaction**: real PostgreSQL rejects everything after an error inside `BEGIN` until `ROLLBACK`; this engine keeps executing (documented divergence).
10. **Unquoted identifiers fold to lowercase** (the PostgreSQL rule, not uppercase like the SQL standard).
11. **Do not import `@crvouga/mockingbird-service-postgres/unstable` in application code** unless you accept breakage in any release.

## API

Stable runtime exports of the main entry:

| Export | Description |
| --- | --- |
| `Database` | Class. `new Database(options?: DatabaseOptions)` — one in-memory PostgreSQL database and session. |
| `Snapshot` | Class. Frozen template from `db.snapshot()` or `Snapshot.decode(bytes)`; `open(options?)` forks a `Database`, `encode()` serializes. |
| `Statement` | Class returned by `db.prepare(sql)` (not constructed directly): `run`, `all`, `get`, `result`, `textResult`, and `sql`. |
| `PostgresError` | Error class thrown for SQL and API errors: `category` (`ErrorCategory`), `sqlState` / `code` (five-character SQLSTATE, e.g. `"42P01"`, `"23505"`). |

Signatures (types are exported too: `DatabaseOptions`, `RegisterFunctionOptions`, `ResultSet`,
`RunResult`, `ErrorCategory`, `BindValue`, `JsValue`, `QueryRow`):

```text
interface DatabaseOptions {
  seed?: number | bigint                 // default 1; ignored when random is "os"
  random?: "deterministic" | "os"        // default "deterministic"; "os" is CSPRNG like PostgreSQL
  now?: Date | (() => Date) | "system"   // default 2000-01-01T00:00:00.000Z; "system" is wall clock
  int8?: "bigint" | "number" | "string"  // default "bigint"; "number" is unsafe beyond MAX_SAFE_INTEGER
}

class Database {
  constructor(options?: DatabaseOptions)
  exec(sql: string): void
  registerFunction(spec: { name: string; args: string[]; returns: string; strict?: boolean;
                           fn: (...args: JsValue[]) => JsValue }): void
  query<T = QueryRow>(sql: string, params?: readonly BindValue[], options?: { at?: Snapshot }): T[]
  prepare(sql: string): Statement
  transaction<T>(fn: () => T): T
  copyFrom(sql: string, data: string): number   // COPY t FROM STDIN payload (\copy analog)
  snapshot(): Snapshot
  checkpoint(): Snapshot
  branch(at?: Snapshot): Database
  close(): void                                  // also [Symbol.dispose] when available
  readonly changes: number                       // rows affected by the most recent INSERT/UPDATE/DELETE
  readonly seed: number | bigint
  readonly randomMode: "deterministic" | "os"
  readonly int8Mode: "bigint" | "number" | "string"
}

class Snapshot {
  open(options?: DatabaseOptions): Database
  encode(): Uint8Array
  static decode(bytes: Uint8Array): Snapshot
}

class Statement {
  readonly sql: string
  run(...params: BindValue[]): RunResult
  all<T = QueryRow>(...params: BindValue[]): T[]
  get<T = QueryRow>(...params: BindValue[]): T | undefined
  result(...params: BindValue[]): ResultSet          // includes column metadata for zero rows
  textResult(...params: BindValue[]): TextResultSet  // every cell as canonical PostgreSQL text
}

interface RunResult     { rowCount: number; command: string }   // command e.g. "INSERT", "SELECT"
interface ResultSet     { columns: string[]; columnTypes: string[]; rows: QueryRow[]; rowCount: number; command: string }
interface TextResultSet { columns: string[]; columnTypes: string[]; rows: (string | null)[][]; rowCount: number; command: string }
// columnTypes are PostgreSQL internal type names, e.g. "int4", "numeric"

class PostgresError extends Error {
  readonly category: ErrorCategory   // "syntax", "undefined_table", "constraint_unique", "misuse", ...
  readonly sqlState: string          // five-character SQLSTATE
  readonly code: string              // === sqlState (node-postgres err.code convention)
}

type BindValue = null | undefined | boolean | number | bigint | string | Uint8Array | Date
type JsValue   = null | boolean | number | bigint | string | Uint8Array
type QueryRow  = Record<string, JsValue>
```

Stick to `Database`, `Snapshot`, `Statement`, and `PostgresError` in application code. Advanced
internals (`parse`, `tokenize`, `executeStatement`, snapshot codec pieces, `Prng`, ...) are
available only from `@crvouga/mockingbird-service-postgres/unstable` and are **exempt from semver**.

### Stability policy

The exports of the main entry (`@crvouga/mockingbird-service-postgres`) are **frozen**:

- **Never** outside a major: removals, renames, signature changes, or changes to documented
  behaviour of the stable surface.
- **Allowed in minors:** additions (new methods, new optional `DatabaseOptions` fields, new
  `ErrorCategory` values). Consumers that `switch` on `category` must include a default case.
- **`@crvouga/mockingbird-service-postgres/unstable`** is exempt from semver and may change or
  disappear in any release.
- **Snapshots:** newer library versions restore older blobs; older library versions cannot
  restore newer format versions; the byte-identical guarantee holds only within one library version.

## Development

For contributors to the mockingbird repo only. Requires [Bun](https://bun.sh). For
architecture, change checklists, and how to add contract tests, see [AGENTS.md](./AGENTS.md).

Parity is proven by differential contracts against real PostgreSQL: the default oracle is PGlite
(18.3 in WASM), plus optional native PostgreSQL 18.3 via `bun run test:postgres-native`. Isolated
internal unit tests are not PostgreSQL compatibility proof.

```bash
bun install
bun run check:full             # same gates as GitHub Actions CI (except publish)
bun run check                  # format + lint + typecheck + postgres-compat suite
bun run format                 # write Biome formatting
bun run lint                   # Biome lint
bun run typecheck
bun run test:postgres-compat   # requirements + inventory gate + differential suite (PGlite)
bun run test:postgres-native   # same differential suite vs real PostgreSQL 18.3
bun test                       # contract + fuzz + harness
bun run build
```

Fuzz / property tests use a fixed seed (`0x5a17e0e1`) and print it on failure:

```bash
bun test tests/fuzz
bun run test:pbt:random -- 50   # N random seeds, fail fast on first mismatch
POSTGRES_MEM_FUZZ_SEED=12345 bun test tests/fuzz
POSTGRES_MEM_FUZZ_SEED=12345 POSTGRES_MEM_FUZZ_PATH='0:1' bun test tests/fuzz  # exact replay
```

A React + Vite SQL playground lives in
[`examples/react-vite`](https://github.com/crvouga/mockingbird/tree/main/packages/service/postgres/examples/react-vite)
(`bun run example` from this package after `bun install` there). More working examples:
[`tests/contract/api/`](https://github.com/crvouga/mockingbird/tree/main/packages/service/postgres/tests/contract/api)
and [`tests/contract/parameters/`](https://github.com/crvouga/mockingbird/tree/main/packages/service/postgres/tests/contract/parameters).

Released automatically from the [Mockingbird monorepo](https://github.com/crvouga/mockingbird)
(see [Releasing](https://github.com/crvouga/mockingbird/blob/main/docs/RELEASING.md)). License: MIT ([LICENSE](./LICENSE)).

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt) · [report an issue or request a feature](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md).
