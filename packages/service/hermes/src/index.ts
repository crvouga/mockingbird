import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  forwardRequestContext,
  jsonRes,
  markMutationAccepted,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { HermesIdempotency, strip } from "./idempotency.js"
import { HermesError, HermesRuns, unsupported } from "./runs.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { RunRecord, RunStatus, RunUsage } from "./runs.js"
export type { HermesRuntime, HermesRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export const HERMES_NAMESPACE = "hermes"
export type HermesAPIOptions = APIOptions

export class HermesAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly runs: HermesRuns
  readonly idempotency: HermesIdempotency
  private readonly service: Service
  constructor(options: HermesAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? HERMES_NAMESPACE
    this.runs = new HermesRuns(this.sqlite, this.namespace, options.now ?? Date.now)
    this.idempotency = new HermesIdempotency(
      this.sqlite,
      this.namespace,
      this.runs,
      options.now ?? Date.now,
    )
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({
        RunCreate: async ({ body, request }) => {
          const memoryKey = strip(request.headers.get("X-Hermes-Session-Key") ?? "")
          if (memoryKey.length > 256 || /[\r\n\0]/.test(memoryKey))
            return unsupported("invalid memory-scope headers are outside the current subset")
          const key = strip(request.headers.get("Idempotency-Key") ?? "")
          if (body.kind !== "text") throw new HermesError(400, "Invalid JSON")
          const { run, replayed } = await this.idempotency.submit(body.value, key, memoryKey)
          if (!replayed) {
            markMutationAccepted(request, { ids: { runId: run.run_id } })
            if (faultEffect(request, "hermes.accepted_drop")) throw new DroppedConnectionError()
          }
          const response = jsonRes(202, {
            run_id: run.run_id,
            status: replayed ? run.status : "started",
            replayed,
          })
          if (replayed) response.headers.set("Idempotency-Replayed", "true")
          if (memoryKey) response.headers.set("X-Hermes-Session-Key", memoryKey)
          return annotateResponse(response, { ids: { runId: run.run_id } })
        },
        RunStop: async ({ params, request }) => {
          const result = await this.idempotency.stop(params.run_id ?? "")
          if (result.status === "stopping")
            markMutationAccepted(request, { ids: { runId: result.run_id } })
          return jsonRes(200, result)
        },
        RunGet: async ({ params }) => jsonRes(200, await this.idempotency.get(params.run_id ?? "")),
      }),
      notFound: () => jsonRes(404, { message: "page not found" }),
      unsupported: (_request, operation) =>
        jsonRes(501, {
          error: {
            message: `Mockingbird: ${operation.operationId} is not implemented`,
            type: "mockingbird_unsupported",
            param: null,
            code: "operation_not_implemented",
          },
        }),
      onError: (error) => {
        if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
        throw error
      },
    })
    // Keep the Hono entry on the same raw-body-preserving path as Fetch.
    this.app = new Hono().all("*", (c) => this.fetch(c.req.raw))
  }
  fetch(request: Request): Promise<Response> {
    // Preserve raw number lexemes through the shared decoder. The provider
    // parses JSON independently of Content-Type; parsing happens in admission.
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/runs") {
      const headers = new Headers(request.headers)
      headers.set("content-type", "text/plain")
      request = forwardRequestContext(request, new Request(request, { headers }))
    }
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
  }
}
