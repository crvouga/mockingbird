import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { closeJournal, openJournal } from "./write-journal.js"

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
 * Execute asynchronous service work atomically: on a throw, every record and collection
 * sequence `run` wrote in `namespace` goes back to how it was. Only the rows the work touched
 * are saved and restored, so the cost follows the write, not the size of the namespace. Every
 * namespace write goes through {@link Collection}, which records into the open journal. This is
 * the prescribed escape hatch when the SQLite adapter cannot hold a transaction across `await`;
 * service code should not coordinate raw namespace snapshots itself.
 */
export const withNamespaceRollback = async <T>(
  sqlite: SqliteClient,
  namespace: string,
  run: () => Promise<T>,
): Promise<T> => {
  const journal = openJournal(sqlite, namespace)
  try {
    return await run()
  } catch (error) {
    journal.restore(sqlite, namespace)
    throw error
  } finally {
    closeJournal(sqlite, namespace, journal)
  }
}
