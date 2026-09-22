import { Timeline } from "@crvouga/mockingbird-core"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * A point-in-time copy of everything a service namespace holds.
 *
 * All service state lives in the two core tables keyed by namespace, so a snapshot
 * is generic: any service gets per-test rollback without knowing its own schema.
 * Restoring is much cheaper than rebuilding a namespace from a corpus.
 */
export type NamespaceSnapshot = {
  namespace: string
  records: { collection: string; id: string; seq: number; value: string }[]
  sequences: { name: string; kind: string; value: number }[]
}

/**
 * @deprecated Low-level Timeline payload capture retained for API compatibility. Provider code
 * must use the runtime Timeline or `withNamespaceRollback`.
 */
export const snapshotNamespace = (sqlite: SqliteClient, namespace: string): NamespaceSnapshot => ({
  namespace,
  records: sqlite
    .prepare(
      "SELECT collection, id, seq, value FROM mockingbird_records WHERE namespace = ? ORDER BY collection, seq",
    )
    .all<{ collection: string; id: string; seq: number; value: string }>(namespace),
  sequences: sqlite
    .prepare(
      "SELECT name, kind, value FROM mockingbird_sequences WHERE namespace = ? ORDER BY name, kind",
    )
    .all<{ name: string; kind: string; value: number }>(namespace),
})

/**
 * Replace a namespace's contents with `snapshot`. The namespace is emptied first,
 * so restoring is an assignment, not a merge — records created since the snapshot
 * are gone afterwards.
 *
 * @deprecated Low-level Timeline payload restore retained for API compatibility. Provider code
 * must use the runtime Timeline or `withNamespaceRollback`.
 */
export const restoreNamespace = (
  sqlite: SqliteClient,
  namespace: string,
  snapshot: NamespaceSnapshot,
): void => {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM mockingbird_records WHERE namespace = ?").run(namespace)
    sqlite.prepare("DELETE FROM mockingbird_sequences WHERE namespace = ?").run(namespace)
    const record = sqlite.prepare(
      "INSERT INTO mockingbird_records (namespace, collection, id, seq, value) VALUES (?, ?, ?, ?, ?)",
    )
    for (const row of snapshot.records) {
      record.run(namespace, row.collection, row.id, row.seq, row.value)
    }
    const sequence = sqlite.prepare(
      "INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, ?, ?)",
    )
    for (const row of snapshot.sequences) {
      sequence.run(namespace, row.name, row.kind, row.value)
    }
  })
}

/**
 * Execute asynchronous service work atomically using the canonical Timeline rollback primitive.
 * This is the prescribed escape hatch when the SQLite adapter cannot hold a transaction across
 * `await`; service code should not coordinate raw namespace snapshots itself.
 */
export const withNamespaceRollback = async <T>(
  sqlite: SqliteClient,
  namespace: string,
  run: () => Promise<T>,
): Promise<T> => {
  const rollback = new Timeline<NamespaceSnapshot>({ maxCheckpoints: 1 })
  const before = rollback.commit(snapshotNamespace(sqlite, namespace))
  try {
    return await run()
  } catch (error) {
    restoreNamespace(sqlite, namespace, before.value)
    throw error
  }
}
