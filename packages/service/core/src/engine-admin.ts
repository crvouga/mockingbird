import { adminUiRoutes } from "./admin-ui.js"
import { createClock } from "./clock.js"
import {
  type AdminRoutes,
  type ControlPlane,
  createControlPlane,
  resolveAdminPrefix,
} from "./control.js"
import { type CredentialRegistry, createCredentialRegistry, maskCredential } from "./credentials.js"
import { createJournal } from "./journal.js"
import { createMetrics } from "./metrics.js"
import type { StateField, StateFieldKind, StatePage, StateRecord, StateView } from "./state-view.js"
import type { AdminExtension } from "./surface.js"

/** Turns on the built-in table explorer and query runner. */
export const SQL_ADMIN_EXTENSION: AdminExtension = {
  kind: "sql",
  id: "sql",
  title: "SQL",
  description: "Browse tables and run queries.",
}

/**
 * One in-memory SQL database, seen through the shared admin routes.
 * Postgres and SQLite each adapt their `Database` to this shape.
 */
export type SqlColumn = {
  name: string
  type: string
  primaryKey?: boolean
}

export type SqlTable = {
  schema: string
  name: string
  kind: "table" | "view"
  columns: readonly SqlColumn[]
}

export type SqlPage = {
  columns: string[]
  rows: Record<string, unknown>[]
  total: number
}

export type SqlResult = {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated?: boolean
}

export type SqlCheckpoint = {
  id: string
  branch: string
  parent: string | null
  at: number
  records?: number
}

export type SqlEngine = {
  tables(): readonly SqlTable[]
  page(schema: string, table: string, limit: number, offset: number): SqlPage
  query(sql: string, params: readonly unknown[]): SqlResult
  exec(sql: string): { rowCount: number }
  checkpoint(branch: string): SqlCheckpoint
  fork(name: string, at?: string): SqlCheckpoint
  checkout(id: string, branch: string): void
  retain(id: string): void
  release(id: string): boolean
  inspect(): {
    branches: Readonly<Record<string, string>>
    checkpoints: readonly { id: string; branch: string; parent: string | null; at: number }[]
  }
  reset(): void
}

export type EngineAdminOptions = {
  name: string
  adminPrefix?: string
  adminKey?: string
  dialect?: string
  /** Open the database for a namespace. Called once per namespace, including `default`. */
  open(namespace: string): SqlEngine
}

export type EngineAdmin = {
  fetch(request: Request): Promise<Response>
}

const NAMESPACE = /^[A-Za-z0-9_.-]{1,64}$/
const COLLECTION_NAME = /^[A-Za-z0-9_.@:-]{1,200}$/
const READ_SQL = /^(?:select|with|values|show|pragma|explain|table)\b/i
const PAGE_DEFAULT = 50
const PAGE_MAX = 200

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const adminError = (status: number, message: string): Response =>
  json(status, { error: { type: "mockingbird_admin", message } })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Values `Response.json` would reject, turned into JSON text. */
export const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) {
    let binary = ""
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item)
    return out
  }
  return value
}

const kindOf = (value: unknown): StateFieldKind => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "object":
      return "object"
    default:
      return "unknown"
  }
}

const kindFromType = (type: string): StateFieldKind => {
  const text = type.toLowerCase()
  if (/(int|serial|numeric|decimal|real|float|double|number)/.test(text)) return "number"
  if (text.includes("bool")) return "boolean"
  if (text.includes("json")) return "object"
  if (text === "") return "unknown"
  return "string"
}

const countParam = (value: string | null, fallback: number, max: number): number | undefined => {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return undefined
  return Math.min(max, Number(value))
}

const locate = (tables: readonly SqlTable[], collection: string): SqlTable | undefined => {
  const exact = tables.filter((table) => `${table.schema}.${table.name}` === collection)
  if (exact.length === 1) return exact[0]
  if (collection.includes(".")) return undefined
  const byName = tables.filter((table) => table.name === collection)
  return byName.length === 1 ? byName[0] : undefined
}

const fieldsOf = (table: SqlTable, sample: Record<string, unknown> | undefined): StateField[] =>
  table.columns.map((column) => {
    const sampleValue = sample?.[column.name]
    const field: StateField = {
      name: column.name,
      kind:
        sampleValue === undefined || sampleValue === null
          ? kindFromType(column.type)
          : kindOf(sampleValue),
      optional: sampleValue === null || sampleValue === undefined,
    }
    return field
  })

const recordId = (row: Record<string, unknown>, table: SqlTable, seq: number): string => {
  const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name)
  if (keys.length === 0) return String(seq)
  const parts = keys.map((key) => row[key])
  if (parts.every((part) => part === null || part === undefined)) return String(seq)
  return parts.map((part) => String(part)).join("|")
}

const credentialRoutes = (registry: CredentialRegistry): AdminRoutes => ({
  "GET /credentials": () =>
    json(200, {
      credentials: registry.entries().map(({ credential, namespace }) => ({
        credential: maskCredential(credential),
        namespace,
      })),
    }),
  "PUT /credentials": ({ body, namespace }) => {
    const pairs: [string, string][] = []
    const list = Array.isArray(body) ? body : isRecord(body) ? body.credentials : undefined
    if (Array.isArray(list)) {
      for (const each of list) {
        if (typeof each === "string") pairs.push([each, namespace])
        else if (isRecord(each) && typeof each.credential === "string") {
          pairs.push([
            each.credential,
            typeof each.namespace === "string" ? each.namespace : namespace,
          ])
        } else
          return adminError(400, "each entry is a credential string or {credential, namespace}")
      }
    } else if (isRecord(list)) {
      for (const [credential, target] of Object.entries(list)) {
        if (typeof target !== "string")
          return adminError(400, `namespace for ${credential} must be a string`)
        pairs.push([credential, target])
      }
    } else if (isRecord(body) && typeof body.credential === "string") {
      pairs.push([body.credential, typeof body.namespace === "string" ? body.namespace : namespace])
    } else {
      return adminError(400, 'expected {"credentials": {"<credential>": "<namespace>"}}')
    }
    for (const [credential, target] of pairs) {
      if (!NAMESPACE.test(target)) return adminError(400, `bad namespace ${JSON.stringify(target)}`)
      registry.set(credential, target)
    }
    return json(200, { mapped: pairs.length })
  },
  "DELETE /credentials": ({ url }) => {
    const credential = url.searchParams.get("credential")
    if (credential === null) registry.clear()
    else registry.remove(credential)
    return json(200, { status: "ok" })
  },
})

const stateRoutes = (engine: (namespace: string) => SqlEngine): AdminRoutes => {
  const view = (namespace: string): StateView => {
    const tables = engine(namespace).tables()
    return {
      namespace,
      storageNamespace: namespace,
      collections: tables.map((table) => {
        const page = engine(namespace).page(table.schema, table.name, 1, 0)
        const sample = page.rows[0]
        return {
          name: `${table.schema}.${table.name}`,
          label: table.name,
          count: page.total,
          source: "inferred" as const,
          fields: fieldsOf(table, sample),
        }
      }),
    }
  }
  const pageOf = (
    namespace: string,
    collection: string,
    limit: number,
    offset: number,
  ): StatePage | Response => {
    if (!COLLECTION_NAME.test(collection))
      return adminError(400, `bad collection ${JSON.stringify(collection)}`)
    const table = locate(engine(namespace).tables(), collection)
    if (!table) return adminError(404, `no collection ${collection}`)
    const page = engine(namespace).page(table.schema, table.name, limit, offset)
    const records: StateRecord[] = page.rows.map((row, index) => {
      const seq = offset + index + 1
      return { id: recordId(row, table, seq), seq, value: jsonSafe(row) }
    })
    const next = offset + records.length < page.total ? offset + records.length : null
    return { collection, count: page.total, records, next }
  }
  const readOnly = (): Response => adminError(400, "state writes go through POST /sql/query")
  return {
    "GET /state": ({ namespace }) => json(200, view(namespace)),
    "GET /state/:collection": ({ params, url, namespace }) => {
      const limit = countParam(url.searchParams.get("limit"), PAGE_DEFAULT, PAGE_MAX)
      const offset = countParam(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER)
      if (limit === undefined) return adminError(400, "limit: expected a count")
      if (offset === undefined) return adminError(400, "offset: expected a count")
      const page = pageOf(namespace, params.collection ?? "", limit, offset)
      return page instanceof Response ? page : json(200, page)
    },
    "GET /state/:collection/:id": ({ params, namespace }) => {
      const collection = params.collection ?? ""
      const id = params.id ?? ""
      if (!COLLECTION_NAME.test(collection))
        return adminError(400, `bad collection ${JSON.stringify(collection)}`)
      let offset = 0
      for (;;) {
        const page = pageOf(namespace, collection, PAGE_MAX, offset)
        if (page instanceof Response) return page
        const found = page.records.find((record) => record.id === id)
        if (found) return json(200, found)
        if (page.next === null) return adminError(404, `no record ${id}`)
        offset = page.next
      }
    },
    "POST /state/:collection": readOnly,
    "PUT /state/:collection/:id": readOnly,
    "PATCH /state/:collection/:id": readOnly,
    "DELETE /state/:collection/:id": readOnly,
  }
}

const sqlRoutes = (engine: (namespace: string) => SqlEngine): AdminRoutes => ({
  "GET /sql/tables": ({ namespace }) => {
    try {
      return json(200, { tables: jsonSafe(engine(namespace).tables()) })
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "GET /sql/tables/:schema/:table": ({ params, url, namespace }) => {
    const limit = countParam(url.searchParams.get("limit"), PAGE_DEFAULT, PAGE_MAX)
    const offset = countParam(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER)
    if (limit === undefined) return adminError(400, "limit: expected a count")
    if (offset === undefined) return adminError(400, "offset: expected a count")
    try {
      const page = engine(namespace).page(params.schema ?? "", params.table ?? "", limit, offset)
      const safe = jsonSafe(page)
      return json(200, {
        ...(isRecord(safe) ? safe : {}),
        schema: params.schema,
        name: params.table,
        limit,
        offset,
      })
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /sql/query": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.sql !== "string" || body.sql.trim() === "") {
      return adminError(400, 'expected {"sql":"..."}')
    }
    const params = Array.isArray(body.params) ? body.params : []
    const sql = body.sql.trim()
    try {
      const current = engine(namespace)
      const result = READ_SQL.test(sql)
        ? current.query(sql, params)
        : { ...current.exec(sql), columns: [], rows: [] }
      return json(200, jsonSafe(result))
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
})

/** Shared `/__admin/health` and `/__admin` surface for the SQL engines. */
export const createEngineAdmin = (options: EngineAdminOptions): EngineAdmin => {
  const adminPrefix = resolveAdminPrefix(options.adminPrefix)
  const engines = new Map<string, SqlEngine>()
  const engine = (namespace: string): SqlEngine => {
    const existing = engines.get(namespace)
    if (existing) return existing
    const created = options.open(namespace)
    engines.set(namespace, created)
    return created
  }
  engine("default")

  const routes: AdminRoutes = {
    ...credentialRoutes(createCredentialRegistry()),
    ...stateRoutes(engine),
    ...sqlRoutes(engine),
    ...adminUiRoutes(options.name, { extensions: [SQL_ADMIN_EXTENSION] }, adminPrefix),
  }
  const startedAt = Date.now()
  const plane: ControlPlane = createControlPlane({
    name: options.name,
    startedAt,
    wallNow: () => Date.now(),
    clock: createClock(),
    metrics: createMetrics(),
    journal: createJournal(),
    defaultNamespace: "default",
    namespaces: () => [...engines.keys()].sort(),
    reset: async (namespace) => {
      if (namespace === "*") {
        for (const each of engines.values()) each.reset()
        return
      }
      engine(namespace).reset()
    },
    timeTravel: {
      checkpoint: (namespace, branch) => engine(namespace).checkpoint(branch),
      branch: (name, input) =>
        input.at !== undefined
          ? engine(input.namespace).fork(name, input.at)
          : engine(input.namespace).fork(name),
      checkout: (checkpoint, input) => engine(input.namespace).checkout(checkpoint, input.branch),
      retain: (namespace, checkpoint) => engine(namespace).retain(checkpoint),
      release: (namespace, checkpoint) => engine(namespace).release(checkpoint),
      inspect: (namespace) => engine(namespace).inspect(),
    },
    describe: () => (options.dialect === undefined ? {} : { dialect: options.dialect }),
    routes,
    adminPrefix,
    adminKey: options.adminKey,
  })

  return {
    async fetch(request) {
      const response = await plane.handle(request)
      return response ?? adminError(404, "not found")
    },
  }
}
