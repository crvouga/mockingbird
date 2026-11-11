import {
  type Database,
  type Row,
  TABLES,
  type TableName,
  type TableSpec,
  UniqueViolation,
  type Where,
} from "./schema.js"

type AnyRow = Record<string, unknown>

/** Process-local database for loopback development and tests. Nothing survives a restart. */
export function memoryDatabase(): Database {
  const tables = new Map<string, Map<string, AnyRow>>()
  const rowsOf = (table: string) => {
    let rows = tables.get(table)
    if (!rows) {
      rows = new Map()
      tables.set(table, rows)
    }
    return rows
  }
  const matches = (row: AnyRow, where: AnyRow) =>
    Object.entries(where).every(([column, value]) => row[column] === value)
  const checkUnique = (table: TableName, candidate: AnyRow, inserting: boolean) => {
    const spec: TableSpec = TABLES[table]
    if (inserting && rowsOf(table).has(candidate.id as string))
      throw new UniqueViolation(table, "id")
    for (const columns of spec.unique ?? [])
      for (const row of rowsOf(table).values())
        if (row.id !== candidate.id && columns.every((column) => row[column] === candidate[column]))
          throw new UniqueViolation(table, columns.join("+"))
  }
  const copy = <T>(row: AnyRow) => structuredClone(row) as T

  return {
    async migrate() {},
    async insert(table, row) {
      const next = structuredClone(row) as AnyRow
      checkUnique(table, next, true)
      rowsOf(table).set(next.id as string, next)
    },
    async get<T extends TableName>(table: T, id: string) {
      const row = rowsOf(table).get(id)
      return row ? copy<Row<T>>(row) : undefined
    },
    async find<T extends TableName>(table: T, where: Where<T>) {
      return [...rowsOf(table).values()]
        .filter((row) => matches(row, where))
        .sort(
          (a, b) =>
            String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
            String(a.id).localeCompare(String(b.id)),
        )
        .map((row) => copy<Row<T>>(row))
    },
    async update<T extends TableName>(
      table: T,
      id: string,
      patch: Partial<Row<T>>,
      ifMatch?: Where<T>,
    ) {
      const current = rowsOf(table).get(id)
      if (!current || (ifMatch && !matches(current, ifMatch))) return undefined
      const next = { ...current, ...(structuredClone(patch) as AnyRow), id }
      checkUnique(table, next, false)
      rowsOf(table).set(id, next)
      return copy<Row<T>>(next)
    },
    async increment(table, row, column, by) {
      const current = rowsOf(table).get((row as AnyRow).id as string)
      if (current) current[column as string] = Number(current[column as string]) + by
      else
        rowsOf(table).set((row as AnyRow).id as string, {
          ...structuredClone(row as AnyRow),
          [column as string]: by,
        })
    },
    async remove(table, where) {
      if (Object.keys(where).length === 0) throw new Error("refusing to delete every row")
      let removed = 0
      for (const [id, row] of rowsOf(table))
        if (matches(row, where)) {
          rowsOf(table).delete(id)
          removed++
        }
      return removed
    },
    async removeExpired(table, column, before) {
      let removed = 0
      for (const [id, row] of rowsOf(table)) {
        const value = row[column as string]
        if (typeof value === "string" && value < before) {
          rowsOf(table).delete(id)
          removed++
        }
      }
      return removed
    },
    async ping() {},
    async close() {},
  }
}
