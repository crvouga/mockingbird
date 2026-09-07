import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  HttpError,
  jsonResponse,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { orderHandlers } from "./orders.js"
import { JunctionState } from "./state.js"
import { userHandlers } from "./users.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export const JUNCTION_NAMESPACE = "junction"

/**
 * Stateful mock of the Junction (Vital) API user and lab-testing surfaces.
 *
 * Docs: https://docs.junction.com/
 * Auth: `x-vital-api-key` — https://docs.junction.com/api-details/junction-api
 */
export class JunctionAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service

  constructor(options: APIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const state = new JunctionState(sqlite, JUNCTION_NAMESPACE)
    const handlers = defineOperations<SupportedOperationId>({
      ...userHandlers(state),
      ...orderHandlers(state),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace: JUNCTION_NAMESPACE,
      now: options.now,
      notFound: () => jsonResponse(404, { detail: "Not Found" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) =>
        context.request.headers.has("x-vital-api-key")
          ? undefined
          : jsonResponse(401, { detail: "Missing x-vital-api-key" }),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(normalizePath(request))
  }

  reset(): Promise<void> {
    return this.service.reset()
  }
}

/** Collapse `.`/`..` path segments the way the real server does before routing. */
const normalizePath = (request: Request): Request => {
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/%2f/gi, "/")
  const segments = pathname.split("/")
  const out: string[] = []
  for (const segment of segments) {
    if (segment === ".") continue
    if (segment === "..") {
      out.pop()
      continue
    }
    out.push(segment)
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop()
  const normalized = out.join("/")
  if (normalized === url.pathname) return request
  const next = new URL(url)
  next.pathname = normalized
  return new Request(next, request)
}
