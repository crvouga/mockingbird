import type { SqliteClient, SqliteStatement } from "@crvouga/mockingbird-sqlite"
import { openJournals } from "./write-journal.js"

/** Every stored record carries a monotonically increasing sequence for stable ordering. */
export type Stored<T> = { seq: number; value: T }

export type ListRecordsOptions<T> = {
  /** Keep only records passing the predicate. */
  where?: (value: T, seq: number) => boolean
  /** Sort order; default newest first. */
  order?: "newest" | "oldest"
}

type RecordRow = { id: string; seq: number; value: string }

const RECORD_LIMITS = new WeakMap<SqliteClient, number>()

/** A write that would store more records in one namespace than the runtime's `maxRecords`. */
export class RecordLimitError extends RangeError {
  constructor(readonly limit: number) {
    super(
      `this namespace already holds ${limit} records, the most maxRecords allows; reset or delete the namespace to free them`,
    )
    this.name = "RecordLimitError"
  }
}

/** How a request that hit the record cap is answered: `507`, in the admin error shape. */
export const recordLimitResponse = (error: RecordLimitError): Response =>
  new Response(JSON.stringify({ error: { type: "mockingbird_admin", message: error.message } }), {
    status: 507,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/**
 * Cap the records each namespace may hold in `sqlite`, or lift the cap with `undefined`.
 * Inserting a new id past it throws {@link RecordLimitError}; replacing a record never does.
 */
export const setRecordLimit = (sqlite: SqliteClient, limit: number | undefined): void => {
  if (limit === undefined) RECORD_LIMITS.delete(sqlite)
  else RECORD_LIMITS.set(sqlite, limit)
}

/**
 * A SQLite-backed table of JSON records addressed by id. Ordering is by insertion
 * sequence, never by id lexicographic order, so list semantics stay stable.
 */
export class Collection<T> {
  private readonly statements = new Map<string, SqliteStatement>()

  private prepare(sql: string): SqliteStatement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.sqlite.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  constructor(
    private readonly sqlite: SqliteClient,
    /** Storage namespace. Admin introspection uses this to ignore another namespace's tables. */
    readonly namespace: string,
    /** Table name inside the namespace. Stable across resets of the rows themselves. */
    readonly collectionName: string,
  ) {}

  /** Note the record's current row in every open rollback journal that has not seen it yet. */
  private journalRecord(id: string): void {
    const journals = openJournals(this.sqlite, this.namespace)
    if (!journals) return
    const key = `${this.collectionName}\u0000${id}`
    let before: { seq: number; value: string } | null | undefined
    for (const journal of journals) {
      if (journal.records.has(key)) continue
      if (before === undefined) {
        before =
          this.prepare(
            "SELECT seq, value FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
          ).get<{ seq: number; value: string }>(this.namespace, this.collectionName, id) ?? null
      }
      journal.records.set(key, { collection: this.collectionName, id, before })
    }
  }

  private bumpCollectionSeq(): number {
    const row = this.prepare(
      "SELECT value FROM mockingbird_sequences WHERE namespace = ? AND name = ? AND kind = 'collection'",
    ).get<{ value: number }>(this.namespace, this.collectionName)
    const journals = openJournals(this.sqlite, this.namespace)
    if (journals) {
      for (const journal of journals) {
        if (!journal.sequences.has(this.collectionName)) {
          journal.sequences.set(this.collectionName, row?.value ?? null)
        }
      }
    }
    const next = (row?.value ?? 0) + 1
    this.prepare(
      `INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, 'collection', ?)
         ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
    ).run(this.namespace, this.collectionName, next)
    return next
  }

  nextSequence(): number {
    return this.sqlite.transaction(() => this.bumpCollectionSeq())
  }

  get(id: string): T | undefined {
    const row = this.prepare(
      "SELECT value FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
    ).get<{ value: string }>(this.namespace, this.collectionName, id)
    if (!row) return undefined
    return (JSON.parse(row.value) as Stored<T>).value
  }

  has(id: string): boolean {
    const row = this.prepare(
      "SELECT 1 AS ok FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
    ).get<{ ok: number }>(this.namespace, this.collectionName, id)
    return row !== undefined
  }

  private assertRoom(id: string): void {
    const limit = RECORD_LIMITS.get(this.sqlite)
    if (limit === undefined || this.has(id)) return
    const row = this.prepare(
      "SELECT COUNT(*) AS n FROM mockingbird_records WHERE namespace = ?",
    ).get<{ n: number }>(this.namespace)
    if (Number(row?.n ?? 0) >= limit) throw new RecordLimitError(limit)
  }

  /** Insert a new record, assigning it the next sequence number. */
  insert(id: string, value: T): Stored<T> {
    return this.sqlite.transaction(() => {
      this.assertRoom(id)
      this.journalRecord(id)
      const seq = this.bumpCollectionSeq()
      const stored = { seq, value }
      this.prepare(
        `INSERT INTO mockingbird_records (namespace, collection, id, seq, value)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace, collection, id) DO UPDATE SET seq = excluded.seq, value = excluded.value`,
      ).run(this.namespace, this.collectionName, id, seq, JSON.stringify(stored))
      return stored
    })
  }

  /** Replace an existing record's value, keeping its position. */
  update(id: string, value: T): Stored<T> | undefined {
    return this.sqlite.transaction(() => {
      const row = this.prepare(
        "SELECT seq, value FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
      ).get<{ seq: number; value: string }>(this.namespace, this.collectionName, id)
      if (!row) return undefined
      this.journalRecord(id)
      const stored = { seq: row.seq, value }
      this.prepare(
        "UPDATE mockingbird_records SET value = ? WHERE namespace = ? AND collection = ? AND id = ?",
      ).run(JSON.stringify(stored), this.namespace, this.collectionName, id)
      return stored
    })
  }

  delete(id: string): boolean {
    this.journalRecord(id)
    const result = this.prepare(
      "DELETE FROM mockingbird_records WHERE namespace = ? AND collection = ? AND id = ?",
    ).run(this.namespace, this.collectionName, id)
    return result.changes > 0
  }

  /** How many records the collection holds, without reading them. */
  count(): number {
    const row = this.prepare(
      "SELECT COUNT(*) AS n FROM mockingbird_records WHERE namespace = ? AND collection = ?",
    ).get<{ n: number }>(this.namespace, this.collectionName)
    return Number(row?.n ?? 0)
  }

  list(options: ListRecordsOptions<T> = {}): Array<Stored<T> & { id: string }> {
    const rows = this.prepare(
      "SELECT id, seq, value FROM mockingbird_records WHERE namespace = ? AND collection = ?",
    ).all<RecordRow>(this.namespace, this.collectionName)
    const out: Array<Stored<T> & { id: string }> = []
    for (const row of rows) {
      const stored = JSON.parse(row.value) as Stored<T>
      if (options.where && !options.where(stored.value, stored.seq)) continue
      out.push({ id: row.id, seq: stored.seq, value: stored.value })
    }
    out.sort((a, b) => (options.order === "oldest" ? a.seq - b.seq : b.seq - a.seq))
    return out
  }
}
