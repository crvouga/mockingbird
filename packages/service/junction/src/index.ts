import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
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
import {
  fixtureErrorMessage,
  hardDeleteUser,
  IDENTITY_MODES,
  type IdentityMode,
  type InsertOptions,
  importFixtures,
  insertOrders,
  insertUsers,
  type JunctionFixtures,
  type OrderFixture,
  type UserFixture,
} from "./fixtures.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  expandLabAccountLayout,
  type LabAccountLayout,
  labAccountFromPreset,
} from "./lab-account-presets.js"
import {
  type LabAccountInput,
  labAccountFromClientFacing,
  labAccountFromInput,
  patchLabAccount as patchLabAccountRecord,
  TEAM_LAB_ACCOUNTS,
} from "./lab-accounts.js"
import {
  DEFAULT_LIMITS,
  type JunctionLimits,
  type JunctionLimitsInput,
  mergeLimits,
  RateWindow,
} from "./limits.js"
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
  MOCK_TEAM_ID,
  type OrderRecord,
  type ResultFixture,
  type StoredLabAccount,
  type UserRecord,
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
export type {
  IdentityMode,
  InsertOptions,
  JunctionFixtures,
  OrderFixture,
  UserFixture,
} from "./fixtures.js"
export { FixtureError, IDENTITY_MODES } from "./fixtures.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { LabAccountLayout } from "./lab-account-presets.js"
export {
  DELEGATED_ACCOUNT_STATES,
  LAB_ACCOUNT_PRESETS,
  PLATFORM_ACCOUNT_STATES,
  presetAccountId,
} from "./lab-account-presets.js"
export type {
  LabAccountDelegatedFlow,
  LabAccountInput,
  LabAccountRecord,
  LabAccountStatus,
} from "./lab-accounts.js"
export {
  isLinkedToTeam,
  labAccountFromInput,
  OTHER_TEAM_ID,
  TEAM_LAB_ACCOUNTS,
  US_STATES,
} from "./lab-accounts.js"
export type { JunctionLimits, JunctionLimitsInput } from "./limits.js"
export { DEFAULT_LIMITS, sandboxUserQuotaBody } from "./limits.js"
export { KNOWN_HEADER, MISS_HEADER, ORDER_NOT_FOUND } from "./not-found.js"
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
  SUPPORTED_SEALED_CORPUS_VERSIONS,
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
  UserRecord,
  WebhookPublisher,
} from "./state.js"
export { MOCK_TEAM_ID, observationCacheKey } from "./state.js"
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
   * The team's lab accounts, replacing the built-in fixtures (and any from the corpus):
   * a list of accounts, or `{ presets: [...], accounts: [...] }`. `create_order` routes,
   * accepts and rejects `lab_account_id` against these.
   */
  labAccounts?: LabAccountLayout
  /**
   * The team the mock answers as: `team_id` on users and orders, and the team lab-account
   * allowlists are checked against. Default: the corpus's recorded team, else a fixed id.
   */
  teamId?: string
  /** Sandbox-only restrictions to enforce. Every one is off unless set here. */
  limits?: JunctionLimitsInput
  /** `adopt-users` creates an unknown (well-formed) `user_id` on first use. Default `strict`. */
  identity?: IdentityMode
  /** Users and orders to load into every namespace, re-applied on every `reset()`. */
  fixtures?: JunctionFixtures
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
  /** The recording team, when the corpus recorded one (version 2+). */
  teamId?: string
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
  private readonly now: () => number
  private readonly explicitTeamId: string | undefined
  private readonly fixtures: JunctionFixtures | undefined
  private readonly rateWindow = new RateWindow()
  private corpus: SealedCorpus | undefined
  private labAccountConfig: StoredLabAccount[] | undefined

  constructor(options: JunctionAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? JUNCTION_NAMESPACE
    const state = new JunctionState(sqlite, namespace, options.onWebhook, options.webhook)
    this.state = state
    this.now = options.now ?? (() => Date.now())
    this.explicitTeamId = options.teamId
    state.teamId = options.teamId ?? options.corpus?.teamId ?? MOCK_TEAM_ID
    state.limits = mergeLimits(DEFAULT_LIMITS, options.limits ?? {})
    if (options.identity !== undefined && !IDENTITY_MODES.includes(options.identity))
      throw new TypeError(`identity must be one of ${IDENTITY_MODES.join(", ")}`)
    state.identity = options.identity ?? "strict"
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
    this.labAccountConfig = options.labAccounts
      ? expandLabAccountLayout(options.labAccounts, state.teamId)
      : undefined
    if (options.corpus) this.installCorpus(options.corpus)
    else this.seedLabAccounts()
    state.geoMode = options.geo ?? (options.corpus ? "corpus" : "synthetic")
    this.fixtures = options.fixtures
    if (this.fixtures) importFixturesInto(state, this.fixtures, this.now)
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.rateWindow.take(this.state.limits.rateLimitPerSecond)) {
      return jsonRes(429, { detail: "Too Many Requests" }, { "retry-after": "1" })
    }
    const normalized = normalizePath(request)
    const sent = requestJson(normalized)
    const response = await this.service.fetch(normalized)
    const ids = await touchedIds(normalized, await sent, response)
    return annotateResponse(response, {
      ...(Object.keys(ids).length > 0 ? { ids } : {}),
      ...(this.state.adopted(normalized) ? { adopted: true } : {}),
    })
  }

  async reset(): Promise<void> {
    await this.service.reset()
    if (this.corpus) this.installCorpus(this.corpus)
    else {
      this.state.seedDefaultCatalog()
      this.seedLabAccounts()
    }
    if (this.fixtures) importFixturesInto(this.state, this.fixtures, this.now)
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
    this.state.teamId = this.explicitTeamId ?? corpus.teamId ?? MOCK_TEAM_ID
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
      .map((entry) => labAccountFromClientFacing(entry, this.corpus?.teamId))
      .filter((entry): entry is StoredLabAccount => entry !== undefined)
    this.state.replaceLabAccounts(
      this.labAccountConfig ?? (recorded.length > 0 ? recorded : [...TEAM_LAB_ACCOUNTS]),
    )
  }

  /** The team this namespace answers as. */
  get teamId(): string {
    return this.state.teamId
  }

  /**
   * Replace the team's lab accounts (a list, or `{ presets, accounts }`); `undefined`
   * restores the default. Kept across `reset()`, per namespace.
   */
  configureLabAccounts(accounts: LabAccountLayout | undefined): StoredLabAccount[] {
    this.labAccountConfig = accounts
      ? expandLabAccountLayout(accounts, this.state.teamId)
      : undefined
    this.seedLabAccounts()
    return this.state.listLabAccounts()
  }

  labAccounts(): StoredLabAccount[] {
    return this.state.listLabAccounts()
  }

  /** Apply one change to the effective account list and keep it as this namespace's config. */
  private editLabAccounts(edit: (accounts: StoredLabAccount[]) => StoredLabAccount[]): void {
    this.labAccountConfig = edit([...(this.labAccountConfig ?? this.state.listLabAccounts())])
    this.seedLabAccounts()
  }

  /** Add one account. Throws `LabAccountConflict` when the id is taken. Kept across resets. */
  addLabAccount(input: LabAccountInput | StoredLabAccount): StoredLabAccount {
    const record = labAccountFromInput(input as LabAccountInput, this.state.teamId)
    if (this.state.labAccounts.has(record.id)) throw new LabAccountConflict(record.id)
    this.editLabAccounts((accounts) => [...accounts, record])
    return record
  }

  /** Add a named preset (see `LAB_ACCOUNT_PRESETS`); `undefined` for an unknown name. */
  addLabAccountPreset(name: string, id?: string): StoredLabAccount | undefined {
    const record = labAccountFromPreset(name, {
      teamId: this.state.teamId,
      ...(id !== undefined ? { id } : {}),
    })
    return record ? this.addLabAccount(record) : undefined
  }

  /** Merge fields into an account; `undefined` when there is none with that id. */
  patchLabAccount(id: string, patch: Partial<LabAccountInput>): StoredLabAccount | undefined {
    const existing = this.state.labAccounts.get(id)
    if (!existing) return undefined
    const next = patchLabAccountRecord(existing, patch, this.state.teamId)
    this.editLabAccounts((accounts) => accounts.map((entry) => (entry.id === id ? next : entry)))
    return next
  }

  removeLabAccount(id: string): boolean {
    if (!this.state.labAccounts.has(id)) return false
    this.editLabAccounts((accounts) => accounts.filter((entry) => entry.id !== id))
    return true
  }

  /** The sandbox limits this namespace enforces. Every one is off unless configured. */
  get limits(): JunctionLimits {
    return { ...this.state.limits }
  }

  /** Change some limits (`null` lifts a numeric one); kept across `reset()`. */
  configureLimits(input: JunctionLimitsInput): JunctionLimits {
    this.state.limits = mergeLimits(this.state.limits, input)
    return this.limits
  }

  get identity(): IdentityMode {
    return this.state.identity
  }

  set identity(mode: IdentityMode) {
    if (!IDENTITY_MODES.includes(mode))
      throw new TypeError(`identity must be one of ${IDENTITY_MODES.join(", ")}`)
    this.state.identity = mode
  }

  /** Insert users with chosen ids, all or none. Throws `FixtureError` (400/404/409). */
  insertUsers(users: readonly UserFixture[]): UserRecord[] {
    return insertUsers(this.state, users, this.now)
  }

  /** Remove a user outright, leaving no deletion tombstone. */
  hardDeleteUser(userId: string): boolean {
    return hardDeleteUser(this.state, userId)
  }

  /** Insert orders, optionally already in a status. No webhook fires unless asked. */
  insertOrders(orders: readonly OrderFixture[], options: InsertOptions = {}): OrderRecord[] {
    return insertOrders(this.state, orders, this.now, options)
  }

  /** Load users, then orders, in one call. */
  importFixtures(
    fixtures: JunctionFixtures,
    options: InsertOptions = {},
  ): { users: UserRecord[]; orders: OrderRecord[] } {
    return importFixtures(this.state, fixtures, this.now, options)
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
      ...(corpus.teamId !== undefined ? { teamId: corpus.teamId } : {}),
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

/** Raised by `addLabAccount` for an id the namespace already has. */
export class LabAccountConflict extends Error {
  constructor(readonly id: string) {
    super(`lab account ${id} already exists`)
    this.name = "LabAccountConflict"
  }
}

/** Load construction-time fixtures without webhooks; a broken fixture file fails loudly. */
const importFixturesInto = (
  state: JunctionState,
  fixtures: JunctionFixtures,
  now: () => number,
): void => {
  try {
    importFixtures(state, fixtures, now)
  } catch (error) {
    const { message } = fixtureErrorMessage(error)
    throw new Error(`junction fixtures: ${message}`)
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const isJson = (headers: Headers): boolean =>
  (headers.get("content-type") ?? "").toLowerCase().includes("json")

/** A request's JSON body, read from a clone so the handler still gets the original. */
const requestJson = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  if (request.method === "GET" || request.method === "HEAD" || !isJson(request.headers))
    return undefined
  return asRecord(
    await request
      .clone()
      .json()
      .catch(() => undefined),
  )
}

const UUID_SEGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const USER_PATH = new RegExp(`^/v2/user/(${UUID_SEGMENT})(?:/|$)`)
const ORDER_PATH = new RegExp(`^/v3/order/(${UUID_SEGMENT})(?:/|$)`)

/**
 * The user, order and lab-account ids a request touched — from its path, query and body,
 * and from what it created — for the request journal. Bodies are read, never recorded.
 */
const touchedIds = async (
  request: Request,
  body: Record<string, unknown> | undefined,
  response: Response,
): Promise<Record<string, string>> => {
  const ids: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    if (typeof value === "string" && value !== "" && ids[key] === undefined) ids[key] = value
  }
  const url = new URL(request.url)
  put("userId", USER_PATH.exec(url.pathname)?.[1])
  put("orderId", ORDER_PATH.exec(url.pathname)?.[1])
  put("userId", url.searchParams.get("user_id"))
  put("orderId", url.searchParams.get("order_id"))
  put("labAccountId", url.searchParams.get("lab_account_id"))
  put("userId", body?.user_id)
  put("labAccountId", body?.lab_account_id)
  // Only a POST creates an id worth reading back; other bodies (availability, catalogs)
  // are large and already named by the path.
  if (request.method === "POST" && response.ok && isJson(response.headers)) {
    const created = asRecord(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    )
    const order = asRecord(created?.order)
    put("orderId", order?.id)
    put("userId", order?.user_id)
    put("labAccountId", order?.lab_account_id)
    put("userId", created?.user_id)
  }
  return ids
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
