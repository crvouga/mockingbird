import { SQL } from "bun"
import {
  type Database,
  type Row,
  TABLES,
  type TableName,
  type TableSpec,
  UniqueViolation,
  type Where,
} from "./schema.js"

const SQL_TYPE = {
  text: "text",
  timestamp: "timestamptz",
  json: "jsonb",
  integer: "bigint",
} as const

/** Version 1 of the schema, derived from {@link TABLES}. Later versions are appended by hand. */
function initialSchema(schema: string): string[] {
  const statements: string[] = []
  for (const [name, spec] of Object.entries(TABLES) as [string, TableSpec][]) {
    const columns = Object.entries(spec.columns).map(([column, definition]) =>
      column === "id"
        ? "id text primary key"
        : `${column} ${SQL_TYPE[definition.type]}${definition.nullable ? "" : " not null"}`,
    )
    statements.push(`create table ${schema}.${name} (${columns.join(", ")})`)
    for (const unique of spec.unique ?? [])
      statements.push(
        `create unique index ${name}_${unique.join("_")}_key on ${schema}.${name} (${unique.join(", ")})`,
      )
    for (const index of spec.indexes ?? [])
      statements.push(
        `create index ${name}_${index.join("_")}_idx on ${schema}.${name} (${index.join(", ")})`,
      )
  }
  return statements
}

/**
 * Version 2: organizations can be configured declaratively. `if not exists` because a database
 * created after this column joined {@link TABLES} already has it from version 1.
 */
const declarativeOrgs = (schema: string) => [
  `alter table ${schema}.orgs add column if not exists manifest jsonb not null default 'null'::jsonb`,
]

const MIGRATIONS: readonly ((schema: string) => string[])[] = [initialSchema, declarativeOrgs]

type AnyRow = Record<string, unknown>

/**
 * PostgreSQL through `DATABASE_URL`, passed to the driver unchanged. Everything lives in one
 * schema (default `mockingbird_fleet`), the only part of a shared database this service touches.
 */
export function postgresDatabase(url: string, schema: string): Database {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("invalid schema name")
  const sql = new SQL(url, { max: 5, connectionTimeout: 10, idleTimeout: 60 })

  const columnsOf = (table: TableName) => TABLES[table].columns as Record<string, { type: string }>
  /** Bind a JS value for one column. Unknown columns are rejected, so names are never user input. */
  const bind = (table: TableName, column: string, value: unknown) => {
    const definition = columnsOf(table)[column]
    if (!definition) throw new Error(`unknown column ${table}.${column}`)
    if (definition.type === "json") return { cast: "::jsonb", value: JSON.stringify(value) }
    if (definition.type === "timestamp") return { cast: "::timestamptz", value }
    if (definition.type === "integer") return { cast: "::bigint", value }
    return { cast: "", value }
  }
  const decode = <T extends TableName>(table: T, row: AnyRow): Row<T> => {
    const out: AnyRow = {}
    for (const [column, definition] of Object.entries(columnsOf(table))) {
      const value = row[column]
      if (definition.type === "timestamp")
        out[column] =
          value === null || value === undefined ? null : new Date(value as string).toISOString()
      else if (definition.type === "json")
        out[column] = typeof value === "string" ? JSON.parse(value) : value
      else if (definition.type === "integer") out[column] = Number(value)
      else out[column] = value ?? null
    }
    return out as Row<T>
  }
  const violation = (table: TableName, error: unknown): never => {
    const info = error as { errno?: unknown; code?: unknown; constraint?: unknown }
    if (info?.errno === "23505" || info?.code === "23505") {
      const constraint = typeof info.constraint === "string" ? info.constraint : ""
      const columns = constraint.replace(new RegExp(`^${table}_`), "").replace(/_key$/, "")
      const known = (TABLES[table] as TableSpec).unique?.find((u) => u.join("_") === columns)
      throw new UniqueViolation(table, known ? known.join("+") : "id")
    }
    throw error
  }
  const where = (table: TableName, conditions: AnyRow, offset = 0) => {
    const entries = Object.entries(conditions)
    return {
      text: entries
        .map(
          ([column], index) => `${column} = $${index + 1 + offset}${bind(table, column, "").cast}`,
        )
        .join(" and "),
      values: entries.map(([column, value]) => bind(table, column, value).value),
    }
  }

  return {
    async migrate() {
      // A schema allocated by the platform already exists; creating it is for self-hosted databases.
      const [present] = await sql.unsafe(
        "select 1 as ok from information_schema.schemata where schema_name = $1",
        [schema],
      )
      if (!present) await sql.unsafe(`create schema if not exists ${schema}`)
      await sql.begin(async (tx) => {
        // One replica migrates at a time; the others wait here, then find nothing left to do.
        await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [`${schema}:migrate`])
        await tx.unsafe(
          `create table if not exists ${schema}.schema_migrations (version integer primary key, applied_at timestamptz not null default now())`,
        )
        const applied = new Set(
          (await tx.unsafe(`select version from ${schema}.schema_migrations`)).map((row: AnyRow) =>
            Number(row.version),
          ),
        )
        for (const [index, migration] of MIGRATIONS.entries()) {
          if (applied.has(index + 1)) continue
          for (const statement of migration(schema)) await tx.unsafe(statement)
          await tx.unsafe(`insert into ${schema}.schema_migrations (version) values ($1)`, [
            index + 1,
          ])
        }
      })
    },
    async insert(table, row) {
      const entries = Object.entries(row as AnyRow)
      const bound = entries.map(([column, value]) => bind(table, column, value))
      try {
        await sql.unsafe(
          `insert into ${schema}.${table} (${entries.map(([column]) => column).join(", ")}) values (${bound.map((b, i) => `$${i + 1}${b.cast}`).join(", ")})`,
          bound.map((b) => b.value),
        )
      } catch (error) {
        violation(table, error)
      }
    },
    async get(table, id) {
      const [row] = await sql.unsafe(`select * from ${schema}.${table} where id = $1`, [id])
      return row ? decode(table, row as AnyRow) : undefined
    },
    async find<T extends TableName>(table: T, conditions: Where<T>) {
      const clause = where(table, conditions as AnyRow)
      const order = "created_at" in columnsOf(table) ? "created_at, id" : "id"
      const rows = await sql.unsafe(
        `select * from ${schema}.${table}${clause.text ? ` where ${clause.text}` : ""} order by ${order}`,
        clause.values,
      )
      return rows.map((row: AnyRow) => decode(table, row))
    },
    async update<T extends TableName>(
      table: T,
      id: string,
      patch: Partial<Row<T>>,
      ifMatch?: Where<T>,
    ) {
      const entries = Object.entries(patch as AnyRow).filter(([column]) => column !== "id")
      if (entries.length === 0) return this.get(table, id)
      const bound = entries.map(([column, value]) => bind(table, column, value))
      const guard = where(table, (ifMatch ?? {}) as AnyRow, entries.length + 1)
      try {
        const [row] = await sql.unsafe(
          `update ${schema}.${table} set ${entries.map(([column], i) => `${column} = $${i + 2}${bound[i]?.cast ?? ""}`).join(", ")} where id = $1${guard.text ? ` and ${guard.text}` : ""} returning *`,
          [id, ...bound.map((b) => b.value), ...guard.values],
        )
        return row ? decode(table, row as AnyRow) : undefined
      } catch (error) {
        return violation(table, error)
      }
    },
    async increment(table, row, column, by) {
      const entries = Object.entries({ ...(row as AnyRow), [column as string]: by })
      const bound = entries.map(([name, value]) => bind(table, name, value))
      await sql.unsafe(
        `insert into ${schema}.${table} (${entries.map(([name]) => name).join(", ")}) values (${bound.map((b, i) => `$${i + 1}${b.cast}`).join(", ")}) on conflict (id) do update set ${column as string} = ${schema}.${table}.${column as string} + excluded.${column as string}`,
        bound.map((b) => b.value),
      )
    },
    async remove(table, conditions) {
      const clause = where(table, conditions as AnyRow)
      if (!clause.text) throw new Error("refusing to delete every row")
      const rows = await sql.unsafe(
        `delete from ${schema}.${table} where ${clause.text} returning id`,
        clause.values,
      )
      return rows.length
    },
    async removeExpired(table, column, before) {
      bind(table, column as string, before)
      const rows = await sql.unsafe(
        `delete from ${schema}.${table} where ${column as string} < $1::timestamptz returning id`,
        [before],
      )
      return rows.length
    },
    async ping() {
      await sql.unsafe("select 1")
    },
    async close() {
      await sql.close({ timeout: 5 })
    },
  }
}
