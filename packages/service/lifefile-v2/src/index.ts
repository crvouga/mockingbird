import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  jsonRes,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId, supportedOperationIds } from "./generated/openapi.js"
import { LifeFileState } from "./state.js"
import type { ApiUser, OrderRecord, Settings, StatusChange, TrackingRecord } from "./types.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { CatalogData } from "./corpus.js"
export {
  CATALOG_DATA,
  CATALOGS,
  CORPUS_VERSION,
  DEFAULT_CLIENT,
  DEFAULT_SETTINGS,
  PRODUCTION_STATUSES,
  RECORDED_LATENCY_MS,
  SANDBOX_STATUSES,
} from "./corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  LifeFileV2Runtime,
  LifeFileV2RuntimeOptions,
} from "./runtime.js"
export { createRuntime, LIFEFILE_V2_PRESETS } from "./runtime.js"
export { LifeFileState } from "./state.js"
export type * from "./types.js"
export type { PushBody } from "./webhooks.js"
export {
  basicPushSigner,
  PROVISIONAL_PUSH_SHAPE,
  PUSH_EVENT,
  PUSH_RETRY_DELAYS_MS,
  PUSH_SHAPE_HEADER,
  pushBody,
} from "./webhooks.js"

export const LIFEFILE_V2_NAMESPACE = "lifefile-v2"

export type LifeFileV2APIOptions = APIOptions & {
  settings?: Partial<Settings>
  apiUsers?: readonly Partial<ApiUser>[]
  onStatusChange?: (change: StatusChange) => void
}

export const tokenCredential = (_request: Request): string | undefined => undefined

const notImplemented = () =>
  jsonRes(501, { type: "error", message: "Not implemented", data: null })

export class LifeFileV2API implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: LifeFileState
  private readonly service: Service

  constructor(options: LifeFileV2APIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? LIFEFILE_V2_NAMESPACE
    const now = options.now ?? (() => Date.now())
    this.state = new LifeFileState(
      sqlite,
      namespace,
      { settings: options.settings ?? {}, apiUsers: options.apiUsers ?? [] },
      now,
    )
    const handlers = Object.fromEntries(
      supportedOperationIds.map((id) => [id, notImplemented]),
    ) as Record<SupportedOperationId, typeof notImplemented>
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>(handlers),
      sqlite,
      namespace,
      now,
      notFound: () => jsonRes(404, { type: "error", message: "Not Found", data: null }),
      onError: (error) => {
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  orders(): OrderRecord[] {
    return []
  }

  setStatus(_orderId: number, _status: string): StatusChange | string {
    return "not implemented"
  }

  emitPush(_orderId: number, _tracking: TrackingRecord | null): OrderRecord | string {
    return "not implemented"
  }

  revokeTokens(): number {
    return 0
  }

  expireSecret(_clientId: string): ApiUser | undefined {
    return undefined
  }

  runDue(): void {}
}
