# @crvouga/mockingbird-service-postgres

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

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
- In-process it is **not** a drop-in for the `pg` / `postgres.js` client APIs or on-disk clusters, but it also ships an **optional wire-protocol server** (`@crvouga/mockingbird-service-postgres/wire`, Node/Bun) that unmodified clients connect to over TCP
- Intentional differences: deterministic `random()` / `now()` by default, and a custom snapshot
  format (not `pg_dump`)

It is not a Mockingbird HTTP emulator and is not the storage engine Mockingbird's HTTP emulators use (they
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
import pg from "pg"
import { Snapshot } from "@crvouga/mockingbird-service-postgres"
import { serve } from "@crvouga/mockingbird-service-postgres/wire"

// Test setup: start the emulator on a free port.
const server = await serve({ port: 0 })

// Application code: the `pg` client it already uses, given the emulator's connection string.
const client = new pg.Client({ connectionString: server.connectionString })
await client.connect()

await client.query(`
  CREATE TABLE users (
    id serial PRIMARY KEY,
    email text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`)
await client.query(`INSERT INTO users (email) VALUES ($1)`, ["ada@example.com"])

const users = await client.query<{ id: number; email: string; created_at: Date }>(
  `SELECT * FROM users`,
)
console.log(users.rows) // [{ id: 1, email: "ada@example.com", created_at: 2000-01-01T00:00:00.000Z }]

// Test control, snapshots: freeze a template, boot a fork from it, or persist it as bytes.
const seed = server.snapshot()
const fork = await serve({ database: seed })
const restored = await serve({ database: Snapshot.decode(seed.encode()) })

await client.end()
await Promise.all([server.close(), fork.close(), restored.close()])
```

`postgres.js`, a JDBC client and `psql` connect with the same connection string; see the
[wire-protocol server](#wire-protocol-server-separate-processes) (Node/Bun only). In the browser,
where no listener can run, use the embedded `Database` from the package root instead. It shares
the same in-memory engine (no filesystem) and all its methods are **synchronous**; do not `await`
them. See [Method semantics](#method-semantics).

### Per-test isolation with snapshots

Run migrations and fixtures once, `snapshot()` the result, and boot a server from that snapshot
per test. Each one is a copy-on-write fork (microseconds, tables are shared until either side
writes); with the embedded `Database`, `seed.open()` is the same fork without a listener:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import pg from "pg"
import { Database } from "@crvouga/mockingbird-service-postgres"
import { type PostgresServer, serve } from "@crvouga/mockingbird-service-postgres/wire"

// Test setup: build the template once, then boot a server from it for every test.
const template = new Database()
template.exec(`
  CREATE TABLE accounts (id serial PRIMARY KEY, email text UNIQUE NOT NULL);
  INSERT INTO accounts (email) VALUES ('seed@example.com');
`)
const seed = template.snapshot()

let server: PostgresServer
let db: pg.Client
beforeEach(async () => {
  server = await serve({ database: seed })
  db = new pg.Client({ connectionString: server.connectionString })
  await db.connect()
})
afterEach(async () => {
  await db.end()
  await server.close()
})

// Application code under test uses `db`, an ordinary `pg` client.
test("unique violation surfaces SQLSTATE 23505", async () => {
  const insert = db.query(`INSERT INTO accounts (email) VALUES ($1)`, ["seed@example.com"])
  await expect(insert).rejects.toMatchObject({ code: "23505", constraint: "accounts_email_key" })
})

test("each test starts from the seed", async () => {
  const { rows } = await db.query(`SELECT email FROM accounts`)
  expect(rows).toEqual([{ email: "seed@example.com" }])
})
```

### Code written against `pg`

Code written against `pg` needs no adapter: give `pg.Pool` (or `pg.Client`) the server's connection
string. `pg` applies its own type parsers, so `int8` / `bigserial` / `count(*)` come back as
strings, as they do against a real server:

```ts
import pg from "pg"
import { serve } from "@crvouga/mockingbird-service-postgres/wire"

// Test setup: start the emulator and give the pool its connection string.
const server = await serve({ port: 0 })
export const pool = new pg.Pool({ connectionString: server.connectionString })

// Application code: unchanged `pg` queries.
await pool.query(`CREATE TABLE notes (id bigserial PRIMARY KEY, body text)`)
const inserted = await pool.query<{ id: string }>(
  `INSERT INTO notes (body) VALUES ($1) RETURNING id`,
  ["hello"],
)
console.log(inserted.rows[0]?.id, inserted.rowCount) // "1" 1

await pool.end()
await server.close()
```

Errors are `pg`'s own `DatabaseError` with `code` set to the SQLSTATE. Where no listener can run
(the browser), put the embedded `Database` behind whatever query interface your code uses. The
differences from node-postgres to account for there: `int8` is a `bigint` unless you pass
`{ int8: "string" }`; timestamps, dates, `numeric` and `json`/`jsonb` come back as PostgreSQL text
(node-postgres parses timestamps to `Date` and JSON to objects); `prepare`/`query` accept one
statement at a time (use `exec` for scripts); errors are `PostgresError` with `code` set to the
SQLSTATE, like `pg`'s `DatabaseError.code`.

### Wire-protocol server (separate processes)

When another process must connect over TCP — `pg`, `postgres.js`, a JDBC client, `psql`, a service
in a local multi-service stack — start the frontend/backend v3 server. It needs
`node:net`, so it is a separate Node/Bun entry (`/wire`) and the main package stays browser-safe.

```ts
import { serve } from "@crvouga/mockingbird-service-postgres/wire"

const server = await serve({ port: 0 }) // 0 → a free port, reported as server.port
// server.connectionString — postgres://postgres@127.0.0.1:<port>/postgres
await server.close()

const fromUri = await serve("postgres://postgres:secret@127.0.0.1:0/app")
// fromUri.connectionString uses the bound port. A client that asks for another
// database name is rejected with SQLSTATE 3D000.
await fromUri.close()
```

The wire server owns a PostgreSQL-style database catalog. Start on `postgres`, then use ordinary
`CREATE DATABASE`, `DROP DATABASE`, and `ALTER DATABASE … RENAME TO` statements; startup packets
select an isolated engine and unknown names fail with `3D000`. `CREATE DATABASE child TEMPLATE
seed` forks `seed` through the same copy-on-write snapshot path as `Snapshot.open()`. The live names
are available through `pg_database` and `server.databaseNames()`, while
`server.getDatabase(name)` and `server.snapshot(name)` provide programmatic test controls.

Or from the command line (installs a `mockingbird-postgres` bin):

```bash
mockingbird-postgres serve --port 55432            # trust auth
mockingbird-postgres serve postgres://postgres:secret@0.0.0.0:55432/app --log
mockingbird-postgres serve --port 55432 --durable ./.postgres   # commits survive a restart
```

`serve({ database })` shares an existing `Database`, and `serve({ database: snapshot })` boots every
server from one frozen template, so a seeded stack starts from the same bytes each time.
`createAdmin` from `@crvouga/mockingbird-service-postgres/admin` serves the same `/__admin`
surface as every other emulator, including the table explorer (`GET /sql/tables`, `POST /sql/query`).
The wire server does not speak that HTTP API.

`mockingbird-postgres serve --config mockingbird.json` also supervises a mixed HTTP/Postgres/Redis
fleet through the Node `/server` entry. See [fleet configuration and controls](../../../docs/FLEETS.md)
for ephemeral discovery, namespace endpoints, aggregate health, snapshots and clocks. Each declared
namespace has an independent cluster. Fleet checkpoints restore its entire catalog, including created
and dropped databases, records, deterministic random state, faults and time; live client sessions
return a conflict until closed.

`server.snapshot()` freezes the live state; `server.fault({ dropConnection | delayStatementMs |
failCommit })` arms the next statement or connection for a drop, a delay, or a `40001` commit
failure. `server.fault({ failConcurrentIndexBuild: "57014" })` (and `database.fault({
concurrentIndexBuild: "57014" })` on the sync API) interrupts the next `CREATE INDEX CONCURRENTLY`
or `REINDEX ... CONCURRENTLY` with that SQLSTATE and, as PostgreSQL does, leaves the index it was
building in the catalog with `pg_index.indisvalid = false` until it is dropped or reindexed.

One committed engine is shared by every connection. Explicit transactions execute in per-session
copy-on-write workspaces that rebase each statement on the latest committed state, providing
`READ COMMITTED` visibility without holding an engine-wide transaction turn. Successful writes
are applied atomically at commit; rollback discards the workspace. Across connections the server
adds row locks for `SELECT … FOR UPDATE` (including blocking, `NOWAIT`, `SKIP LOCKED`, and
deadlock SQLSTATE `40P01`) and per-session advisory locks (`pg_advisory_lock` /
`pg_try_advisory_lock` / `_xact_` / `_unlock`) with in-order waiters and deadlock detection
(`40P01`), `LISTEN`/`NOTIFY` delivered to idle listeners, `CancelRequest` (a blocked statement ends
`57014` and the session stays usable), and per-connection aborted-transaction state (a failed
statement in a block is `25P02` until `ROLLBACK`, with `ReadyForQuery` reporting `I`/`T`/`E`).
SCRAM-SHA-256 and trust auth, the extended query protocol (`Parse`/`Bind`/`Describe`/`Execute`/
`Sync`) with text and binary parameters and results, real type OIDs in `RowDescription`, and
`23505`/`23502` errors carrying the constraint, table and column the engine names, all work over
the wire. `COPY … FROM STDIN` and `COPY … TO STDOUT` use protocol-v3 `CopyInResponse`,
`CopyOutResponse`, `CopyData`, `CopyDone`, and `CopyFail` messages. Text and CSV streams are parsed
incrementally across arbitrary frame and quoted-record boundaries; failed imports are atomic and
leave the connection in PostgreSQL's transaction state.

**Session settings and startup parameters.** Every connection has its own settings: a `SET`,
`RESET` or `set_config()` on one never reaches another, a `SET` inside a transaction block is
undone by `ROLLBACK`, and a new connection starts from the database's settings, not a neighbour's.
The startup packet's run-time parameters are applied before the first query, the way a PostgreSQL
backend applies them: libpq's `options` string first, then every parameter sent by name (which
therefore wins).

```ts
import pg from "pg"
import { serve } from "@crvouga/mockingbird-service-postgres/wire"

const server = await serve({ port: 0 })
const client = new pg.Client({
  connectionString: `${server.connectionString}?options=-c%20search_path%3Dapp`,
})
await client.connect()
await client.query("CREATE SCHEMA app")
await client.query("CREATE TABLE app.notes (id integer)")
await client.query("SET search_path TO app")
await client.end()
await server.close()
```

Other clients set the same startup option with their own configuration (for example, JDBC's
`currentSchema` or postgres.js / Bun SQL's `connection.search_path`).

`options` is split like `pg_split_opts` (whitespace separates arguments, `\ ` is a literal space,
`\\` a backslash) and accepts `-c name=value`, `-cname=value` and `--name=value` (dashes in a
`--name` are underscores). A schema named in `search_path` need not exist yet: it starts resolving
once it is created. Startup values are the session's defaults, so `RESET search_path`,
`SET search_path TO DEFAULT` and `RESET ALL` return to them. Invalid input ends the connection
with a `FATAL` ErrorResponse, as PostgreSQL 18.3 does: `42601` for a malformed `options` string
(`-c name` without a value, a stray argument, an unknown switch), `42704` for an unknown
parameter, `22023` for a bad value (`search_path` list syntax, booleans, integers and timeouts with
units, enum parameters, `DateStyle`, `TimeZone`) and `55P02` for a read-only parameter such as
`server_version`. The session-aware functions (`pg_advisory_lock`, `pg_backend_pid`, `pg_notify`,
…) live in `pg_catalog`, so they keep working when `search_path` leaves out `public`.

Boundaries: a parameter is known when the engine has a setting for it (the same rule as `SET`), so
a real PostgreSQL parameter the engine does not model, such as `work_mem` or `jit`, is `42704`
at startup too; names with a dot are custom parameters and always accepted. The other `postgres`
switches (`-e`, `-S`, `-d`, …) fail loud with `0A000`. `client_encoding`, `lc_*` and
`application_name` values are stored as sent, an unquoted upper-case schema in a startup
`search_path` is shown folded to lower case, and `ParameterStatus` is sent at startup only, not
again when a reported setting changes. `SET LOCAL` and `DISCARD ALL` keep their engine behaviour
(see [COMPATIBILITY.md](COMPATIBILITY.md)).

**Not modelled by the server:** transaction ID and snapshot-inspection functions, predicate and
table locks, isolation levels beyond `READ COMMITTED`, and binary formats for types outside the
list below (binary parameters of such a type, and a binary result column that the client did not
`Describe`, get `0A000`; a described portal reports text for that column in its `RowDescription`).
Binary `COPY` is not supported.

**Describe and binary formats.** `Describe` of a statement answers `ParameterDescription` with one
OID per `$n`: the type `Parse` declared, else the one PostgreSQL infers (a cast, the compared or
assigned column, `LIMIT`/`OFFSET` as `bigint`), else `text`; and a `RowDescription` for a
row-returning statement even when its parameters are untyped, which is what asyncpg and
`psql \gdesc` rely on. The column types come from the catalog the session sees, so a table created
earlier in the open transaction is described. Binary results and parameters use PostgreSQL's
`send`/`recv` layouts, checked against a real server's bytes, for `bool`, `int2`/`int4`/`int8`,
`oid`, `float4`/`float8`, `numeric`, `money`, `bytea`, `uuid`, `text`/`varchar`/`bpchar`/`name`,
`json`, `jsonb` (version byte), `date`, `time`, `timestamp`, `timestamptz` (microsecond
precision), `interval`, `bit`/`varbit`, enums and one-dimensional or multi-dimensional arrays of
those. Inference is by the SQL's shape, so a parameter that only appears in an expression the
emulator does not analyse is reported as `text` (PostgreSQL would raise `42P18` for some of these).

#### Durable mode (opt-in)

The server keeps everything in memory, and that stays the default: no option, no filesystem, the
same bytes on every run. For local development, where the server replaces a native database and
a killed process must not lose acknowledged work, `durable` persists the cluster before each
commit is acknowledged:

```ts
import { serve } from "@crvouga/mockingbird-service-postgres/wire"

const server = await serve({ port: 55432, durable: "./.postgres" }) // a directory
// … the process is SIGKILLed …
const again = await serve({ port: 55432, durable: "./.postgres" }) // resumes from the last acknowledged commit
await again.close()
```

| | Guarantee |
| --- | --- |
| Acknowledged commit | An autocommit write, a `COMMIT`, the implicit commit of a multi-statement query, a `COPY … FROM STDIN` and `CREATE` / `DROP` / `ALTER DATABASE` are in storage before `CommandComplete` (for an implicit commit, before `ReadyForQuery`) is sent. They survive `SIGKILL`. |
| Uncommitted work | A transaction that was open or rolled back is never restored: it only ever existed in its session's workspace. |
| Storage failure | The commit is not acknowledged. The statement fails with `58030` (`io_error`), or `53100` (`disk_full`) when the storage reports `ENOSPC` / `EDQUOT`; the change is taken back out of memory, the transaction is gone (as after any failed `COMMIT`: the session is idle, not in an aborted block), its `NOTIFY`s are dropped, and the next statement runs normally. |
| Atomic | The file-backed store writes each file under a temporary name, fsyncs it, renames it into place and fsyncs the directory; the manifest swap is the commit point. A crash leaves the previous state or the new one. Leftovers of an interrupted write are removed on the next start, and a snapshot whose length or SHA-256 does not match its manifest entry is refused, never decoded. |
| Whole cluster | Every database with its catalog, data, sequences and deterministic random position. A restart restores all of them; separate directories (or storages) are separate clusters. |
| Visibility | A commit being persisted holds the statement turn, so no other connection reads it before it is durable. |

It is **snapshot persistence, not a write-ahead log, and not PostgreSQL's on-disk format**: the
payload is the [PGMM snapshot](#snapshots) of each database (`<sha256>.pgmm`)
plus a `MANIFEST.json` naming the current one per database. Nothing reads a PostgreSQL data
directory, and `pg_dump`, physical replication and point-in-time recovery do not apply.

The trade-off is cost per commit: every commit re-encodes the database it changed (other
databases are not rewritten) and then waits for two file fsyncs and two directory fsyncs. That is
proportional to the size of that database, not to the size of the change: about 10 ms for a
200 KB snapshot and several hundred milliseconds for 2 MB (100 000 short rows) on a laptop. It
suits development datasets; batch bulk writes into one transaction (one `COMMIT`, one encode), and
keep the in-memory default for tests. Reads, `SET` and statements inside an open transaction
never touch storage; a statement that could have written (a `SELECT` calling a user-defined
function, a view or `nextval`) is encoded and compared, and written only if the snapshot differs.
`fsync` is as strong as the platform makes it: surviving a killed process does not depend on it,
surviving power loss does.

Boundaries of durable mode:

- One server process per directory; nothing locks it.
- `database` seeds an empty storage (the seed is persisted at startup). Once storage holds a
  cluster, that cluster is served and `database` only supplies the runtime: clock, seed, entropy
  mode and `int8` mode. Read state through `server.database`, not the object you passed.
- What a PGMM snapshot does not hold is not restored: functions added with `registerFunction`,
  session state (settings, prepared statements, advisory locks, `LISTEN`s), and faults.
- Writes made from the host process (`server.database.exec(...)`, `restoreAll()`) are not commits
  of a connection: call `await server.persist()` to store them. A host-side read during a commit
  can see it before it is durable.
- `nextval()` and `setval()` are persisted at once. The random position consumed by a statement
  that wrote nothing (`SELECT gen_random_uuid()`) is stored with the next commit of that database.
- `mockingbird-postgres serve --config` (the fleet) has no durable option.

The storage is a port, so a test can model failure and crashes without a filesystem:

```ts
import { type ClusterImage, type DurableStorage, fileStorage, serve } from "@crvouga/mockingbird-service-postgres/wire"

let image: ClusterImage | null = null
let failing = false
const paused = Promise.resolve()
const storage: DurableStorage = {
  read: async () => image,
  write: async (next) => {
    if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }) // → 53100, not acknowledged
    image = new Map(next)
  },
}
const server = await serve({
  durable: {
    storage, // or a directory, or fileStorage(directory)
    beforeAcknowledge: (commit) => paused, // persisted, not acknowledged yet: crash here
    afterAcknowledge: (commit) => paused, // the acknowledgement is on the socket: crash here
  },
})
const restarted = await serve({ durable: storage }) // "restart" from what storage holds
```

`write` receives the whole cluster as PGMM bytes per database and must be atomic: resolve once the
image would survive a kill, or reject and leave the previous image in place. The server never
calls it concurrently and passes the same `Uint8Array` for a database that did not change.
`beforeAcknowledge` / `afterAcknowledge` receive `{ pid, database, sql }` and are awaited, which
is how a crash-regression test stops the server on either side of the acknowledgement.

### Method semantics

| Method | Behaviour |
| --- | --- |
| `exec(sql)` | Runs all semicolon-separated statements; **discards** row results (`void`). Does **not** accept bind parameters. Read `db.changes` afterwards if needed (reflects the **most recent** completed DML statement). Dump-only `DO` blocks and `ALTER TABLE ... SET (` storage parameters are no-ops. |
| `registerFunction(spec)` | Install a JavaScript scalar. Not stored in PGMM snapshots; `open()` of a live snapshot copies the implementation by reference. A `pg_catalog.`-qualified name is found ahead of `search_path`, as PostgreSQL's own functions are. |
| `query(sql, params?, { at? }?)` | **Single statement only** (trailing `;` is fine). Returns all rows. `at` is a `Snapshot` or a timeline checkpoint id and queries that checkpoint without changing live state. Multi-statement scripts throw `misuse`. |
| `prepare(sql)` | **Single statement only**. Parses immediately; the AST is reused. Pass binds as rest args to `run` / `all` / `get` / `result` / `textResult` on each call. |
| `transaction(fn)` | If idle: `BEGIN`, `fn()`, `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. A nested SQL `BEGIN` inside is a no-op warning like PostgreSQL. `close()` inside `fn` throws `misuse`. |
| `fault({ concurrentIndexBuild })` | Test control: arm the next `CREATE INDEX CONCURRENTLY` / `REINDEX ... CONCURRENTLY` to fail with the given SQLSTATE (`"57014"` canceled, `"40P01"` deadlock) and leave its index invalid (`pg_index.indisvalid = false`), as an interrupted build does on PostgreSQL. One shot; not part of snapshots. |
| `copyFrom(sql, data)` | Executes `COPY table [(cols)] FROM STDIN` with `data` as the copy-in payload (text or csv per the COPY options). Returns rows copied. `COPY ... TO STDOUT` output is returned as result rows by `query`. |
| `snapshot()` | Freeze a reusable `Snapshot` template (no encode) and commit it on the followed timeline branch. Illegal inside a transaction (`25P01`). |
| `checkpoint()` / `branch(at?)` | `checkpoint` records the same timeline point as `snapshot`. `branch` opens an isolated database from a snapshot (or the current state). |
| `record(branch?)` / `fork(name, at?)` / `checkout(id, branch?)` / `reset()` | Timeline history on this database. `record` commits the live state. `fork` adds a branch pointer and does not switch live state. `checkout` installs a checkpoint. `reset` returns to the origin checkpoint on `main`. `history` lists heads and checkpoints. |
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
[wire-protocol server](#wire-protocol-server-separate-processes) adds a TCP listener, per-session
`READ COMMITTED` transaction workspaces, and row-level worker locks.
Intentional differences: custom `PGMM` snapshots; seeded `random()` / fixed `now()` by default
(`{ random: "os" }` / `{ now: "system" }` match PostgreSQL entropy and wall clock).

**Thin or partial areas** (do not assume full oracle fidelity):

- `EXPLAIN`: stub plan shapes, not real planner output
- The in-process API does **not** poison a transaction after a failed statement (no `25P02`); the wire-protocol server does, per connection
- Triggers fire in **creation order** (PostgreSQL: name order); `UPDATE OF` column lists are ignored; `INSTEAD OF` is unsupported
- `COMMENT ON INDEX` is stored (`pg_description`, `obj_description`); comments on every other kind of object parse but are not stored
- `round(float8)` rounds ties away from zero (PostgreSQL: half-to-even); numeric `round()` has full parity
- `'1e400'::float8` saturates to `Infinity` instead of raising `22003`
- In the engine `MERGE`, `CALL`/procedures, cursors (`DECLARE`/`FETCH`), `LISTEN`/`NOTIFY`, and full PL/pgSQL (packages, NOTICE, cursors) fail loud (`0A000`); the wire-protocol server implements `LISTEN`/`NOTIFY` itself
- `VACUUM` / `CLUSTER` / `CHECKPOINT` / `GRANT` / `REVOKE` / `LOCK` are parsed no-ops. `ANALYZE` validates its targets and records `analyze_count` / `last_analyze`, and `REINDEX` validates its targets and repairs an invalid index; neither has planner statistics or a physical index behind it
- `pg_stat_user_tables` / `pg_stat_user_indexes` have PostgreSQL 18's columns, but only `n_live_tup` (the exact row count, immediately), the `ANALYZE` bookkeeping and `idx_scan` for unique-key lookups are real; the other activity counters read zero
- Index access methods other than btree (`USING hash` / `gin` / …) are recorded and shown by `pg_get_indexdef` and `pg_am`, not implemented differently; `pg_index` has no `indkey` (use `pg_get_indexdef(oid, n, pretty)`)
- Collation is `C` semantics (byte order); locale/ICU-dependent ordering is out of scope
- Column `STORAGE` modes (`pg_attribute.attstorage`) and `UNLOGGED` persistence (`pg_class.relpersistence`) follow PostgreSQL's SQL and catalog contract but are metadata only: there is no TOAST and no WAL, so an unlogged table is stored, snapshotted and kept like any other
- `pg_available_extensions` / `pg_extension` list only what `CREATE EXTENSION` can install here (`pgcrypto`, `pg_trgm`) plus the built-in `plpgsql`; any other extension is absent from the views and `CREATE EXTENSION` fails with `0A000`
- pgvector is not modelled: `CREATE EXTENSION vector` fails with `0A000 extension "vector" is not available`, exactly as stock PostgreSQL 18 (which does not ship it) answers, and `vector(n)` / `<=>` do not exist (`42704`)
- Range, multirange, geometric, `xml`, `pg_lsn` and `macaddr8` types fail with `0A000` (`type "int4range" is not supported`); `inet`, `cidr` and `macaddr` have input, output, ordering and casts, and the `family` / `masklen` / `host` / `network` / `broadcast` / `netmask` functions, but none of their operators (`<<`, `>>=`, `&&`, `+`)
- SQL/JSON path covers `lax` / `strict`, filters, variables, arithmetic and the `type` / `size` / `double` / `ceiling` / `floor` / `abs` methods; `.**`, `.keyvalue()`, datetime methods and the `.bigint()` / `.string()` conversions fail with `0A000`
- `jsonb_populate_record(set)` is not implemented (composite types); `pg_depend`, `pg_authid`, `pg_locks`, `pg_stat_activity` and the other catalogs tools probe list only what the engine models (one role, one backend, no inheritance)
- `RowDescription` carries the type modifier (`varchar(32)`, `numeric(10,2)`) of table columns and typed casts; set operations, `VALUES` and `RETURNING` report `-1`

**Also supported (oracle parity):** schemas + `search_path`, `pg_catalog` / `information_schema`
introspection, sequences (`serial`, identity, `nextval`/`currval`/`setval`), enums, domains,
`LANGUAGE sql` functions, plpgsql-lite UDFs and anonymous `DO` blocks (`DECLARE`, `EXCEPTION WHEN <condition>`, `RAISE`, `EXECUTE`, `RETURN NEXT`),
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

`analyzeSchema(sql, options?)` returns bounded, JSON-serializable schema compatibility diagnostics
without changing an application database. Accepted statements remain semantically unverified;
see [schema preflight and row-version metadata](COMPATIBILITY.md#schema-preflight-and-row-version-metadata)
for limits, the report contract and `xmin` support.

Browser durability is opt-in through `openDurableDatabase({ key, backend?, databaseOptions?, pageSize? })`.
It returns a `Durable<Database>` handle: `.value` is the existing synchronous database,
`.flush()` saves a batch, `.write(db => ...)` serializes a synchronous batch and saves it, and
`.close()` saves before closing. Await a save before considering writes durable. Wrap related
SQL operations in `db.transaction()` when they need rollback as well as persistence.

```ts
import { openDurableDatabase, IndexedDBDurabilityBackend } from "@crvouga/mockingbird-service-postgres";

const backend = new IndexedDBDurabilityBackend({ name: "my-app" });
const durable = await openDurableDatabase({ key: "main", backend });
const db = durable.value;
// Use db.exec / db.prepare / db.transaction as before.
await durable.flush(); // acknowledges an atomic storage commit
await durable.close();
await backend.close(); // release the connection when its last user finishes
```

`IndexedDBDurabilityBackend` is the default and stores binary pages with atomic revision checks;
it sends only changed pages in one transaction. `durability: "strict"` is the default;
`"relaxed"` is available for explicitly weaker power-loss guarantees. Both settings resolve
only on the IndexedDB transaction's `complete` event.
`LocalStorageDurabilityBackend({ storage?, prefix?, locks? })` is a small-image fallback with
whole-image base64 rewrites and synchronous IO. It uses Web Locks when available; without
Web Locks, use a single writer per key. `MemoryDurabilityBackend` is a reference adapter.
A stale save throws `DurabilityConflictError`; reopen to reconcile rather than overwriting
another tab. Quota/IO failures reject the save, preserve the previously committed image and
can be retried. Saved data remains subject to the browser's storage quota and eviction policy.

`openDurable({ backend, key, codec, pageSize? })` works with any emulator using an injected
`DurabilityCodec<T>`. The `DurabilityBackend` port exposes `load` and atomic `commit` of a
`DurablePatch` against an expected revision. `DurableImage` carries the binary image, revision
and page size. The port and adapters are shared with `@crvouga/mockingbird-core`.
`withDurability(api, durable)` serializes Fetch requests and flushes before returning each
response. For other Mockingbird services, inject `durable.value` through their existing
`sqlite` option, then send requests through this wrapper. Route all writes through the same
handle/wrapper to preserve serialization; do not mutate the database during an outstanding save.

The immediate durability opener encodes one full SQLM/PGMM snapshot per batch and compares fixed-size pages (default
16 KiB). This targets small to moderate databases, not unbounded datasets. It avoids per-row
storage IO, but encoding is still O(database size). It is not an SQLite file or OPFS VFS.
See [the browser benchmark](https://github.com/crvouga/mockingbird/blob/main/packages/service/sqlite/benchmarks/DURABILITY.md) for measurements and limits.

For higher write throughput, use `openBufferedDurableDatabase({ key, backend?, ... })`.
The returned `BufferedDurable<Database>` keeps the synchronous SQL API and schedules a save
1,000 ms after the first unsaved change. This is a background deadline, not a debounce;
suspended tabs and storage failures can delay it. The default owned IndexedDB adapter uses
`durability: "relaxed"`. Use one writer per database key. Recent unsaved changes can be lost.

```ts
import { openBufferedDurableDatabase } from "@crvouga/mockingbird-service-postgres";

const durable = await openBufferedDurableDatabase({
  key: "main",
  flushIntervalMs: 1000,
  onError: (error) => console.error("Background save failed", error),
});
durable.value.exec("UPDATE items SET value = value + 1 WHERE id = 1");
// SQL returns immediately; persistence runs in the background.
await durable.flush(); // use when an acknowledgement is required
await durable.close(); // flush and release the handle before leaving
```

Ordinary saves coalesce changed rows and append physical values plus runtime metadata;
they do not encode or scan every stored row, and recovery does not replay SQL/functions.
`pending` reports unacknowledged changes/queued work; `lastError` records background failures.
IO/quota failures retain pending work and retry with bounded backoff; a revision conflict
stops background persistence. Explicit `write`, `flush`, and `close` reject on failure and
await storage acknowledgement. Close through the handle, not `durable.value.close()`.
Do not leave SQL transactions open across a flush. Page-hide persistence is best effort.

Checkpoints compact after 256 delta batches or journal growth of at least
`max(4 MiB, checkpoint size)` by default (`compactAfterBatches`, `compactAfterBytes`).
Schema changes, unsupported incremental shapes, public raw state/native container access
and borrowed binary results/parameters conservatively select full checkpoints. Both openers read old
SQLM/PGMM images and the versioned checkpoint/journal envelope; opting in upgrades the image
on save. `Snapshot.encode/decode` formats and the existing immediate opener's defaults stay
unchanged. LocalStorage uses the same port but still rewrites the whole image.

`openBufferedDurable` is the reusable controller for other emulators, via an injected
`IncrementalDurabilityCodec`, `DurabilityScheduler`, `DurabilityLifecycle` and the same
`DurabilityBackend`. `browserDurabilityLifecycle` supplies optional page-hide notifications.
`encodeDurableCheckpoint`, `readDurableJournal`, `packDurableRecord`, and
`unpackDurableRecord` provide the shared versioned envelope/record framing.

Stable runtime exports of the main entry include `openDurableDatabase`, `openDurable`,
`withDurability`, `IndexedDBDurabilityBackend`, `LocalStorageDurabilityBackend`,
`MemoryDurabilityBackend`, `DurabilityConflictError`, and the existing exports:


| Export | Description |
| --- | --- |
| `Database` | Class. `new Database(options?: DatabaseOptions)` — one in-memory PostgreSQL database and session. |
| `Snapshot` | Class. Frozen template from `db.snapshot()` or `Snapshot.decode(bytes)`; `open(options?)` forks a `Database`, `encode()` serializes. |
| `Statement` | Class returned by `db.prepare(sql)` (not constructed directly): `run`, `all`, `get`, `result`, `textResult`, and `sql`. |
| `PostgresError` | Error class thrown for SQL and API errors: `category` (`ErrorCategory`), `sqlState` / `code` (five-character SQLSTATE, e.g. `"42P01"`, `"23505"`). |

Signatures (types are exported too: `DatabaseOptions`, `HistoryCheckpoint`, `DatabaseHistory`,
`RegisterFunctionOptions`, `ResultSet`, `RunResult`, `ErrorCategory`, `BindValue`, `JsValue`,
`QueryRow`):

```ts
interface DatabaseOptions {
  seed?: number | bigint                 // default 1; ignored when random is "os"
  random?: "deterministic" | "os"        // default "deterministic"; "os" is CSPRNG like PostgreSQL
  now?: Date | (() => Date) | "system"   // default 2000-01-01T00:00:00.000Z; "system" is wall clock
  int8?: "bigint" | "number" | "string"  // default "bigint"; "number" is unsafe beyond MAX_SAFE_INTEGER
  maxCheckpoints?: number                // timeline checkpoints to retain; default 1000
}

interface HistoryCheckpoint {
  id: string
  branch: string
  parent: string | null
  at: number
}

interface DatabaseHistory {
  readonly size: number
  head(branch?: string): HistoryCheckpoint | undefined
  branches(): Readonly<Record<string, string>>
  checkpoints(): readonly HistoryCheckpoint[]
}

declare class Database {
  constructor(options?: DatabaseOptions)
  exec(sql: string): void
  registerFunction(spec: { name: string; args: string[]; returns: string; strict?: boolean;
                           fn: (...args: JsValue[]) => JsValue }): void
  query<T = QueryRow>(sql: string, params?: readonly BindValue[], options?: { at?: Snapshot | string }): T[]
  prepare(sql: string): Statement
  transaction<T>(fn: () => T): T
  copyFrom(sql: string, data: string): number   // COPY t FROM STDIN payload (\copy analog)
  snapshot(): Snapshot
  checkpoint(): Snapshot
  record(branch?: string): HistoryCheckpoint
  fork(name: string, at?: string): HistoryCheckpoint
  checkout(id: string, branch?: string): HistoryCheckpoint
  reset(): HistoryCheckpoint
  readonly history: DatabaseHistory
  branch(at?: Snapshot): Database
  close(): void                                  // also [Symbol.dispose] when available
  readonly changes: number                       // rows affected by the most recent INSERT/UPDATE/DELETE
  readonly seed: number | bigint
  readonly randomMode: "deterministic" | "os"
  readonly int8Mode: "bigint" | "number" | "string"
}

declare class Snapshot {
  open(options?: DatabaseOptions): Database
  encode(): Uint8Array
  static decode(bytes: Uint8Array): Snapshot
}

declare class Statement {
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

declare class PostgresError extends Error {
  readonly category: ErrorCategory   // "syntax", "undefined_table", "constraint_unique", "misuse", ...
  readonly sqlState: string          // five-character SQLSTATE
  readonly code: string              // === sqlState (node-postgres err.code convention)
}

type ErrorCategory = string // "syntax" | "undefined_table" | "constraint_unique" | "misuse" | ...
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
