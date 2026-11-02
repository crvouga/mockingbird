import type { SqliteClient } from "./client.js"

/** One named, ordered schema change applied exactly once per client. */
export type Migration = {
  /** Stable id stored in `schema_migrations`. Must be unique across the list. */
  id: string
  sql: string
}

const ensureMigrationsTable = (sqlite: SqliteClient) => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
}

const assertUniqueIds = (migrations: readonly Migration[]) => {
  const seen = new Set<string>()
  for (const { id } of migrations) {
    if (seen.has(id)) throw new Error(`migrate: duplicate migration id "${id}"; ids must be unique`)
    seen.add(id)
  }
}

/**
 * Apply pending migrations in order inside a single transaction.
 *
 * Idempotent: already-applied ids are skipped. Re-running with the same list
 * is a no-op after the first successful boot.
 *
 * @throws {Error} If two migrations in the list share an id; nothing is applied.
 */
export const migrate = (sqlite: SqliteClient, migrations: readonly Migration[]): void => {
  assertUniqueIds(migrations)
  ensureMigrationsTable(sqlite)
  const applied = new Set(
    sqlite
      .prepare("SELECT id FROM schema_migrations")
      .all<{ id: string }>()
      .map((row) => row.id),
  )
  const pending = migrations.filter((migration) => !applied.has(migration.id))
  if (pending.length === 0) return

  const insert = sqlite.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
  const now = Math.floor(Date.now() / 1000)
  sqlite.transaction(() => {
    for (const migration of pending) {
      sqlite.exec(migration.sql)
      insert.run(migration.id, now)
    }
  })
}

/** Applied migration ids in application order (by `applied_at`, then `id`). */
export const listAppliedMigrations = (sqlite: SqliteClient): string[] => {
  ensureMigrationsTable(sqlite)
  return sqlite
    .prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC, id ASC")
    .all<{ id: string }>()
    .map((row) => row.id)
}
