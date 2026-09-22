import { Collection, withNamespaceRollback } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Resource } from "@medplum/fhirtypes"

/** The id of the system "project" server-owned resources live in (`systemResourceProjectId`). */
export const SYSTEM_PROJECT_ID = "65897e4f-7add-55f3-9b17-035b5a4e6d52"

/**
 * One row of a resource type's main table, as the self-hosted server keeps it: the current
 * version's full content (with the `meta.author`, `meta.project` and `meta.compartment` it
 * hides from ordinary reads), or an empty tombstone once deleted.
 */
export type ResourceRow = {
  resourceType: string
  id: string
  deleted: boolean
  lastUpdated: string
  projectId: string
  content?: Resource
}

/** One row of `<ResourceType>_History`: a version, or the tombstone a delete appends. */
export type HistoryRow = {
  id: string
  versionId: string
  lastUpdated: string
  content: Resource
}

/**
 * The mock's FHIR storage for one namespace, on the shared Mockingbird SQLite tables so the
 * runtime's reset, snapshot and restore cover it. Each resource type gets its own collection
 * (like the server's per-type tables); writes move a row to the end of its type's scan order,
 * which is how Postgres's heap order behaves for a searched table without `_sort`.
 */
export class FhirStore {
  private readonly current = new Map<string, Collection<ResourceRow>>()
  private readonly histories = new Map<string, Collection<HistoryRow>>()

  constructor(
    readonly sqlite: SqliteClient,
    readonly namespace: string,
  ) {}

  private table(resourceType: string): Collection<ResourceRow> {
    let table = this.current.get(resourceType)
    if (!table) {
      table = new Collection<ResourceRow>(this.sqlite, this.namespace, `fhir:${resourceType}`)
      this.current.set(resourceType, table)
    }
    return table
  }

  private historyTable(resourceType: string): Collection<HistoryRow> {
    let table = this.histories.get(resourceType)
    if (!table) {
      table = new Collection<HistoryRow>(
        this.sqlite,
        this.namespace,
        `fhir-history:${resourceType}`,
      )
      this.histories.set(resourceType, table)
    }
    return table
  }

  get(resourceType: string, id: string): ResourceRow | undefined {
    return this.table(resourceType).get(id)
  }

  /** Write the current row and append its version to history, atomically. */
  write(row: ResourceRow, version: HistoryRow): void {
    this.sqlite.transaction(() => {
      this.table(row.resourceType).insert(row.id, row)
      this.historyTable(row.resourceType).insert(`${version.id}/${version.versionId}`, version)
    })
  }

  /** Every row of a type (deleted ones included), in scan order. */
  rows(resourceType: string): ResourceRow[] {
    return this.table(resourceType)
      .list({ order: "oldest" })
      .map((entry) => entry.value)
  }

  /** A resource's versions, newest first (`ORDER BY "lastUpdated" DESC`). */
  history(resourceType: string, id: string): HistoryRow[] {
    return this.historyTable(resourceType)
      .list({ where: (row) => row.id === id, order: "newest" })
      .sort((a, b) =>
        a.value.lastUpdated < b.value.lastUpdated
          ? 1
          : a.value.lastUpdated > b.value.lastUpdated
            ? -1
            : b.seq - a.seq,
      )
      .map((entry) => entry.value)
  }

  version(resourceType: string, id: string, versionId: string): HistoryRow | undefined {
    return this.historyTable(resourceType).get(`${id}/${versionId}`)
  }

  /** Remove a resource and its whole history (`$expunge`). */
  expunge(resourceType: string, id: string): void {
    this.sqlite.transaction(() => {
      this.table(resourceType).delete(id)
      const history = this.historyTable(resourceType)
      for (const entry of history.list({ where: (row) => row.id === id })) history.delete(entry.id)
    })
  }

  /** Every resource type that has ever been written in this namespace. */
  resourceTypes(): string[] {
    const rows = this.sqlite
      .prepare(
        "SELECT DISTINCT collection FROM mockingbird_records WHERE namespace = ? AND collection LIKE 'fhir:%'",
      )
      .all<{ collection: string }>(this.namespace)
    return rows.map((row) => row.collection.slice("fhir:".length)).sort()
  }

  /**
   * Run `fn` all-or-nothing: on a throw every write it made is rolled back. Used for FHIR
   * transaction bundles and conditional writes, which the server runs in a SQL transaction.
   */
  async atomically<T>(fn: () => Promise<T>): Promise<T> {
    return withNamespaceRollback(this.sqlite, this.namespace, fn)
  }
}
