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
import { JunctionState } from "./state.js"
import { userHandlers } from "./users.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export const JUNCTION_NAMESPACE = "junction"

/**
 * Stateful mock of the Junction (Vital) API user surface.
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
    return this.service.fetch(request)
  }

  reset(): Promise<void> {
    return this.service.reset()
  }
}
