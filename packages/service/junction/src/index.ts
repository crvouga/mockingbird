import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  HttpError,
  jsonRes,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { orderHandlers } from "./orders.js"
import { resultsHandlers } from "./results.js"
import { schedulingHandlers } from "./scheduling.js"
import type { SealedCorpus } from "./sealed-corpus.js"
import {
  ensureLabTests as ensureLabTestsFrom,
  ensureOrders as ensureOrdersFrom,
  type SeedObservations,
  type SeedReport,
  type SeedSource,
  seedFrom as seedStateFrom,
} from "./seed-from.js"
import {
  JunctionState,
  type JunctionWebhookEvent,
  type JunctionWebhookOptions,
  type WebhookPublisher,
} from "./state.js"
import { userHandlers } from "./users.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export {
  COVERAGE_ZIPS,
  PHLEBOTOMY_AVAILABILITY_ZIPS,
  PSC_AVAILABILITY_ZIPS,
  PSC_LAB_IDS,
} from "./coverage-corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { prefetchCoverageObservations } from "./prefetch.js"
export {
  AVAILABILITY_ADDRESS,
  AVAILABILITY_START_DATE,
  reshapeCoverageGeoCommand,
} from "./reshape.js"
export {
  parseSealedCorpus,
  SEALED_CORPUS_VERSION,
  type SealedCorpus,
} from "./sealed-corpus.js"
export type { SeedObservations, SeedReport, SeedSource } from "./seed-from.js"
export type {
  GetCacheEntry,
  JunctionWebhookEvent,
  JunctionWebhookOptions,
  WebhookPublisher,
} from "./state.js"
export { observationCacheKey } from "./state.js"

export const JUNCTION_NAMESPACE = "junction"

/**
 * Stateful mock of the Junction (Vital) API user and lab-testing surfaces.
 *
 * Docs: https://docs.junction.com/
 * Auth: `x-vital-api-key` — https://docs.junction.com/api-details/junction-api
 */
export type JunctionAPIOptions = APIOptions & {
  onWebhook?: WebhookPublisher
  webhook?: JunctionWebhookOptions
}

export class JunctionAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service
  private readonly state: JunctionState
  private corpus: SealedCorpus | undefined

  constructor(options: JunctionAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const state = new JunctionState(sqlite, JUNCTION_NAMESPACE, options.onWebhook, options.webhook)
    this.state = state
    const handlers = defineOperations<SupportedOperationId>({
      ...userHandlers(state),
      ...orderHandlers(state),
      ...schedulingHandlers(state),
      ...resultsHandlers(state),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace: JUNCTION_NAMESPACE,
      now: options.now,
      notFound: () => jsonRes(404, { detail: "Not Found" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) =>
        context.request.headers.has("x-vital-api-key")
          ? undefined
          : jsonRes(401, { detail: "Missing x-vital-api-key" }),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(normalizePath(request))
  }

  async reset(): Promise<void> {
    await this.service.reset()
    if (this.corpus) {
      this.installCorpus(this.corpus)
      return
    }
    this.state.seedDefaultCatalog()
  }

  /**
   * Install a sealed sandbox recording: seed the observation cache and replace the catalog,
   * labs, and lab accounts with the recording's exact values. Re-applied on `reset()`.
   */
  installCorpus(corpus: SealedCorpus): void {
    this.state.installGetCache(Object.entries(corpus.observations))
    if (corpus.catalog.labTests.length > 0) {
      this.state.replaceCatalog(corpus.catalog)
    }
    this.state.replaceLabAccounts(corpus.labAccounts)
    this.corpus = corpus
  }

  seedFrom(source: SeedSource, observations?: SeedObservations): Promise<SeedReport> {
    return seedStateFrom(this.state, source, observations)
  }

  ensureLabTests(source: SeedSource, ids: readonly string[]): Promise<number> {
    return ensureLabTestsFrom(this.state, source, ids)
  }

  ensureOrders(source: SeedSource, ids: readonly string[]): Promise<number> {
    return ensureOrdersFrom(this.state, source, ids)
  }

  markUserDeleted(userId: string): void {
    this.state.users.delete(userId)
    this.state.deletedUsers.insert(userId, { user_id: userId })
  }

  webhookEvents(): JunctionWebhookEvent[] {
    return this.state.webhookEventsInOrder()
  }

  webhookDeliveryAttempts() {
    return this.state.webhookDeliveryAttemptsInOrder()
  }
}

/** Collapse `.`/`..` path segments the way the real server does before routing. */
const normalizePath = (request: Request): Request => {
  if (!request.url.includes("/./") && !request.url.includes("/../") && !/%2f/i.test(request.url)) {
    return request
  }
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
