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
import { geneByGeneHandlers } from "./handlers.js"
import { GeneByGeneState } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export const GENEBYGENE_NAMESPACE = "genebygene"

/**
 * Stateful mock of the GeneByGene Nucleus API (token + products + orders).
 *
 * Developer guide: https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf
 * Swagger: https://api.genebygene.com/swagger/index.html
 */
export class GeneByGeneAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service
  private readonly state: GeneByGeneState

  constructor(options: APIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    this.state = new GeneByGeneState(sqlite, GENEBYGENE_NAMESPACE)
    const handlers = defineOperations<SupportedOperationId>({
      ...geneByGeneHandlers(this.state),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace: GENEBYGENE_NAMESPACE,
      now: options.now,
      notFound: () => jsonResponse(404, { message: "Not Found" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeedProducts()
  }
}
