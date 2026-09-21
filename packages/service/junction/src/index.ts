import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  HttpError,
  jsonRes,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type LabAccountInput,
  labAccountFromClientFacing,
  labAccountFromInput,
  TEAM_LAB_ACCOUNTS,
} from "./lab-accounts.js"
import { orderHandlers } from "./orders.js"
import { resultsHandlers } from "./results.js"
import { forceOrderStatus, schedulingHandlers } from "./scheduling.js"
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
  type GeoMode,
  type GetCacheEntry,
  JunctionState,
  type JunctionWebhookEvent,
  type JunctionWebhookOptions,
  type OrderRecord,
  type ResultFixture,
  type StoredLabAccount,
  type WebhookPublisher,
} from "./state.js"
import { userHandlers } from "./users.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { JunctionAdminOptions } from "./admin.js"
export {
  FAULT_PRESETS,
  ORDER_STATUSES_BY_METHOD,
  RESULT_FIXTURES,
  resolveTransition,
  TRANSITION_ALIASES,
} from "./admin.js"
export type { CorpusDiff, PullCorpusOptions, SetDiff } from "./corpus-tools.js"
export {
  DEFAULT_JUNCTION_BASE_URL,
  diffCorpus,
  fingerprintCorpus,
  isSandboxKey,
  pullCorpus,
  SANDBOX_KEY_PREFIXES,
} from "./corpus-tools.js"
export {
  COVERAGE_ZIPS,
  PHLEBOTOMY_AVAILABILITY_ZIPS,
  PSC_AVAILABILITY_ZIPS,
  PSC_LAB_IDS,
} from "./coverage-corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  LabAccountDelegatedFlow,
  LabAccountInput,
  LabAccountRecord,
  LabAccountStatus,
} from "./lab-accounts.js"
export { labAccountFromInput, TEAM_LAB_ACCOUNTS, US_STATES } from "./lab-accounts.js"
export { prefetchCoverageObservations } from "./prefetch.js"
export {
  AVAILABILITY_ADDRESS,
  AVAILABILITY_START_DATE,
  reshapeCoverageGeoCommand,
} from "./reshape.js"
export type { JunctionRuntime, JunctionRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { UNKNOWN_ZIP_ERROR_TYPE, UNKNOWN_ZIP_STATUS } from "./scheduling.js"
export {
  parseSealedCorpus,
  SEALED_CORPUS_VERSION,
  type SealedCorpus,
} from "./sealed-corpus.js"
export type { SeedObservations, SeedReport, SeedSource } from "./seed-from.js"
export type {
  GeoMode,
  GetCacheEntry,
  JunctionWebhookEvent,
  JunctionWebhookOptions,
  OrderRecord,
  ResultFixture,
  StoredLabAccount,
  WebhookPublisher,
} from "./state.js"
export { observationCacheKey } from "./state.js"
export type { Divergence, VerifyOptions, VerifyReport } from "./verify.js"
export { verifyAgainstReal } from "./verify.js"
export type {
  WebhookAttempt,
  WebhookDelivery,
  WebhookDispatcher,
  WebhookEndpoint,
} from "./webhooks.js"
export { createWebhookDispatcher, signSvix, verifySvix } from "./webhooks.js"

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
  /** Install a recorded corpus at construction; it is re-applied on every `reset()`. */
  corpus?: SealedCorpus
  /**
   * How serviceability reads answer a ZIP the corpus does not cover. Default: `corpus`
   * when a corpus is given (refuse, loudly), otherwise `synthetic` (invent coverage).
   */
  geo?: GeoMode
  /**
   * The team's lab accounts, replacing the built-in fixtures (and any from the corpus).
   * `create_order` routes, accepts and rejects `lab_account_id` against these.
   */
  labAccounts?: readonly LabAccountInput[]
}

/** What a loaded corpus covers, for `/health` and startup logs. */
export type CorpusInfo = {
  label: string
  recordedAt: string
  source: string
  observations: number
  labTests: number
  labAccounts: number
  zips: number
}

const observationMaps = new WeakMap<SealedCorpus, ReadonlyMap<string, GetCacheEntry>>()

/** One read-only map per corpus object, shared by every namespace that loads it. */
const observationsOf = (corpus: SealedCorpus): ReadonlyMap<string, GetCacheEntry> => {
  let map = observationMaps.get(corpus)
  if (!map) {
    map = new Map(Object.entries(corpus.observations))
    observationMaps.set(corpus, map)
  }
  return map
}

/** A ZIP appears in a corpus when an area or PSC observation was recorded for it. */
const coveredZipsOf = (corpus: SealedCorpus): Set<string> => {
  const zips = new Set<string>()
  for (const key of Object.keys(corpus.observations)) {
    if (!/ \/v3\/order\/(?:area|psc)\/info\?/.test(key)) continue
    const zip = /[?&]zip_code=(\d{5})/.exec(key)?.[1]
    if (zip) zips.add(zip)
  }
  return zips
}

/** A short, stable name for a corpus: its recording date plus a digest of what it holds. */
export const corpusLabel = (corpus: SealedCorpus): string => {
  const digest =
    corpus.fingerprint ??
    opaqueToken(
      JSON.stringify([
        Object.keys(corpus.observations).sort(),
        corpus.catalog.labTests.map((test) => test.id).sort(),
        corpus.labAccounts.map((account) => account.id).sort(),
      ]),
      12,
    )
  return `v${String(corpus.version)}-${corpus.recordedAt.slice(0, 10)}-${digest.slice(0, 12)}`
}

export class JunctionAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service
  private readonly state: JunctionState
  private corpus: SealedCorpus | undefined
  private labAccountConfig: StoredLabAccount[] | undefined

  constructor(options: JunctionAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? JUNCTION_NAMESPACE
    const state = new JunctionState(sqlite, namespace, options.onWebhook, options.webhook)
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
      namespace,
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
    this.labAccountConfig = options.labAccounts?.map(labAccountFromInput)
    if (options.corpus) this.installCorpus(options.corpus)
    else this.seedLabAccounts()
    state.geoMode = options.geo ?? (options.corpus ? "corpus" : "synthetic")
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
    this.seedLabAccounts()
  }

  /**
   * Install a sealed sandbox recording: seed the observation cache and replace the catalog,
   * labs, and lab accounts with the recording's exact values. Re-applied on `reset()`.
   */
  installCorpus(corpus: SealedCorpus): void {
    this.state.corpusObservations = observationsOf(corpus)
    if (corpus.catalog.labTests.length > 0) {
      this.state.replaceCatalog(corpus.catalog)
    }
    this.corpus = corpus
    this.state.coveredZips = coveredZipsOf(corpus)
    this.state.corpusLabel = corpusLabel(corpus)
    this.seedLabAccounts()
  }

  /**
   * Which lab accounts the ordering rules see, in order of precedence: the configured
   * ones, then a corpus's real accounts, then the built-in fixtures (which a corpus
   * recorded from a team with no accounts leaves in place).
   */
  private seedLabAccounts(): void {
    const recorded = (this.corpus?.labAccounts ?? [])
      .map(labAccountFromClientFacing)
      .filter((entry): entry is StoredLabAccount => entry !== undefined)
    this.state.replaceLabAccounts(
      this.labAccountConfig ?? (recorded.length > 0 ? recorded : [...TEAM_LAB_ACCOUNTS]),
    )
  }

  /** Replace the team's lab accounts; `undefined` restores the default. Kept across resets. */
  configureLabAccounts(accounts: readonly LabAccountInput[] | undefined): StoredLabAccount[] {
    this.labAccountConfig = accounts?.map(labAccountFromInput)
    this.seedLabAccounts()
    return this.state.listLabAccounts()
  }

  labAccounts(): StoredLabAccount[] {
    return this.state.listLabAccounts()
  }

  corpusInfo(): CorpusInfo | undefined {
    const corpus = this.corpus
    if (!corpus) return undefined
    return {
      label: corpusLabel(corpus),
      recordedAt: corpus.recordedAt,
      source: corpus.source,
      observations: Object.keys(corpus.observations).length,
      labTests: corpus.catalog.labTests.length,
      labAccounts: corpus.labAccounts.length,
      zips: this.state.coveredZips.size,
    }
  }

  get geoMode(): GeoMode {
    return this.state.geoMode
  }

  set geoMode(mode: GeoMode) {
    this.state.geoMode = mode
  }

  order(id: string): OrderRecord | undefined {
    return this.state.orders.get(id)
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((entry) => entry.value)
  }

  /**
   * Put an order straight into a status (a full `<status>.<method>.<event>` value) and
   * publish the webhook a real transition would. `flags` takes the same keys as
   * `simulate_order`'s body: `interpretation`, `result_types`, `has_missing_results`.
   */
  transitionOrder(
    id: string,
    status: string,
    options: { now: () => number; flags?: Record<string, unknown> | null },
  ): OrderRecord | undefined {
    const order = this.state.orders.get(id)
    if (!order) return undefined
    forceOrderStatus(this.state, order, status, options.flags ?? null, { now: options.now })
    return this.state.orders.get(id)
  }

  /** Serve `fixture` as this order's results, replacing the generated ones. */
  installResultFixture(orderId: string, fixture: ResultFixture): boolean {
    const order = this.state.orders.get(orderId)
    if (!order) return false
    if (fixture.interpretation !== undefined) {
      order.interpretation = fixture.interpretation
      this.state.orders.update(orderId, order)
    }
    this.state.resultFixtures.insert(orderId, fixture)
    return true
  }

  resultFixture(orderId: string): ResultFixture | undefined {
    return this.state.resultFixtures.get(orderId)
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
