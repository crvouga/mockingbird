import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

type RecordImage = { seq: number; value: string } | null

/**
 * The rows a rollback scope must put back: each record and collection sequence as it was before
 * the scope first wrote it (`null` when it did not exist yet).
 */
export class WriteJournal {
  readonly records = new Map<string, { collection: string; id: string; before: RecordImage }>()
  readonly sequences = new Map<string, number | null>()

  restore(sqlite: SqliteClient, namespace: string): void {
    sqlite.transaction(() => {
      const remove = sqlite.prepare(
        "DELETE FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
      )
      const put = sqlite.prepare(
        `INSERT INTO mockingbird_records (namespace, collection, id, seq, value) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace, collection, id) DO UPDATE SET seq = excluded.seq, value = excluded.value`,
      )
      for (const { collection, id, before } of this.records.values()) {
        if (before) put.run(namespace, collection, id, before.seq, before.value)
        else remove.run(namespace, collection, id)
      }
      const removeSequence = sqlite.prepare(
        "DELETE FROM mockingbird_sequences WHERE namespace = ? AND name = ? AND kind = 'collection'",
      )
      const putSequence = sqlite.prepare(
        `INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, 'collection', ?)
           ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
      )
      for (const [name, before] of this.sequences) {
        if (before === null) removeSequence.run(namespace, name)
        else putSequence.run(namespace, name, before)
      }
    })
  }
}

const open = new WeakMap<SqliteClient, Map<string, Set<WriteJournal>>>()

/** The journals recording writes to `namespace`, innermost scope included. */
export const openJournals = (
  sqlite: SqliteClient,
  namespace: string,
): ReadonlySet<WriteJournal> | undefined => open.get(sqlite)?.get(namespace)

export const openJournal = (sqlite: SqliteClient, namespace: string): WriteJournal => {
  let namespaces = open.get(sqlite)
  if (!namespaces) {
    namespaces = new Map()
    open.set(sqlite, namespaces)
  }
  let journals = namespaces.get(namespace)
  if (!journals) {
    journals = new Set()
    namespaces.set(namespace, journals)
  }
  const journal = new WriteJournal()
  journals.add(journal)
  return journal
}

export const closeJournal = (sqlite: SqliteClient, namespace: string, journal: WriteJournal) => {
  const journals = open.get(sqlite)?.get(namespace)
  if (!journals) return
  journals.delete(journal)
  if (journals.size === 0) open.get(sqlite)?.delete(namespace)
}
