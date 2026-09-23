/**
 * Ports of OUR PostHog consumers (geviti-monorepo, read-only), used as the acceptance oracle.
 * Each keeps the original's requests, timeouts, caches and value mapping; only logging and DI
 * are dropped, and every client takes an optional `fetch` so tests can run in-process.
 *
 * - {@link PostHogServerAdapter}: apps/backend/src/modules/feature-flags/adapters/posthog-server.adapter.ts
 * - {@link PostHogTrackingService}: apps/backend/src/modules/posthog-tracking/posthog-tracking.service.ts
 * - {@link WebsitePostHogPurchaseSink}: B/global-services/services/conversion-tracking/website-posthog-purchase.sink.ts
 * - {@link PostHogHogqlClient}: B/marketing-metrics/intake-engagement/posthog-hogql.client.ts
 * - {@link EmrFeatureFlagsService}: apps/geviti-emr-backend/src/services/feature-flags/feature-flags.service.ts
 * - {@link evaluatePostHogFlag}: apps/geviti-emr-frontend/src/lib/feature-flags/posthog-server.ts
 * - {@link MakorPostHogClient}: apps/makor-ecosystem/libs/makor_common/src/makor_common/posthog/client.py
 * - {@link fetchProjectFlags}: tooling/feature-flags-cli/lib/posthog.ts (+ posthog-schema.ts)
 * - {@link MemberAppFlagsAdapter} over {@link ReactNativeLikeClient}: M/lib/feature-flags/adapters/posthog.ts
 *   on the same `@posthog/core` `PostHogCore` posthog-react-native 4.72.1 extends.
 */
import { createHash } from "node:crypto"
import {
  PostHogCore,
  type PostHogCoreOptions,
  type PostHogFetchOptions,
  type PostHogFetchResponse,
  type PostHogPersistedProperty,
} from "@posthog/core"
import { PostHog } from "posthog-node"

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** posthog-node's `fetch` option shape, over a plain `(url, init) => Response`. */
const sdkFetch = (fetcher: Fetcher) => (url: string, options: PostHogFetchOptions) =>
  fetcher(url, options as RequestInit) as unknown as Promise<PostHogFetchResponse>

// ---------------------------------------------------------------------------------------------
// Backend: PostHogServerAdapter
// ---------------------------------------------------------------------------------------------

type CachedFlags = {
  featureFlags: Record<string, unknown>
  featureFlagPayloads: Record<string, unknown>
  fetchedAt: number
}

const AUTHORITATIVE_BOOLEAN_TIMEOUT_MS = 1_000
const MAIN_CLIENT_TIMEOUT_MS = 3_000

export type StrictBooleanUnresolvedReason =
  | "provider_unconfigured"
  | "provider_rejected"
  | "provider_threw"
  | "provider_timeout"
  | "not_a_boolean"

export type StrictBooleanResolution =
  | { status: "resolved"; enabled: boolean }
  | { status: "unresolved"; reason: StrictBooleanUnresolvedReason }

type StrictBooleanAnswer =
  | { source: "value"; value: unknown }
  | { source: "rejected" }
  | { source: "timeout" }

export class PostHogServerAdapter {
  readonly name = "posthog-server"
  private client: PostHog | null = null
  private authoritativeClient: PostHog | null = null
  private readonly cache = new Map<string, CachedFlags>()
  private readonly CACHE_TTL_MS = 60_000

  constructor(config: { POSTHOG_API_KEY?: string; POSTHOG_HOST?: string }, fetcher?: Fetcher) {
    const apiKey = config.POSTHOG_API_KEY
    const host = config.POSTHOG_HOST ?? "https://us.i.posthog.com"
    const extra = fetcher ? { fetch: sdkFetch(fetcher) } : {}
    if (apiKey) {
      this.client = new PostHog(apiKey, { host, requestTimeout: MAIN_CLIENT_TIMEOUT_MS, ...extra })
      this.authoritativeClient = new PostHog(apiKey, {
        host,
        requestTimeout: AUTHORITATIVE_BOOLEAN_TIMEOUT_MS,
        ...extra,
      })
    }
  }

  async onModuleDestroy(): Promise<void> {
    const clients = [this.client, this.authoritativeClient].filter(
      (client): client is PostHog => client !== null,
    )
    await Promise.allSettled(
      clients.map((client) => client.shutdown(AUTHORITATIVE_BOOLEAN_TIMEOUT_MS)),
    )
  }

  async isEnabled(flagKey: string, userId: string, defaultValue = false): Promise<boolean> {
    return (await this.getEvaluation(flagKey, userId)) ?? defaultValue
  }

  async getEvaluation(flagKey: string, userId: string): Promise<boolean | undefined> {
    const flags = await this.getFlags(userId)
    if (!flags) return undefined
    const value = flags.featureFlags[flagKey]
    if (value === undefined) return undefined
    if (value === true) return true
    if (value === false) return false
    if (typeof value === "string" && value.length > 0) return true
    return undefined
  }

  async isAuthoritativeBooleanEnabled(flagKey: string, userId: string) {
    return this.isStrictBooleanEnabled(flagKey, userId)
  }

  async isStrictBooleanEnabled(flagKey: string, userId: string): Promise<boolean> {
    const resolution = await this.resolveStrictBoolean(flagKey, userId)
    return resolution.status === "resolved" && resolution.enabled
  }

  async resolveStrictBoolean(flagKey: string, userId: string): Promise<StrictBooleanResolution> {
    if (!this.authoritativeClient) {
      return { status: "unresolved", reason: "provider_unconfigured" }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race<StrictBooleanAnswer>([
        this.authoritativeClient.getFeatureFlag(flagKey, userId).then(
          (value): StrictBooleanAnswer => ({ source: "value", value }),
          (): StrictBooleanAnswer => ({ source: "rejected" }),
        ),
        new Promise<StrictBooleanAnswer>((resolve) => {
          timeout = setTimeout(
            () => resolve({ source: "timeout" }),
            AUTHORITATIVE_BOOLEAN_TIMEOUT_MS,
          )
        }),
      ])
      if (answer.source === "rejected") return { status: "unresolved", reason: "provider_rejected" }
      if (answer.source === "timeout") return { status: "unresolved", reason: "provider_timeout" }
      if (answer.value === true) return { status: "resolved", enabled: true }
      if (answer.value === false) return { status: "resolved", enabled: false }
      return { status: "unresolved", reason: "not_a_boolean" }
    } catch {
      return { status: "unresolved", reason: "provider_threw" }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async getConfig(flagKey: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const flags = await this.getFlags(userId)
    if (!flags) return undefined
    const payload = flags.featureFlagPayloads[flagKey]
    if (payload !== undefined && typeof payload === "object" && payload !== null) {
      return payload as Record<string, unknown>
    }
    return undefined
  }

  private async getFlags(userId: string): Promise<CachedFlags | null> {
    if (!this.client) return null
    const cached = this.cache.get(userId)
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) return cached
    try {
      const result = await this.client.getAllFlagsAndPayloads(userId)
      const entry: CachedFlags = {
        featureFlags: (result?.featureFlags ?? {}) as Record<string, unknown>,
        featureFlagPayloads: (result?.featureFlagPayloads ?? {}) as Record<string, unknown>,
        fetchedAt: Date.now(),
      }
      this.cache.set(userId, entry)
      return entry
    } catch {
      return cached ?? null
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Backend: PostHogTrackingService (capture through posthog-node, gzip /batch/)
// ---------------------------------------------------------------------------------------------

export class PostHogTrackingService {
  private client: PostHog | null = null

  constructor(config: { POSTHOG_API_KEY?: string; POSTHOG_HOST?: string }, fetcher?: Fetcher) {
    const apiKey = config.POSTHOG_API_KEY
    const host = config.POSTHOG_HOST ?? "https://us.i.posthog.com"
    if (apiKey) {
      this.client = new PostHog(apiKey, { host, ...(fetcher ? { fetch: sdkFetch(fetcher) } : {}) })
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.shutdown()
  }

  trackLifecycleEvent(
    userId: string,
    event: string,
    properties: Record<string, unknown>,
    lifecycleStage: string,
    personProperties: Record<string, unknown> = {},
  ): void {
    if (!this.client) return
    this.client.capture({
      distinctId: userId,
      event,
      properties: {
        ...properties,
        $set: {
          lifecycle_stage: lifecycleStage,
          last_lifecycle_event: lifecycleStage,
          last_lifecycle_event_at: new Date().toISOString(),
          ...personProperties,
        },
      },
    })
  }

  track(
    userId: string,
    event: string,
    properties: Record<string, unknown> = {},
    timestamp?: Date,
  ): void {
    if (!this.client) return
    const trimmedUserId = userId.trim()
    const trimmedEvent = event.trim()
    if (!trimmedUserId || !trimmedEvent) return
    this.client.capture({
      distinctId: trimmedUserId,
      event: trimmedEvent,
      properties,
      ...(timestamp ? { timestamp } : {}),
    })
  }

  setPersonProperties(userId: string, properties: Record<string, unknown>): void {
    if (!this.client) return
    this.client.capture({ distinctId: userId, event: "$set", properties: { $set: properties } })
  }

  /** Not in the service (Nest flushes on shutdown); lets a test flush without closing. */
  async flush(): Promise<void> {
    await this.client?.flush()
  }
}

// ---------------------------------------------------------------------------------------------
// Backend: WebsitePostHogPurchaseSink (raw POST /i/v0/e/)
// ---------------------------------------------------------------------------------------------

export const WEBSITE_PURCHASE_EVENT = "membership_purchase_completed"
export const WEBSITE_PURCHASE_SOURCE = "backend-conversion-rail"
const WEBSITE_PURCHASE_NAMESPACE = "9f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const CAPTURE_PATH = "/i/v0/e/"
const CAPTURE_TIMEOUT_MS = 3000

/** RFC 4122 v5 (what the `uuid` package's `v5` computes). */
export const uuidv5 = (name: string, namespace: string): string => {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest()
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const websitePurchaseCaptureUuid = (distinctId: string, orderId: string): string =>
  uuidv5(`${WEBSITE_PURCHASE_EVENT}:${distinctId}:${orderId}`, WEBSITE_PURCHASE_NAMESPACE)

const isProductionAppEnv = (appEnv: string | undefined): boolean => {
  const trimmed = String(appEnv ?? "")
    .trim()
    .toLowerCase()
  return trimmed === "production" || trimmed === "prod"
}

export type WebsitePurchaseCapture = {
  distinctId: string
  orderId: string
  eventTime: string
  amountInCents?: number
  currency?: string
}

export class WebsitePostHogPurchaseSink {
  private readonly apiKey: string
  private readonly appEnv: string
  private readonly host: string

  constructor(
    config: {
      MARKETING_SPLIT_POSTHOG_WEBSITE_KEY?: string
      APP_ENV?: string
      POSTHOG_HOST?: string
    },
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.apiKey = config.MARKETING_SPLIT_POSTHOG_WEBSITE_KEY?.trim() ?? ""
    this.appEnv = config.APP_ENV?.trim() ?? ""
    this.host = config.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST
  }

  private get enabled(): boolean {
    return isProductionAppEnv(this.appEnv) && this.apiKey.length > 0
  }

  async capturePurchase(capture: WebsitePurchaseCapture): Promise<"sent" | "skipped"> {
    if (!this.enabled) return "skipped"
    if (!capture.distinctId.trim() || !capture.orderId.trim()) return "skipped"
    const eventUuid = websitePurchaseCaptureUuid(capture.distinctId, capture.orderId)
    const value =
      typeof capture.amountInCents === "number" && capture.amountInCents > 0
        ? capture.amountInCents / 100
        : undefined
    const payload = {
      api_key: this.apiKey,
      event: WEBSITE_PURCHASE_EVENT,
      distinct_id: capture.distinctId,
      timestamp: capture.eventTime,
      uuid: eventUuid,
      properties: {
        idempotency_key: eventUuid,
        order_id: capture.orderId,
        source: WEBSITE_PURCHASE_SOURCE,
        ...(value !== undefined ? { value } : {}),
        ...(capture.currency ? { currency: capture.currency.toUpperCase() } : {}),
      },
    }
    const response = await this.fetcher(`${this.host.replace(/\/+$/, "")}${CAPTURE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(
        `Website PostHog purchase capture failed with status ${String(response.status)}`,
      )
    }
    return "sent"
  }
}

// ---------------------------------------------------------------------------------------------
// Backend: PostHogHogqlClient (host is hardcoded upstream; injected here)
// ---------------------------------------------------------------------------------------------

export class PostHogHogqlClient {
  constructor(
    private readonly config: { MARKETING_METRICS_POSTHOG_READ_KEY?: string },
    private readonly host = "https://us.posthog.com",
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async query(query: string, options: { projectId?: number } = {}): Promise<unknown[][]> {
    const readKey = this.config.MARKETING_METRICS_POSTHOG_READ_KEY?.trim()
    if (!readKey) {
      throw new Error(
        "MARKETING_METRICS_POSTHOG_READ_KEY is required for marketing engagement metrics",
      )
    }
    const projectId = options.projectId ?? 339666
    const response = await this.fetcher(`${this.host}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`PostHog marketing query failed with HTTP ${response.status}`)
    }
    const body = (await response.json()) as { results?: unknown }
    // postHogQueryResponseSchema: z.object({ results: z.array(z.array(z.unknown())) })
    if (!Array.isArray(body.results) || !body.results.every(Array.isArray)) {
      throw new Error("PostHog marketing query returned an invalid body")
    }
    return body.results as unknown[][]
  }
}

// ---------------------------------------------------------------------------------------------
// EMR backend: FeatureFlagsService.evaluateFlag (isFeatureEnabled raced against 1 s)
// ---------------------------------------------------------------------------------------------

const FLAG_EVAL_TIMEOUT_MS = 1_000
const FLAG_EVAL_TIMEOUT = Symbol("flag-eval-timeout")

export class EmrFeatureFlagsService {
  private readonly client: PostHog | null

  constructor(apiKey: string, host: string, fetcher?: Fetcher) {
    this.client =
      apiKey.trim().length > 0
        ? new PostHog(apiKey, {
            host,
            requestTimeout: FLAG_EVAL_TIMEOUT_MS,
            ...(fetcher ? { fetch: sdkFetch(fetcher) } : {}),
          })
        : null
  }

  /** The private `evaluateFlag` every gate (`isRxIdVerificationRequired`, …) goes through. */
  async evaluateFlag(flagKey: string, distinctId: string): Promise<boolean> {
    if (!this.client) return false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.client.isFeatureEnabled(flagKey, distinctId).catch(() => undefined),
        new Promise<typeof FLAG_EVAL_TIMEOUT>((resolve) => {
          timeout = setTimeout(() => resolve(FLAG_EVAL_TIMEOUT), FLAG_EVAL_TIMEOUT_MS)
        }),
      ])
      if (result === FLAG_EVAL_TIMEOUT) return false
      if (result === undefined) return false
      return result === true
    } catch {
      return false
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  isRxIdVerificationRequired(userId: string) {
    return this.evaluateFlag("rx-id-verification", userId)
  }

  isMemberTaggingProgramEnabled(distinctId: string) {
    return this.evaluateFlag("b2b-member-tagging", distinctId)
  }

  async shutdown() {
    await this.client?.shutdown(FLAG_EVAL_TIMEOUT_MS)
  }
}

// ---------------------------------------------------------------------------------------------
// EMR frontend server: raw `POST ${host}/flags?v=2` with `api_key` (no trailing slash)
// ---------------------------------------------------------------------------------------------

const POSTHOG_TIMEOUT_MS = 2_000
const SUCCESS_CACHE_TTL_MS = 60_000
const FAILURE_CACHE_TTL_MS = 10_000

export const SERVER_FLAG_SENTINEL_DISTINCT_ID = "geviti-emr-server"

export type ServerFlagIdentity = {
  distinctId: string
  personProperties?: Record<string, string>
}

const evaluationCache = new Map<string, { value: boolean | undefined; expiresAt: number }>()

export function resetServerFlagCache(): void {
  evaluationCache.clear()
}

function normalizeHost(host: string | undefined): string {
  const trimmed = host?.trim()
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return DEFAULT_POSTHOG_HOST
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readFlagDetail(detail: unknown): boolean | undefined {
  if (!isRecord(detail)) return undefined
  const { enabled, variant } = detail
  if (typeof enabled !== "boolean") return undefined
  if (variant === undefined || variant === null) return enabled
  if (typeof variant !== "string" || variant.length === 0) return undefined
  return enabled
}

function readLegacyFlagValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string" && value.length > 0) return true
  return undefined
}

export function readFlagFromPayload(payload: unknown, flagKey: string): boolean | undefined {
  if (!isRecord(payload)) return undefined
  const { flags, featureFlags } = payload
  if (flags !== undefined) {
    if (!isRecord(flags)) return undefined
    if (flagKey in flags) return readFlagDetail(flags[flagKey])
  }
  if (featureFlags !== undefined) {
    if (!isRecord(featureFlags)) return undefined
    if (flagKey in featureFlags) return readLegacyFlagValue(featureFlags[flagKey])
  }
  return undefined
}

async function fetchPostHogFlag(
  apiKey: string,
  host: string,
  flagKey: string,
  identity: ServerFlagIdentity,
  fetcher: Fetcher,
): Promise<boolean | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
  try {
    const response = await fetcher(`${host}/flags?v=2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        distinct_id: identity.distinctId,
        ...(identity.personProperties ? { person_properties: identity.personProperties } : {}),
      }),
      cache: "no-store",
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    return readFlagFromPayload(payload, flagKey)
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** `evaluatePostHogFlag`, with the env read passed in (`NEXT_PUBLIC_POSTHOG_KEY/HOST`). */
export async function evaluatePostHogFlag(
  env: { NEXT_PUBLIC_POSTHOG_KEY?: string; NEXT_PUBLIC_POSTHOG_HOST?: string },
  flagKey: string,
  identity: ServerFlagIdentity,
  fetcher: Fetcher = fetch,
): Promise<boolean | undefined> {
  const apiKey = env.NEXT_PUBLIC_POSTHOG_KEY
  if (!apiKey) return undefined
  const cacheKey = `${apiKey}|${flagKey}|${identity.distinctId}`
  const cached = evaluationCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const host = normalizeHost(env.NEXT_PUBLIC_POSTHOG_HOST)
  const value = await fetchPostHogFlag(apiKey, host, flagKey, identity, fetcher)
  const ttlMs = typeof value === "boolean" ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS
  evaluationCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs })
  return value
}

// ---------------------------------------------------------------------------------------------
// makor: PostHogClient (Python, httpx) — `POST ${host}/decide/?v=3 {api_key, distinct_id}`
// ---------------------------------------------------------------------------------------------

export class MakorPostHogClient {
  private readonly cache = new Map<string, [number, Record<string, unknown>]>()

  constructor(
    private readonly apiKey: string,
    private readonly host: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async getEvaluation(flagKey: string, distinctId: string): Promise<boolean | null> {
    const flags = await this.flagsFor(distinctId)
    if (flags === null) return null
    const value = flags[flagKey]
    if (value === true) return true
    if (value === false) return false
    if (typeof value === "string" && value) return true
    return null
  }

  async isEnabled(flagKey: string, distinctId: string, defaultValue = false): Promise<boolean> {
    return (await this.getEvaluation(flagKey, distinctId)) ?? defaultValue
  }

  private async flagsFor(distinctId: string): Promise<Record<string, unknown> | null> {
    if (!this.apiKey) return null
    const cached = this.cache.get(distinctId)
    if (cached && Date.now() - cached[0] < 60_000) return cached[1]
    let body: unknown
    try {
      const response = await this.fetcher(`${this.host.replace(/\/$/, "")}/decide/?v=3`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey, distinct_id: distinctId }),
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return null // raise_for_status
      body = await response.json()
    } catch {
      return null
    }
    const flags = isRecord(body) ? body.featureFlags : undefined
    if (!isRecord(flags)) return null
    this.cache.set(distinctId, [Date.now(), flags])
    return flags
  }
}

// ---------------------------------------------------------------------------------------------
// tooling/feature-flags-cli: fetchProjectFlags (pagination + posthogPageSchema)
// ---------------------------------------------------------------------------------------------

export type CliFlag = {
  key: string
  active: boolean
  deleted?: boolean
  filters: { groups: Record<string, unknown>[]; multivariate?: unknown }
}

/** posthogPageSchema / posthogFlagSchema, minus zod. Throws like the CLI on a bad page. */
const parsePage = (payload: unknown): { next: string | null; results: CliFlag[] } => {
  if (!isRecord(payload)) throw new Error("Invalid PostHog flag data.")
  const { next, results } = payload
  if (!(next === null || (typeof next === "string" && next.length > 0)))
    throw new Error("Invalid PostHog flag data.")
  if (!Array.isArray(results)) throw new Error("Invalid PostHog flag data.")
  for (const flag of results) {
    if (!isRecord(flag) || typeof flag.key !== "string" || flag.key.length === 0)
      throw new Error("Invalid PostHog flag data.")
    if (typeof flag.active !== "boolean") throw new Error("Invalid PostHog flag data.")
    const filters = flag.filters ?? { groups: [] }
    if (!isRecord(filters)) throw new Error("Invalid PostHog flag data.")
    const groups = filters.groups ?? []
    if (!Array.isArray(groups)) throw new Error("Invalid PostHog flag data.")
    for (const group of groups) {
      const rollout = (group as Record<string, unknown>).rollout_percentage
      if (rollout != null && (typeof rollout !== "number" || rollout < 0 || rollout > 100))
        throw new Error("Invalid PostHog flag data.")
    }
    for (const stamp of [flag.created_at, flag.updated_at]) {
      if (stamp != null && (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))))
        throw new Error("Invalid PostHog flag data.")
    }
  }
  return { next: next as string | null, results: results as CliFlag[] }
}

export async function fetchProjectFlags(
  apiOrigin: string,
  projectId: number,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<CliFlag[]> {
  const path = `/api/projects/${projectId}/feature_flags/`
  let next: string | null = `${apiOrigin}${path}?limit=100`
  const seen = new Set<string>()
  const flags = new Map<string, CliFlag>()
  while (next) {
    const url: URL = new URL(next, apiOrigin)
    if (url.origin !== apiOrigin || url.pathname !== path || seen.has(url.href)) {
      throw new Error("Unsafe or repeated PostHog pagination URL.")
    }
    seen.add(url.href)
    const response = await fetcher(url.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
    })
    if (!response.ok) throw new Error(`PostHog HTTP ${response.status}.`)
    const page = parsePage(await response.json())
    for (const flag of page.results) {
      if (flag.deleted === true || flags.has(flag.key)) continue
      flags.set(flag.key, flag)
    }
    next = page.next
  }
  return [...flags.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function hasFilters(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") {
    if ("values" in value) return hasFilters((value as { values: unknown }).values)
    return Object.keys(value).length > 0
  }
  return true
}

/** tooling/feature-flags-cli/lib/classifier.ts `deriveState` (the `state` field only). */
export function deriveState(flag: CliFlag | undefined): string {
  if (!flag) return "missing"
  if (!flag.active) return "inactive"
  const FULL_ROLLOUT = 100
  const rollout = (group: Record<string, unknown>) =>
    (group.rollout_percentage as number | null | undefined) ?? FULL_ROLLOUT
  const groups = flag.filters.groups.filter((group) => rollout(group) > 0)
  const targeted = (group: Record<string, unknown>) =>
    hasFilters(group.properties) || hasFilters(group.cohort) || hasFilters(group.person)
  if (groups.some((group) => !targeted(group) && rollout(group) === FULL_ROLLOUT)) return "live"
  if (groups.some((group) => !targeted(group))) return "ramping"
  if (groups.some(targeted)) return "targeted"
  return groups.length > 0 ? "ramping" : "rollout 0"
}

// ---------------------------------------------------------------------------------------------
// member-app: PosthogFeatureFlagsAdapter over a posthog-react-native-like PostHogCore client
// ---------------------------------------------------------------------------------------------

/**
 * posthog-react-native 4.72.1's `PostHog` is `@posthog/core`'s `PostHogCore` plus RN storage
 * and device plumbing. This subclass supplies the same abstract members (memory storage,
 * `fetch`), so `reloadFeatureFlagsAsync`, `getFeatureFlag`, `getFeatureFlagPayload` and
 * `getFeatureFlagsAndPayloads` run the exact SDK code the app does.
 */
export class ReactNativeLikeClient extends PostHogCore {
  private readonly storage = new Map<string, unknown>()

  constructor(
    apiKey: string,
    options: PostHogCoreOptions & { host: string },
    private readonly fetcher: Fetcher = fetch,
  ) {
    super(apiKey, { flushAt: 1, preloadFeatureFlags: false, ...options })
    this.setupBootstrap(options)
  }

  fetch(url: string, options: PostHogFetchOptions): Promise<PostHogFetchResponse> {
    return this.fetcher(url, options as RequestInit) as unknown as Promise<PostHogFetchResponse>
  }
  getLibraryId(): string {
    return "posthog-react-native"
  }
  getLibraryVersion(): string {
    return "4.72.1"
  }
  getCustomUserAgent(): string | undefined {
    return undefined
  }
  getPersistedProperty<T>(key: PostHogPersistedProperty): T | undefined {
    return this.storage.get(key) as T | undefined
  }
  setPersistedProperty<T>(key: PostHogPersistedProperty, value: T | null): void {
    if (value === null) this.storage.delete(key)
    else this.storage.set(key, value)
  }
}

export class MemberAppFlagsAdapter {
  constructor(private readonly client: ReactNativeLikeClient | null) {}

  async init(): Promise<void> {
    await this.client?.reloadFeatureFlagsAsync()
  }

  hasFlag(flagKey: string): boolean {
    if (!this.client) return false
    const { flags } = this.client.getFeatureFlagsAndPayloads()
    return flags != null && Object.hasOwn(flags, flagKey)
  }

  isEnabled(flagKey: string, defaultValue = false): boolean {
    if (!this.client) return defaultValue
    if (!this.hasFlag(flagKey)) return defaultValue
    const value = this.client.isFeatureEnabled(flagKey)
    if (value === true) return true
    if (value === false) return false
    return defaultValue
  }

  getValue(flagKey: string) {
    if (!this.client) return undefined
    const value = this.client.getFeatureFlag(flagKey)
    if (typeof value === "boolean" || typeof value === "string") return value
    return undefined
  }

  getConfig(flagKey: string): Record<string, unknown> | undefined {
    if (!this.client) return undefined
    const value = this.client.getFeatureFlag(flagKey)
    if (value === undefined) return undefined
    const payload = this.client.getFeatureFlagPayload(flagKey)
    if (payload !== undefined && typeof payload === "object" && payload !== null) {
      return payload as Record<string, unknown>
    }
    return undefined
  }
}
