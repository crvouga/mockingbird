import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bootSqlite,
  Collection,
  createService,
  DEFAULT_NAMESPACE,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  GarminHealthRuntime,
  GarminHealthRuntimeOptions,
  GarminHealthWebhooks,
} from "./runtime.js"
export {
  createRuntime,
  GARMIN_HEALTH_PRESETS,
  WEBHOOK_PATHS,
  webhookEndpoints,
} from "./runtime.js"

export const GARMIN_HEALTH_NAMESPACE = "garmin-health"
export const SUMMARY_TYPES = ["activities", "sleeps", "dailies", "epochs", "bodyComps", "hrv"] as const
export type SummaryType = (typeof SUMMARY_TYPES)[number]
/** Longest backfill window one request may cover (best guess, not oracle-verified). */
export const MAX_BACKFILL_SECONDS = 90 * 86400
const CODE_TTL_MS = 600_000

export type DeliveryMode = "push" | "ping"
export type GarminUser = {
  userId: string
  /** How accepted backfills reach the webhook: the summaries themselves, or a callbackURL per type. */
  delivery: DeliveryMode
  /** False after deregistration: every token of the user answers 401. */
  registered: boolean
  permissions: Record<string, boolean>
}
export type Client = { id: string; secret: string; redirectUris: string[] }
export type Grant = {
  token: string
  refreshToken: string
  clientId: string
  userId: string
  expiresAt: number
}
export type OAuthCode = {
  code: string
  clientId: string
  userId: string
  redirectUri: string
  challenge: string
  expiresAt: number
}
/** One seeded summary. `data` is delivered as given (plus `userId`); its time field places it in a window. */
export type Summary = {
  key: string
  userId: string
  type: SummaryType
  data: Record<string, unknown>
}
export type SummarySeed = Omit<Summary, "key"> & { key?: string }
export type BackfillRecord = {
  key: string
  userId: string
  type: SummaryType
  start: number
  end: number
  requestedAt: number
  notificationId: string | null
}
export type Notification = {
  id: string
  userId: string
  type: SummaryType
  start: number
  end: number
  mode: DeliveryMode
  state: "pending" | "sent" | "dropped"
  items: number
  /** The exact webhook body, built when the backfill was accepted. */
  body: Record<string, unknown>
}
export type CallbackToken = {
  token: string
  userId: string
  type: SummaryType
  start: number
  end: number
}
export type Settings = {
  /** False holds accepted notifications until `POST /__admin/notifications/deliver`. */
  autoDeliver: boolean
  /** Whose account the consent page signs in. Default: the first seeded user. */
  consentUserId?: string
  /** The consent page answers `error=access_denied`. */
  denyConsent: boolean
  /** A refresh grant issues a new refresh token and retires the old one. */
  rotateRefreshTokens: boolean
  tokenTtlSeconds: number
  /** Origin used for ping `callbackURL`s instead of the origin the backfill request arrived on. */
  publicUrl?: string
}

/** What the emulator asks its runtime to send to the consumer's webhook. */
export type GarminWebhookEvent = {
  kind: "push" | "ping" | "deregistration" | "permissions"
  body: Record<string, unknown>
  tags: Record<string, string>
}

export type GarminHealthAPIOptions = APIOptions & {
  users?: GarminUser[]
  clients?: Client[]
  grants?: Grant[]
  codes?: OAuthCode[]
  summaries?: SummarySeed[]
  settings?: Partial<Settings>
  /** The reserved admin prefix, for namespaced callback URLs. */
  adminPrefix?: string
  /** The namespace name a request selects this instance by. */
  publicNamespace?: string
  onWebhook?: (event: GarminWebhookEvent) => void
}

const DAY = 1767225600 // 2026-01-01T00:00:00Z
const defaultSummaries = (userId: string): SummarySeed[] => [
  {
    userId,
    type: "activities",
    data: {
      summaryId: "act-1",
      activityId: 9001,
      activityType: "RUNNING",
      activityName: "Morning run",
      deviceName: "Forerunner 265",
      startTimeInSeconds: DAY + 25200,
      durationInSeconds: 1800,
      averageHeartRateInBeatsPerMinute: 150,
      maxHeartRateInBeatsPerMinute: 176,
      steps: 5200,
      distanceInMeters: 5000,
      activeKilocalories: 320,
    },
  },
  {
    userId,
    type: "sleeps",
    data: {
      summaryId: "sleep-1",
      calendarDate: "2026-01-01",
      startTimeInSeconds: DAY + 600,
      durationInSeconds: 27000,
      deepSleepDurationInSeconds: 5000,
      lightSleepDurationInSeconds: 14000,
      remSleepDurationInSeconds: 6000,
      awakeDurationInSeconds: 2000,
      overallSleepScore: { value: 82, qualifierKey: "GOOD" },
    },
  },
  {
    userId,
    type: "dailies",
    data: {
      summaryId: "daily-1",
      calendarDate: "2026-01-01",
      startTimeInSeconds: DAY,
      steps: 9100,
      distanceInMeters: 7400,
      activeKilocalories: 540,
      floorsClimbed: 12,
      restingHeartRateInBeatsPerMinute: 52,
    },
  },
  {
    userId,
    type: "epochs",
    data: {
      summaryId: "epoch-1",
      startTimeInSeconds: DAY + 3600,
      meanHeartRateInBeatsPerMinute: 64,
      steps: 40,
      activeKilocalories: 3,
    },
  },
  {
    userId,
    type: "bodyComps",
    data: {
      summaryId: "body-1",
      measurementTimeInSeconds: DAY + 28800,
      weightInGrams: 72000,
      bodyFatInPercent: 18.5,
      bodyMassIndex: 22.4,
    },
  },
  {
    userId,
    type: "hrv",
    data: {
      summaryId: "hrv-1",
      calendarDate: "2026-01-01",
      startTimeInSeconds: DAY + 600,
      lastNightAvg: 61,
    },
  },
]

export const isSummaryType = (value: string): value is SummaryType =>
  (SUMMARY_TYPES as readonly string[]).includes(value)

/** The second a summary belongs to: `measurementTimeInSeconds` for body composition, else `startTimeInSeconds`. */
export const summaryTime = (type: SummaryType, data: Record<string, unknown>): number | undefined => {
  const value = data[type === "bodyComps" ? "measurementTimeInSeconds" : "startTimeInSeconds"]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const apiError = (status: number, error: string, message: string) =>
  jsonRes(status, { error, message })
const unauthorized = () =>
  apiError(401, "unauthorized", "The access token is missing, expired, revoked or invalid.")
const oauthError = (error: string, description: string, status = 400) =>
  jsonRes(status, { error, error_description: description })

const sha256Challenge = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  return btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

export class GarminHealthAPI implements FetchAPI {
  readonly app: Hono
  readonly users: Collection<GarminUser>
  readonly clients: Collection<Client>
  readonly grants: Collection<Grant>
  readonly codes: Collection<OAuthCode>
  readonly summaries: Collection<Summary>
  readonly backfills: Collection<BackfillRecord>
  readonly notifications: Collection<Notification>
  readonly callbacks: Collection<CallbackToken>
  private readonly settingsRow: Collection<Settings>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: {
    users: GarminUser[]
    clients: Client[]
    grants: Grant[]
    codes: OAuthCode[]
    summaries: SummarySeed[]
    settings: Settings
  }
  private readonly adminPrefix: string
  private readonly publicNamespace: string
  private readonly onWebhook: (event: GarminWebhookEvent) => void
  constructor(options: GarminHealthAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? GARMIN_HEALTH_NAMESPACE
    this.now = options.now ?? Date.now
    this.users = new Collection(sqlite, namespace, "users")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.grants = new Collection(sqlite, namespace, "grants")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.summaries = new Collection(sqlite, namespace, "summaries")
    this.backfills = new Collection(sqlite, namespace, "backfills")
    this.notifications = new Collection(sqlite, namespace, "notifications")
    this.callbacks = new Collection(sqlite, namespace, "callbacks")
    this.settingsRow = new Collection(sqlite, namespace, "settings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.adminPrefix = options.adminPrefix ?? "/__admin"
    this.publicNamespace = options.publicNamespace ?? DEFAULT_NAMESPACE
    this.onWebhook = options.onWebhook ?? (() => {})
    const users = options.users ?? [
      { userId: "garmin-user-1", delivery: "push", registered: true, permissions: {} },
    ]
    const settings: Settings = {
      autoDeliver: true,
      denyConsent: false,
      rotateRefreshTokens: true,
      tokenTtlSeconds: 86400,
      ...options.settings,
    }
    if (!Number.isInteger(settings.tokenTtlSeconds) || settings.tokenTtlSeconds < 1)
      throw new Error("tokenTtlSeconds must be positive")
    this.fixtures = structuredClone({
      users,
      clients: options.clients ?? [
        { id: "mock_garmin_client", secret: "mock_garmin_secret", redirectUris: [] },
      ],
      grants: options.grants ?? [
        {
          token: "mock_garmin_token",
          refreshToken: "mock_garmin_refresh",
          clientId: "mock_garmin_client",
          userId: users[0]?.userId ?? "garmin-user-1",
          expiresAt: 4102444800000,
        },
      ],
      codes: options.codes ?? [],
      summaries: options.summaries ?? defaultSummaries(users[0]?.userId ?? "garmin-user-1"),
      settings,
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => apiError(404, "not_found", "Not Found"),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        Authorize: (c) => this.authorize(c),
        OAuthToken: (c) => this.exchange(c),
        GetUserId: (c) => this.userId(c),
        RequestBackfill: (c) => this.backfill(c),
        DeleteRegistration: (c) => this.deregister(c),
        GetCallbackSummaries: (c) => this.callback(c),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const u of this.fixtures.users) this.users.insert(u.userId, u)
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const g of this.fixtures.grants) this.grants.insert(g.token, g)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    this.settingsRow.insert("current", this.fixtures.settings)
    for (const s of this.fixtures.summaries) this.addSummary(s)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }

  // ---- state the admin routes and tests drive -------------------------------------------------

  settings(): Settings {
    return this.settingsRow.get("current") as Settings
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch }
    if (!Number.isInteger(next.tokenTtlSeconds) || next.tokenTtlSeconds < 1)
      throw new Error("tokenTtlSeconds must be a positive integer")
    this.settingsRow.update("current", next)
    return next
  }
  /** Add or replace a user; a user is registered unless said otherwise. */
  putUser(user: Partial<GarminUser> & { userId: string }): GarminUser {
    if (user.delivery !== undefined && user.delivery !== "push" && user.delivery !== "ping")
      throw new Error('delivery must be "push" or "ping"')
    const existing = this.users.get(user.userId)
    const next: GarminUser = {
      delivery: "push",
      registered: true,
      permissions: {},
      ...existing,
      ...user,
    }
    if (existing) this.users.update(user.userId, next)
    else this.users.insert(user.userId, next)
    return next
  }
  addSummary(seed: SummarySeed): Summary {
    if (!isSummaryType(seed.type)) throw new Error(`type must be one of ${SUMMARY_TYPES.join(", ")}`)
    if (typeof seed.userId !== "string" || !seed.userId) throw new Error("userId is required")
    if (summaryTime(seed.type, seed.data) === undefined)
      throw new Error(
        `data.${seed.type === "bodyComps" ? "measurementTimeInSeconds" : "startTimeInSeconds"} is required`,
      )
    const key = seed.key ?? `${seed.userId}:${seed.type}:${String(seed.data.summaryId ?? this.summaries.count() + 1)}`
    const summary: Summary = { key, userId: seed.userId, type: seed.type, data: seed.data }
    if (this.summaries.has(key)) this.summaries.update(key, summary)
    else this.summaries.insert(key, summary)
    return summary
  }
  /** The seeded summaries of one user and type in `[start, end)`, oldest seeded first. */
  summariesIn(userId: string, type: SummaryType, start: number, end: number): Summary[] {
    return this.summaries
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((s) => {
        const time = summaryTime(s.type, s.data)
        return (
          s.userId === userId && s.type === type && time !== undefined && time >= start && time < end
        )
      })
  }
  /** Revoke the user's registration as Garmin does when the user disconnects, and tell the consumer. */
  deregisterUser(userId: string): { notified: boolean } {
    const user = this.users.get(userId)
    if (!user) throw new Error(`no user ${userId}`)
    const token = this.grants
      .list({ order: "newest" })
      .map((r) => r.value)
      .find((g) => g.userId === userId)?.token
    this.users.update(userId, { ...user, registered: false })
    this.onWebhook({
      kind: "deregistration",
      body: { deregistrations: [{ userId, userAccessToken: token ?? "" }] },
      tags: { userId },
    })
    return { notified: true }
  }
  changePermissions(userId: string, permissions: Record<string, boolean>): GarminUser {
    const user = this.users.get(userId)
    if (!user) throw new Error(`no user ${userId}`)
    const next = { ...user, permissions: { ...user.permissions, ...permissions } }
    this.users.update(userId, next)
    this.onWebhook({
      kind: "permissions",
      body: { userPermissionsChange: [{ userId, permissions: next.permissions }] },
      tags: { userId },
    })
    return next
  }
  /** Expire the user's access tokens now; `revokeRefresh` also retires their refresh tokens. */
  expireTokens(userId: string, revokeRefresh = false): number {
    let count = 0
    for (const { value } of this.grants.list({ order: "oldest" })) {
      if (value.userId !== userId) continue
      this.grants.update(value.token, {
        ...value,
        expiresAt: this.now(),
        ...(revokeRefresh ? { refreshToken: "" } : {}),
      })
      count++
    }
    return count
  }
  /** Send held notifications (all, or the named ones). Returns the ids sent. */
  deliverPending(ids?: string[]): string[] {
    const sent: string[] = []
    for (const { value } of this.notifications.list({ order: "oldest" })) {
      if (value.state !== "pending" || (ids && !ids.includes(value.id))) continue
      this.send(value)
      sent.push(value.id)
    }
    return sent
  }
  /** Drop held notifications (all, or the named ones): the vendor never delivers them. */
  dropPending(ids?: string[]): string[] {
    const dropped: string[] = []
    for (const { value } of this.notifications.list({ order: "oldest" })) {
      if (value.state !== "pending" || (ids && !ids.includes(value.id))) continue
      this.notifications.update(value.id, { ...value, state: "dropped" })
      dropped.push(value.id)
    }
    return dropped
  }
  private send(n: Notification) {
    this.notifications.update(n.id, { ...n, state: "sent" })
    this.onWebhook({ kind: n.mode, body: n.body, tags: { userId: n.userId, summaryType: n.type } })
  }

  // ---- OAuth ----------------------------------------------------------------------------------

  private authorize(c: OperationContext): Response {
    const q = c.url.searchParams,
      client = this.clients.get(q.get("client_id") ?? ""),
      redirect = q.get("redirect_uri") ?? ""
    if (!client) return oauthError("invalid_request", "Unknown client_id.")
    if (!redirect || (client.redirectUris.length > 0 && !client.redirectUris.includes(redirect)))
      return oauthError("invalid_request", "redirect_uri is not registered for this client.")
    let target: URL
    try {
      target = new URL(redirect)
    } catch {
      return oauthError("invalid_request", "redirect_uri is not a URL.")
    }
    const back = (params: Record<string, string>) => {
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
      const state = q.get("state")
      if (state !== null) target.searchParams.set("state", state)
      return new Response(null, { status: 302, headers: { location: target.toString() } })
    }
    if (q.get("response_type") !== "code")
      return back({ error: "unsupported_response_type", error_description: "response_type must be code." })
    const challenge = q.get("code_challenge") ?? ""
    if (!challenge || q.get("code_challenge_method") !== "S256")
      return back({
        error: "invalid_request",
        error_description: "code_challenge with code_challenge_method=S256 is required.",
      })
    const settings = this.settings(),
      userId = settings.consentUserId ?? this.users.list({ order: "oldest" })[0]?.value.userId
    if (settings.denyConsent || !userId)
      return back({ error: "access_denied", error_description: "The user denied the request." })
    const code = this.ids.next("mock_garmin_code")
    this.codes.insert(code, {
      code,
      clientId: client.id,
      userId,
      redirectUri: redirect,
      challenge,
      expiresAt: this.now() + CODE_TTL_MS,
    })
    return back({ code })
  }

  private async exchange(c: OperationContext): Promise<Response> {
    if (!c.request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      return oauthError("invalid_request", "Expected a form encoded body.")
    const body = new URLSearchParams(
        c.body.kind === "form" ? (c.body.value as Record<string, string>) : {},
      ),
      basic = basicAuth(c.request)
    const clientId = basic?.username ?? body.get("client_id") ?? "",
      client = this.clients.get(clientId)
    if (!client || client.secret !== (basic?.password ?? body.get("client_secret")))
      return oauthError("invalid_client", "Client authentication failed.", basic ? 401 : 400)
    const settings = this.settings()
    let userId: string,
      refreshToken: string | undefined
    if (body.get("grant_type") === "refresh_token") {
      const previous = this.grants
        .list({ order: "oldest" })
        .map((r) => r.value)
        .find(
          (g) =>
            g.refreshToken &&
            g.refreshToken === body.get("refresh_token") &&
            g.clientId === clientId,
        )
      if (!previous || !this.users.get(previous.userId)?.registered)
        return oauthError("invalid_grant", "Invalid refresh_token.")
      userId = previous.userId
      if (settings.rotateRefreshTokens) {
        refreshToken = this.ids.next("mock_garmin_refresh")
        this.grants.update(previous.token, { ...previous, refreshToken: "" })
      } else refreshToken = previous.refreshToken
    } else if (body.get("grant_type") === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "")
      if (
        !code ||
        code.clientId !== clientId ||
        code.expiresAt <= this.now() ||
        code.redirectUri !== (body.get("redirect_uri") ?? undefined)
      )
        return oauthError("invalid_grant", "Invalid authorization code.")
      const verifier = body.get("code_verifier") ?? ""
      if (
        verifier.length < 43 ||
        verifier.length > 128 ||
        (await sha256Challenge(verifier)) !== code.challenge
      )
        return oauthError("invalid_grant", "Invalid code_verifier.")
      // Hashing yielded: re-check before the synchronous claim to reject a concurrent replay.
      if (!this.codes.has(code.code) || code.expiresAt <= this.now())
        return oauthError("invalid_grant", "Authorization code already used or expired.")
      this.codes.delete(code.code)
      userId = code.userId
      this.putUser({ userId, registered: true })
      refreshToken = this.ids.next("mock_garmin_refresh")
    } else return oauthError("unsupported_grant_type", "Unsupported grant_type.")
    const token = this.ids.next("mock_garmin_access")
    this.grants.insert(token, {
      token,
      refreshToken: refreshToken ?? "",
      clientId,
      userId,
      expiresAt: this.now() + settings.tokenTtlSeconds * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      token_type: "bearer",
      expires_in: settings.tokenTtlSeconds,
      ...(settings.rotateRefreshTokens || body.get("grant_type") === "authorization_code"
        ? { refresh_token: refreshToken }
        : {}),
    })
  }

  // ---- Health API -----------------------------------------------------------------------------

  /** The user behind a live bearer token, or undefined for a missing, unknown, expired or deregistered one. */
  private authenticate(request: Request): GarminUser | undefined {
    const grant = this.grants.get(bearerToken(request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return undefined
    const user = this.users.get(grant.userId)
    return user?.registered ? user : undefined
  }

  private userId(c: OperationContext): Response {
    const user = this.authenticate(c.request)
    return user ? jsonRes(200, { userId: user.userId }) : unauthorized()
  }

  private backfill(c: OperationContext): Response {
    const user = this.authenticate(c.request)
    if (!user) return unauthorized()
    const type = c.params.type ?? ""
    if (!isSummaryType(type)) return apiError(404, "not_found", `Unknown backfill type ${type}.`)
    const q = c.url.searchParams,
      raw = [q.get("summaryStartTimeInSeconds"), q.get("summaryEndTimeInSeconds")]
    if (!raw.every((v) => v !== null && /^\d+$/.test(v)))
      return apiError(
        400,
        "invalid_request",
        "summaryStartTimeInSeconds and summaryEndTimeInSeconds must be integer seconds.",
      )
    const [start, end] = raw.map(Number) as [number, number]
    if (end <= start)
      return apiError(400, "invalid_request", "summaryEndTimeInSeconds must be after the start.")
    if (end - start > MAX_BACKFILL_SECONDS)
      return apiError(400, "invalid_request", "A backfill window may cover at most 90 days.")
    const key = `${user.userId}|${type}|${start}|${end}`
    if (this.backfills.has(key))
      return apiError(409, "duplicate_request", "This window was already requested for this type.")
    let notificationId: string | null = null
    const found = this.summariesIn(user.userId, type, start, end)
    if (found.length > 0) {
      notificationId = this.ids.next("mock_garmin_notification")
      const notification: Notification = {
        id: notificationId,
        userId: user.userId,
        type,
        start,
        end,
        mode: user.delivery,
        state: "pending",
        items: found.length,
        body:
          user.delivery === "push"
            ? { [type]: found.map((s) => ({ ...s.data, userId: s.userId })) }
            : { [type]: [{ userId: user.userId, callbackURL: this.callbackUrl(c, user.userId, type, start, end) }] },
      }
      this.notifications.insert(notificationId, notification)
      if (this.settings().autoDeliver) this.send(notification)
    }
    this.backfills.insert(key, {
      key,
      userId: user.userId,
      type,
      start,
      end,
      requestedAt: this.now(),
      notificationId,
    })
    return annotateResponse(new Response(null, { status: 202 }), {
      ids: { userId: user.userId, ...(notificationId ? { notificationId } : {}) },
    })
  }

  /** The unauthenticated URL a ping notification carries; it names the namespace in its path. */
  private callbackUrl(
    c: OperationContext,
    userId: string,
    type: SummaryType,
    start: number,
    end: number,
  ): string {
    const token = this.ids.next("mock_garmin_callback")
    this.callbacks.insert(token, { token, userId, type, start, end })
    const origin = (this.settings().publicUrl ?? c.url.origin).replace(/\/+$/, ""),
      prefix =
        this.publicNamespace === DEFAULT_NAMESPACE
          ? ""
          : `${this.adminPrefix}/ns/${encodeURIComponent(this.publicNamespace)}`
    return `${origin}${prefix}/wellness-api/rest/${type}?uploadStartTimeInSeconds=${start}&uploadEndTimeInSeconds=${end}&token=${token}`
  }

  private callback(c: OperationContext): Response {
    const callback = this.callbacks.get(c.url.searchParams.get("token") ?? "")
    if (
      !callback ||
      callback.type !== c.params.type ||
      !this.users.get(callback.userId)?.registered
    )
      return unauthorized()
    return jsonRes(
      200,
      this.summariesIn(callback.userId, callback.type, callback.start, callback.end).map((s) => ({
        ...s.data,
        userId: s.userId,
      })),
    )
  }

  private deregister(c: OperationContext): Response {
    const user = this.authenticate(c.request)
    if (!user) return unauthorized()
    this.users.update(user.userId, { ...user, registered: false })
    return annotateResponse(new Response(null, { status: 204 }), { ids: { userId: user.userId } })
  }
}
