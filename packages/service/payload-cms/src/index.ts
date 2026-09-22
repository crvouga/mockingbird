import type { FetchAPI } from "@crvouga/mockingbird-core"
import { decodeFormPairs } from "@crvouga/mockingbird-http-codec"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  coerce,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CollectionRecord,
  MARKETING_FIELDS,
  type PayloadDoc,
  PayloadState,
  type Seed,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { CollectionRecord, PayloadDoc, Seed } from "./state.js"
export { DEFAULT_MARKETING_DOCS, MARKETING_FIELDS } from "./state.js"

export const PAYLOAD_CMS_NAMESPACE = "payload-cms"

export type PayloadCmsAPIOptions = APIOptions & {
  /** Collections every namespace starts with. Default: `{marketing: DEFAULT_MARKETING_DOCS}`. */
  collections?: Seed
}

/** Payload's error envelope: `{errors: [{message}]}`. */
export const payloadError = (status: number, message: string) =>
  jsonRes(status, { errors: [{ message }] })

const NOT_FOUND = "The requested resource was not found."

/**
 * The credential a request carries: an API key (`Authorization: <collection> API-Key <key>`)
 * or a bearer JWT. Our backend sends none (the marketing collection is public), so namespaces
 * usually come from the header or the `/ns/<name>` prefix on `PAYLOAD_CMS_API_URL`.
 */
export const payloadCredential = (request: Request): string | undefined => {
  const header = request.headers.get("authorization") ?? ""
  const apiKey = /^\S+\s+API-Key\s+(.+)$/i.exec(header.trim())?.[1]
  return apiKey?.trim() || bearerToken(request)
}

const OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "exists",
  "greater_than",
  "greater_than_equal",
  "less_than",
  "less_than_equal",
  "like",
  "contains",
] as const

type Operator = (typeof OPERATORS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fieldValue = (doc: PayloadDoc, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), doc)

/** Query strings are text; compare in the document field's own type, as Payload casts. */
const cast = (raw: unknown, sample: unknown): unknown => {
  if (typeof raw !== "string") return raw
  if (typeof sample === "boolean") return raw === "true" ? true : raw === "false" ? false : raw
  if (typeof sample === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw)))
    return Number(raw)
  if (raw === "null") return null
  return raw
}

const listOf = (raw: unknown): unknown[] =>
  Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw]

const compare = (a: unknown, b: unknown): number | undefined => {
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0
  return undefined
}

const test = (operator: Operator, actual: unknown, raw: unknown): boolean => {
  const expected = cast(raw, actual)
  switch (operator) {
    case "equals":
      return actual === expected || (actual === undefined && expected === null)
    case "not_equals":
      return actual !== expected
    case "in":
      return listOf(raw).some((item) => cast(item, actual) === actual)
    case "not_in":
      return !listOf(raw).some((item) => cast(item, actual) === actual)
    case "exists": {
      const present = actual !== undefined && actual !== null
      return raw === "false" || raw === false ? !present : present
    }
    case "greater_than":
      return (compare(actual, expected) ?? -1) > 0
    case "greater_than_equal":
      return (compare(actual, expected) ?? -1) >= 0
    case "less_than":
      return (compare(actual, expected) ?? 1) < 0
    case "less_than_equal":
      return (compare(actual, expected) ?? 1) <= 0
    case "contains":
      return (
        typeof actual === "string" &&
        typeof raw === "string" &&
        actual.toLowerCase().includes(raw.toLowerCase())
      )
    case "like":
      return (
        typeof actual === "string" &&
        typeof raw === "string" &&
        raw
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((word) => actual.toLowerCase().includes(word))
      )
  }
}

/** A compiled `where`: a predicate, or the path Payload refuses to query. */
type Compiled = { ok: true; match: (doc: PayloadDoc) => boolean } | { ok: false; message: string }

/**
 * Compile Payload's `where` object (`{field: {operator: value}}`, `and` / `or` lists) against
 * the fields the collection knows.
 */
export const compileWhere = (where: unknown, fields: ReadonlySet<string>): Compiled => {
  if (where === undefined) return { ok: true, match: () => true }
  if (!isRecord(where)) return { ok: false, message: "The where query is malformed." }
  const parts: ((doc: PayloadDoc) => boolean)[] = []
  for (const [key, condition] of Object.entries(where)) {
    if (key === "and" || key === "or") {
      const nested = (
        Array.isArray(condition) ? condition : isRecord(condition) ? Object.values(condition) : []
      ).map((item) => compileWhere(item, fields))
      const failed = nested.find((c) => !c.ok)
      if (failed) return failed
      const matchers = nested.map((c) => (c as { match: (doc: PayloadDoc) => boolean }).match)
      parts.push(
        key === "and"
          ? (doc) => matchers.every((m) => m(doc))
          : (doc) => matchers.length === 0 || matchers.some((m) => m(doc)),
      )
      continue
    }
    const root = key.split(".")[0] as string
    if (!fields.has(root)) {
      return { ok: false, message: `The following path cannot be queried: ${key}` }
    }
    if (!isRecord(condition))
      return { ok: false, message: `The following path cannot be queried: ${key}` }
    for (const [operator, value] of Object.entries(condition)) {
      if (!(OPERATORS as readonly string[]).includes(operator)) {
        return { ok: false, message: `The following path cannot be queried: ${key}.${operator}` }
      }
      parts.push((doc) => test(operator as Operator, fieldValue(doc, key), value))
    }
  }
  return { ok: true, match: (doc) => parts.every((part) => part(doc)) }
}

const fieldsOf = (collection: CollectionRecord): Set<string> => {
  const fields = new Set<string>(
    collection.slug === "marketing" ? MARKETING_FIELDS : ["id", "createdAt", "updatedAt"],
  )
  for (const doc of collection.docs) for (const key of Object.keys(doc)) fields.add(key)
  return fields
}

const sortDocs = (docs: PayloadDoc[], sort: string): PayloadDoc[] => {
  const descending = sort.startsWith("-")
  const field = descending ? sort.slice(1) : sort
  return [...docs].sort((a, b) => {
    const order = compare(fieldValue(a, field), fieldValue(b, field)) ?? 0
    return (descending ? -order : order) || b.id - a.id
  })
}

/**
 * Stateful mock of Payload CMS's collection REST API.
 *
 * Collections hold documents seeded per namespace (the marketing collection by default) and
 * changed through the admin plane; reads answer Payload's paginated envelope.
 */
export class PayloadCmsAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PayloadState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: PayloadCmsAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PAYLOAD_CMS_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new PayloadState(sqlite, namespace, options.collections ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      FindDocuments: (context) => this.find(context),
      FindDocumentById: (context) => {
        const collection = this.state.get(context.params.collection ?? "")
        const doc = collection?.docs.find((d) => String(d.id) === context.params.id)
        if (!doc) return payloadError(404, NOT_FOUND)
        return annotateResponse(jsonRes(200, doc), { ids: { docId: String(doc.id) } })
      },
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => payloadError(404, NOT_FOUND),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    // Payload serves every collection slug under /api/<slug>; the contract declares only the
    // ones our consumer reads, so other seeded slugs are routed here too.
    const url = new URL(request.url)
    const match = /^\/api\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url.pathname)
    if (
      request.method === "GET" &&
      match &&
      match[1] !== "marketing" &&
      this.state.get(match[1] as string)
    ) {
      return Promise.resolve(this.generic(url, match[1] as string, match[2]))
    }
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private generic(url: URL, slug: string, id: string | undefined): Response {
    const collection = this.state.get(slug) as CollectionRecord
    if (id === undefined) {
      return this.page(collection, decodeFormPairs(url.searchParams.entries()))
    }
    const doc = collection.docs.find((d) => String(d.id) === id)
    return doc ? jsonRes(200, doc) : payloadError(404, NOT_FOUND)
  }

  private find(context: OperationContext): Response {
    const collection = this.state.get(context.params.collection ?? "")
    if (!collection) return payloadError(404, NOT_FOUND)
    return this.page(collection, context.query as Record<string, unknown>, context.request)
  }

  private page(
    collection: CollectionRecord,
    query: Record<string, unknown>,
    request?: Request,
  ): Response {
    const limitResult = query.limit === undefined ? undefined : coerce.integer(query.limit)
    const pageResult = query.page === undefined ? undefined : coerce.integer(query.page)
    const limit = limitResult?.ok ? Math.max(0, limitResult.value) : 10
    const page = pageResult?.ok ? Math.max(1, pageResult.value) : 1
    const compiled = compileWhere(query.where, fieldsOf(collection))
    if (!compiled.ok) return payloadError(400, compiled.message)
    const sort = typeof query.sort === "string" && query.sort.length > 0 ? query.sort : "-createdAt"
    const empty = request !== undefined && faultEffect(request, "no_active_docs") !== undefined
    const matching = empty ? [] : sortDocs(collection.docs.filter(compiled.match), sort)
    const totalDocs = matching.length
    // limit=0 turns pagination off: every match on one page.
    const size = limit === 0 ? Math.max(totalDocs, 1) : limit
    const totalPages = Math.max(1, Math.ceil(totalDocs / size))
    const docs = matching.slice((page - 1) * size, page * size)
    return annotateResponse(
      jsonRes(200, {
        docs,
        totalDocs,
        limit,
        totalPages,
        page,
        pagingCounter: (page - 1) * size + 1,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages,
        prevPage: page > 1 ? page - 1 : null,
        nextPage: page < totalPages ? page + 1 : null,
      }),
      { ids: Object.fromEntries(docs.slice(0, 5).map((doc, i) => [`doc${i}`, String(doc.id)])) },
    )
  }

  /** Add a document the way Payload's create would: next integer id, timestamps from the mock clock. */
  addDoc(slug: string, fields: Record<string, unknown>): PayloadDoc {
    const collection = this.state.get(slug) ?? { slug, docs: [], nextId: 1 }
    const now = new Date(this.now()).toISOString()
    const id = typeof fields.id === "number" ? fields.id : collection.nextId
    const doc: PayloadDoc = { createdAt: now, updatedAt: now, ...fields, id }
    collection.docs = [...collection.docs.filter((d) => d.id !== id), doc]
    collection.nextId = Math.max(collection.nextId, id + 1)
    this.state.save(collection)
    return doc
  }

  updateDoc(slug: string, id: number, patch: Record<string, unknown>): PayloadDoc | undefined {
    const collection = this.state.get(slug)
    const existing = collection?.docs.find((d) => d.id === id)
    if (!collection || !existing) return undefined
    const doc: PayloadDoc = {
      ...existing,
      ...patch,
      id,
      updatedAt: new Date(this.now()).toISOString(),
    }
    collection.docs = collection.docs.map((d) => (d.id === id ? doc : d))
    this.state.save(collection)
    return doc
  }

  deleteDoc(slug: string, id: number): boolean {
    const collection = this.state.get(slug)
    if (!collection?.docs.some((d) => d.id === id)) return false
    collection.docs = collection.docs.filter((d) => d.id !== id)
    this.state.save(collection)
    return true
  }

  collections(): Record<string, number> {
    return Object.fromEntries(
      this.state.collections
        .list({ order: "oldest" })
        .map((row) => [row.value.slug, row.value.docs.length]),
    )
  }
}

export type { PayloadCmsRuntime, PayloadCmsRuntimeOptions } from "./runtime.js"
export { createRuntime, PAYLOAD_CMS_PRESETS } from "./runtime.js"
