# @crvouga/mockingbird-sqlite

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

The synchronous `SqliteClient` port every Mockingbird mock stores its state in, plus the default
client and an idempotent migration runner. Use it to type the optional `sqlite` option you pass to a
provider mock (to share one database, or to inspect state), or when building a custom service. You
do not need it just to use a mock: omit `sqlite` and each mock creates its own in-memory database.

## Install

```bash
npm install @crvouga/mockingbird-sqlite
```

ESM only, portable (Node >=22, Bun >=1.2, browsers). The default client is the pure-TypeScript
in-memory `@crvouga/mockingbird-service-sqlite`, installed as a dependency.

## Usage

```ts
import {
  createDefaultSqlite,
  listAppliedMigrations,
  type Migration,
  migrate,
  migrateCore,
  resolveSqlite,
  type SqliteClient,
} from "@crvouga/mockingbird-sqlite"

// A fresh in-memory database. Any client with exec/prepare/transaction also works
// (better-sqlite3, a wrapped bun:sqlite, @crvouga/mockingbird-service-sqlite's Database).
const sqlite: SqliteClient = resolveSqlite(undefined) // same as createDefaultSqlite()

migrateCore(sqlite) // mockingbird_records + mockingbird_sequences; mocks do this on boot

const migrations: Migration[] = [
  { id: "001_kv", sql: "CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)" },
]
migrate(sqlite, migrations)
migrate(sqlite, migrations) // no-op: already-applied ids are skipped
console.log(listAppliedMigrations(sqlite).includes("001_kv")) // true

// Bind values are rest arguments on each call; there is no sticky bind().
sqlite.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", 1)
const row = sqlite.prepare("SELECT v FROM kv WHERE k = ?").get<{ v: number }>("a")
console.log(row?.v) // 1

// Share one client between mocks: each mock keeps its records in its own namespace.
const shared = createDefaultSqlite()
void shared // e.g. new StripeAPI({ sqlite: shared }) from @crvouga/mockingbird-service-stripe
```

All methods are synchronous; do not `await` them.

## API

| Export | Signature | Description |
| --- | --- | --- |
| `createDefaultSqlite` | `() => SqliteClient` | New in-memory `@crvouga/mockingbird-service-sqlite` `Database`. |
| `resolveSqlite` | `(sqlite?: SqliteClient) => SqliteClient` | Return the injected client, or `createDefaultSqlite()`. |
| `migrate` | `(sqlite, migrations: readonly Migration[]) => void` | Apply pending migrations in order, all in one transaction. Idempotent by `id`. |
| `listAppliedMigrations` | `(sqlite) => string[]` | Applied ids ordered by `applied_at` (whole seconds), then `id`. Migrations applied in the same second come back sorted by id, not in application order. |
| `CORE_MIGRATIONS` | `readonly Migration[]` | Core schema: `mockingbird_records` (namespaced JSON records) and `mockingbird_sequences`. |
| `migrateCore` | `(sqlite) => void` | `migrate(sqlite, CORE_MIGRATIONS)`. |
| `clearNamespace` | `(sqlite, namespace: string) => void` | Delete every record and sequence in a namespace (what a mock's `reset()` does). |

Types:

- `SqliteClient`: `{ exec(sql): void; prepare(sql): SqliteStatement; transaction<T>(fn: () => T): T }`.
  Duck-typed; `transaction` must run `fn` immediately and return its result.
- `SqliteStatement`: `run(...params)`, `all<T>(...params): T[]`, `get<T>(...params): T | undefined`.
- `SqliteRunResult`: `{ changes: number; lastInsertRowid: number | bigint }`.
- `SqliteValue`: `null | number | bigint | string | Uint8Array | boolean`.
- `Migration`: `{ id: string; sql: string }`. Ids are stored in `schema_migrations`; keep them unique
  and never edit an applied migration.

## Related

- `@crvouga/mockingbird-service-sqlite`: the default in-memory SQLite engine.
- `@crvouga/mockingbird-service`: `bootSqlite`, `Collection` and `IdSequence` on top of this port.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
