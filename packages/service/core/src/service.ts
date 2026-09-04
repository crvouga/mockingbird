import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type DecodedBody,
  decodeFormPairs,
  type FormObject,
  readBody,
} from "@crvouga/mockingbird-http-codec"
import { listOperations, type OpenAPIDocument, type Operation } from "@crvouga/mockingbird-openapi"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import {
  clearNamespace,
  migrateCore,
  resolveSqlite,
  type SqliteClient,
} from "@crvouga/mockingbird-sqlite"
import { type Context, Hono } from "hono"

/** Options every provider constructor accepts. */
export type APIOptions = {
  /** Sync SQLite client. Defaults to `@crvouga/sqlite-mem`. */
  sqlite?: SqliteClient
  /** Clock used for `created`-style fields. Default `Date.now`. */
  now?: () => number
}

export type OperationContext = {
  request: Request
  url: URL
  /** Path parameters. */
  params: Record<string, string>
  /** Query string decoded with bracket notation (`created[gte]=1` -> `{ created: { gte: "1" } }`). */
  query: FormObject
  body: DecodedBody
  /** Shared SQLite client for this service (already migrated). */
  sqlite: SqliteClient
  /** Service namespace used for records / sequences. */
  namespace: string
  operation: Operation
  now: () => number
}

export type OperationHandler = (context: OperationContext) => Promise<Response> | Response

export type OperationHandlers = Record<string, OperationHandler>

/** Identity helper that keeps handler maps type-checked against a fixed set of operation ids. */
export const defineOperations = <Id extends string>(
  handlers: Record<Id, OperationHandler>,
): Record<Id, OperationHandler> => handlers

export class OperationRegistryError extends Error {
  constructor(readonly problems: string[]) {
    super(`operation registry is inconsistent:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    this.name = "OperationRegistryError"
  }
}

/**
 * Cross-check handlers against the document: every supported operation needs exactly one
 * handler, no handler may target an unknown or unsupported operation, no duplicate ids.
 */
export const verifyOperations = (
  document: OpenAPIDocument,
  handlers: OperationHandlers,
): string[] => {
  const problems: string[] = []
  const operations = listOperations(document)
  const seen = new Set<string>()
  for (const operation of operations) {
    if (seen.has(operation.operationId))
      problems.push(`duplicate operationId ${operation.operationId}`)
    seen.add(operation.operationId)
    const supported = operationMetadata(operation.operation).supported
    const handler = handlers[operation.operationId]
    if (supported && !handler)
      problems.push(`supported operation ${operation.operationId} has no handler`)
    if (!supported && handler)
      problems.push(`operation ${operation.operationId} is marked unsupported but has a handler`)
  }
  for (const id of Object.keys(handlers)) {
    if (!seen.has(id)) problems.push(`handler ${id} has no OpenAPI operation`)
  }
  return problems
}

export type ServiceOptions = {
  document: OpenAPIDocument
  handlers: OperationHandlers
  sqlite: SqliteClient
  /** Namespace isolating this service's records and sequences. */
  namespace: string
  now?: (() => number) | undefined
  /** Response for paths/methods outside the contract. */
  notFound: (request: Request) => Response | Promise<Response>
  /** Response for operations declared but marked `supported: false`. Default: `notFound`. */
  unsupported?: (request: Request, operation: Operation) => Response | Promise<Response>
  /** Convert handler exceptions into a provider-shaped response. */
  onError: (error: unknown, request: Request) => Response | Promise<Response>
  /** Runs before every operation; return a Response to short-circuit (e.g. authentication). */
  before?: (context: OperationContext) => Promise<Response | undefined> | Response | undefined
}

export type Service = FetchAPI & {
  app: Hono
  sqlite: SqliteClient
  namespace: string
  /** Delete every record and sequence in the service namespace. */
  reset(): Promise<void>
}

const honoPath = (template: string) => template.replace(/\{([^}]+)\}/g, ":$1")

/** Static segments before parameters so `/v1/customers/search` beats `/v1/customers/:id`. */
const routeOrder = (a: Operation, b: Operation) => {
  const sa = a.path.split("/")
  const sb = b.path.split("/")
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? ""
    const y = sb[i] ?? ""
    const px = x.startsWith("{")
    const py = y.startsWith("{")
    if (px !== py) return px ? 1 : -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const queryOf = (url: URL): FormObject => decodeFormPairs(url.searchParams.entries())

/**
 * Resolve optional `sqlite`, run core migrations, and return the ready client.
 * Call this from every provider constructor before building state.
 */
export const bootSqlite = (sqlite?: SqliteClient): SqliteClient => {
  const client = resolveSqlite(sqlite)
  migrateCore(client)
  return client
}

/** Build a Fetch-native service whose routes are exactly the document's operations. */
export const createService = (options: ServiceOptions): Service => {
  const problems = verifyOperations(options.document, options.handlers)
  if (problems.length > 0) throw new OperationRegistryError(problems)
  migrateCore(options.sqlite)
  const now = options.now ?? (() => Date.now())
  const app = new Hono()
  app.notFound((c) => options.notFound(c.req.raw))
  app.onError((error, c) => options.onError(error, c.req.raw))

  const operations = [...listOperations(options.document)].sort(routeOrder)
  for (const operation of operations) {
    const metadata = operationMetadata(operation.operation)
    const handler = options.handlers[operation.operationId]
    const route = async (c: Context) => {
      const request = c.req.raw
      if (!metadata.supported || !handler) {
        return options.unsupported
          ? options.unsupported(request, operation)
          : options.notFound(request)
      }
      const url = new URL(request.url)
      const context: OperationContext = {
        request,
        url,
        params: c.req.param(),
        query: queryOf(url),
        body: await readBody(request),
        sqlite: options.sqlite,
        namespace: options.namespace,
        operation,
        now,
      }
      const short = await options.before?.(context)
      if (short) return short
      return handler(context)
    }
    app.on(operation.method.toUpperCase(), honoPath(operation.path), route)
  }

  return {
    app,
    sqlite: options.sqlite,
    namespace: options.namespace,
    fetch: async (request) => app.fetch(request),
    reset: async () => {
      clearNamespace(options.sqlite, options.namespace)
    },
  }
}
