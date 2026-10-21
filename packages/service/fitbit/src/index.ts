import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  basicAuth,
  bearerToken,
  bootSqlite,
  Collection,
  createService,
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
export type { FitbitRuntime, FitbitRuntimeOptions } from "./runtime.js"
export { createRuntime, FITBIT_PRESETS } from "./runtime.js"
export const FITBIT_NAMESPACE = "fitbit"
/** Every scope the authorize page accepts (the vendor's documented list). */
export const FITBIT_SCOPES = [
  "activity",
  "cardio_fitness",
  "electrocardiogram",
  "heartrate",
  "location",
  "nutrition",
  "oxygen_saturation",
  "profile",
  "respiratory_rate",
  "settings",
  "sleep",
  "social",
  "temperature",
  "weight",
] as const
export const ACCESS_TOKEN_SECONDS = 28800
export const CODE_SECONDS = 600
export type Client = { id: string; secret: string; redirectUris?: string[] }
export type User = { encodedId: string; profile?: Record<string, unknown> }
export type Grant = {
  token: string
  refreshToken: string
  clientId: string
  userId: string
  scopes: string[]
  expiresAt: number
}
export type OAuthCode = {
  code: string
  clientId: string
  userId: string
  scopes: string[]
  redirectUri?: string
  challenge?: string
  expiresAt: number
}
export type ActivityLogEntry = { logId: number; startTime: string } & Record<string, unknown>
export type SleepLogEntry = {
  logId: number
  startTime: string
  endTime: string
  dateOfSleep?: string
} & Record<string, unknown>
export type ActivityLog = { userId: string; log: ActivityLogEntry }
export type SleepLog = { userId: string; log: SleepLogEntry }
export type DailySummary = {
  userId: string
  date: string
  activities?: Record<string, unknown>[]
  goals?: Record<string, unknown>
  summary?: Record<string, unknown>
}
/** What the authorize page does: redirect with a code, or with an error. */
export type Consent = { mode: "approve" | "deny" | "error"; userId?: string }
export type FitbitAPIOptions = APIOptions & {
  clients?: Client[]
  users?: User[]
  grants?: Grant[]
  codes?: OAuthCode[]
  activityLogs?: ActivityLog[]
  sleepLogs?: SleepLog[]
  dailySummaries?: DailySummary[]
  consent?: Consent
}
const GUIDE = "Visit https://dev.fitbit.com/docs/oauth2 for more information."
const DEFAULT_GOALS = {
  activeMinutes: 30,
  caloriesOut: 2000,
  distance: 8.05,
  floors: 10,
  steps: 10000,
}
const DEFAULT_SUMMARY = {
  activityCalories: 0,
  caloriesBMR: 0,
  caloriesOut: 0,
  distances: [],
  elevation: 0,
  fairlyActiveMinutes: 0,
  floors: 0,
  lightlyActiveMinutes: 0,
  marginalCalories: 0,
  sedentaryMinutes: 1440,
  steps: 0,
  veryActiveMinutes: 0,
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.\d+)?)?$/

/** Fitbit's error envelope: `{ errors: [{ errorType, message, fieldName? }], success: false }`. */
export const fitbitError = (
  status: number,
  errorType: string,
  message: string,
  fieldName?: string,
  headers: Record<string, string> = {},
) =>
  jsonRes(
    status,
    { errors: [{ errorType, message, ...(fieldName ? { fieldName } : {}) }], success: false },
    headers,
  )
const validation = (fieldName: string, message: string) =>
  fitbitError(400, "validation", message, fieldName)
const validDate = (value: string) => {
  const match = DATE.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number) as [number, number, number, number]
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  )
}
const page = (status: number, message: string) =>
  new Response(`<!doctype html><title>Fitbit</title><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
const redirect = (target: string, params: Record<string, string | undefined>) => {
  const url = new URL(target)
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value)
  return new Response(null, { status: 302, headers: { location: url.toString() } })
}
const minutes = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class FitbitAPI implements FetchAPI {
  readonly app: Hono
  readonly clients: Collection<Client>
  readonly users: Collection<User>
  readonly grants: Collection<Grant>
  readonly codes: Collection<OAuthCode>
  readonly activityLogs: Collection<ActivityLog>
  readonly sleepLogs: Collection<SleepLog>
  readonly dailySummaries: Collection<DailySummary>
  readonly settings: Collection<Consent>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: Required<
    Pick<
      FitbitAPIOptions,
      "clients" | "users" | "grants" | "codes" | "activityLogs" | "sleepLogs" | "dailySummaries"
    >
  > & { consent: Consent }
  constructor(options: FitbitAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? FITBIT_NAMESPACE
    this.now = options.now ?? Date.now
    this.clients = new Collection(sqlite, namespace, "clients")
    this.users = new Collection(sqlite, namespace, "users")
    this.grants = new Collection(sqlite, namespace, "grants")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.activityLogs = new Collection(sqlite, namespace, "activity_logs")
    this.sleepLogs = new Collection(sqlite, namespace, "sleep_logs")
    this.dailySummaries = new Collection(sqlite, namespace, "daily_summaries")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.fixtures = structuredClone({
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      users: options.users ?? [{ encodedId: "ABC123" }],
      grants: options.grants ?? [
        {
          token: "mock_fitbit_token",
          refreshToken: "mock_fitbit_refresh",
          clientId: "mock_client",
          userId: "ABC123",
          scopes: [...FITBIT_SCOPES],
          expiresAt: 4102444800000,
        },
      ],
      codes: options.codes ?? [],
      activityLogs: options.activityLogs ?? [],
      sleepLogs: options.sleepLogs ?? [],
      dailySummaries: options.dailySummaries ?? [],
      consent: options.consent ?? { mode: "approve" },
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => fitbitError(404, "not_found", "Not Found"),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        Authorize: (c) => this.authorize(c),
        OAuthToken: (c) => this.exchange(c),
        RevokeToken: (c) => this.revoke(c),
        GetProfile: (c) => this.profile(c),
        ListActivityLogs: (c) => this.listActivityLogs(c),
        GetDailyActivitySummary: (c) => this.dailySummary(c),
        GetSleepByDate: (c) => this.sleepByDate(c),
        GetSleepByDateV12: (c) => this.sleepByDate(c),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const u of this.fixtures.users) this.users.insert(u.encodedId, u)
    for (const g of this.fixtures.grants) this.grants.insert(g.token, g)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    for (const a of this.fixtures.activityLogs) this.addActivityLog(a.userId, a.log)
    for (const s of this.fixtures.sleepLogs) this.addSleepLog(s.userId, s.log)
    for (const d of this.fixtures.dailySummaries) this.setDailySummary(d)
    this.settings.insert("consent", this.fixtures.consent)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  /** Seed controls, also used by the admin routes. A log with an existing `logId` is replaced. */
  addActivityLog(userId: string, log: ActivityLogEntry) {
    this.activityLogs.insert(`${userId}:${log.logId}`, { userId, log })
  }
  addSleepLog(userId: string, log: SleepLogEntry) {
    this.sleepLogs.insert(`${userId}:${log.logId}`, { userId, log })
  }
  setDailySummary(summary: DailySummary) {
    this.dailySummaries.insert(`${summary.userId}:${summary.date}`, summary)
  }
  setConsent(consent: Consent) {
    this.settings.insert("consent", consent)
  }
  /** Make every access token of a user expired now; refresh tokens stay usable. */
  expireTokens(userId: string): number {
    let count = 0
    for (const { value } of this.grants.list({ order: "oldest" }))
      if (value.userId === userId) {
        this.grants.update(value.token, { ...value, expiresAt: this.now() })
        count += 1
      }
    return count
  }
  /** Remove every access and refresh token of a user (what revocation does). */
  revokeTokens(userId: string, clientId?: string): number {
    let count = 0
    for (const { value } of this.grants.list({ order: "oldest" }))
      if (value.userId === userId && (clientId === undefined || value.clientId === clientId)) {
        this.grants.delete(value.token)
        count += 1
      }
    return count
  }

  // --- OAuth -------------------------------------------------------------------------------
  private authorize(c: OperationContext): Response {
    const q = c.url.searchParams
    const client = this.clients.get(q.get("client_id") ?? "")
    if (!client) return page(400, "The client_id is not registered.")
    const sent = q.get("redirect_uri") ?? undefined,
      target = sent ?? client.redirectUris?.[0]
    if (!target || (client.redirectUris && !client.redirectUris.includes(target)))
      return page(400, "The redirect_uri does not match the application.")
    if (!URL.canParse(target)) return page(400, "The redirect_uri is not a URL.")
    const state = q.get("state") ?? undefined
    const fail = (error: string, description: string) =>
      redirect(target, { error, error_description: description, state })
    if (q.get("response_type") !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.")
    const scopes = (q.get("scope") ?? "").split(/\s+/).filter(Boolean)
    if (scopes.length === 0) return fail("invalid_scope", "scope is required.")
    const unknown = scopes.find((s) => !(FITBIT_SCOPES as readonly string[]).includes(s))
    if (unknown) return fail("invalid_scope", `Unknown scope ${unknown}.`)
    const challenge = q.get("code_challenge") ?? undefined,
      method = q.get("code_challenge_method")
    if (challenge !== undefined || method !== null) {
      if (method !== "S256") return fail("invalid_request", "code_challenge_method must be S256.")
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        return fail("invalid_request", "code_challenge must be a 43 character S256 digest.")
    }
    const consent = this.settings.get("consent") ?? { mode: "approve" }
    if (consent.mode === "deny") return fail("access_denied", "The user denied the request.")
    if (consent.mode === "error")
      return fail("server_error", "The authorization server encountered an error.")
    const userId = consent.userId ?? this.users.list({ order: "oldest" })[0]?.value.encodedId
    if (!userId || !this.users.has(userId))
      return fail("server_error", "No Fitbit user is seeded to consent.")
    const code = this.ids.next("fitbit_code")
    this.codes.insert(code, {
      code,
      clientId: client.id,
      userId,
      scopes,
      ...(sent ? { redirectUri: sent } : {}),
      ...(challenge ? { challenge } : {}),
      expiresAt: this.now() + CODE_SECONDS * 1000,
    })
    return redirect(target, { code, state })
  }
  private async exchange(c: OperationContext): Promise<Response> {
    const basic = basicAuth(c.request),
      client = basic ? this.clients.get(basic.username) : undefined
    if (!basic || !client || client.secret !== basic.password)
      return fitbitError(401, "invalid_client", `Invalid client credentials. ${GUIDE}`)
    if (!c.request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      return fitbitError(400, "invalid_request", "Expected a form encoded body.")
    const body = new URLSearchParams(
      c.body.kind === "form" ? (c.body.value as Record<string, string>) : {},
    )
    if (body.has("client_id") && body.get("client_id") !== client.id)
      return fitbitError(401, "invalid_client", `Invalid client credentials. ${GUIDE}`)
    let userId: string, scopes: string[]
    const grantType = body.get("grant_type")
    if (grantType === "refresh_token") {
      const previous = this.grants
        .list({ order: "oldest" })
        .map((r) => r.value)
        .find((g) => g.refreshToken === body.get("refresh_token") && g.clientId === client.id)
      if (!body.get("refresh_token") || !previous)
        return fitbitError(400, "invalid_grant", `Refresh token invalid. ${GUIDE}`)
      userId = previous.userId
      scopes = previous.scopes
      // Single-use rotation: the old pair stops working the moment the new one exists.
      this.grants.delete(previous.token)
    } else if (grantType === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "")
      const invalid = () =>
        fitbitError(400, "invalid_grant", `Authorization code invalid or expired. ${GUIDE}`)
      if (
        !code ||
        code.clientId !== client.id ||
        code.expiresAt <= this.now() ||
        code.redirectUri !== (body.get("redirect_uri") ?? undefined)
      )
        return invalid()
      if (code.challenge) {
        const verifier = body.get("code_verifier") ?? ""
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
        )
        const encoded = btoa(String.fromCharCode(...digest))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "")
        if (verifier.length < 43 || verifier.length > 128 || encoded !== code.challenge)
          return fitbitError(400, "invalid_grant", `code_verifier does not match. ${GUIDE}`)
      }
      // The digest yielded: re-check before the synchronous claim to reject a concurrent replay.
      if (!this.codes.has(code.code)) return invalid()
      this.codes.delete(code.code)
      userId = code.userId
      scopes = code.scopes
    } else
      return fitbitError(
        400,
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token.",
      )
    const token = this.ids.next("fitbit_access"),
      refreshToken = this.ids.next("fitbit_refresh")
    this.grants.insert(token, {
      token,
      refreshToken,
      clientId: client.id,
      userId,
      scopes,
      expiresAt: this.now() + ACCESS_TOKEN_SECONDS * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_SECONDS,
      token_type: "Bearer",
      scope: scopes.join(" "),
      user_id: userId,
    })
  }
  private revoke(c: OperationContext): Response {
    const basic = basicAuth(c.request),
      client = basic ? this.clients.get(basic.username) : undefined
    if (!basic || !client || client.secret !== basic.password)
      return fitbitError(401, "invalid_client", `Invalid client credentials. ${GUIDE}`)
    const token =
      c.body.kind === "form" ? (c.body.value as Record<string, string>).token : undefined
    if (!token) return fitbitError(400, "invalid_request", "token is required.", "token")
    const grant = this.grants
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find((g) => g.clientId === client.id && (g.token === token || g.refreshToken === token))
    if (grant) this.revokeTokens(grant.userId, client.id)
    return jsonRes(200, {})
  }

  // --- Data --------------------------------------------------------------------------------
  /** The grant behind the bearer token, or the 401/403 the vendor would answer. */
  private session(c: OperationContext, scope: string): { grant: Grant } | { response: Response } {
    const token = bearerToken(c.request)
    if (!token)
      return {
        response: fitbitError(401, "invalid_token", "Authorization header missing or invalid."),
      }
    const grant = this.grants.get(token)
    if (!grant)
      return { response: fitbitError(401, "invalid_token", `Access token invalid. ${GUIDE}`) }
    if (grant.expiresAt <= this.now())
      return { response: fitbitError(401, "expired_token", `Access token expired. ${GUIDE}`) }
    if (!grant.scopes.includes(scope))
      return {
        response: fitbitError(
          403,
          "insufficient_scope",
          `This application does not have permission to access this resource. Required scope: ${scope}.`,
        ),
      }
    const user = c.params.userId
    if (user !== "-" && user !== grant.userId)
      return {
        response: fitbitError(
          403,
          "insufficient_permissions",
          "This application does not have permission to access this user's data.",
        ),
      }
    return { grant }
  }
  private day(value: string): string | undefined {
    if (value === "today") return new Date(this.now()).toISOString().slice(0, 10)
    return validDate(value) ? value : undefined
  }
  private profile(c: OperationContext): Response {
    const session = this.session(c, "profile")
    if ("response" in session) return session.response
    const encodedId = session.grant.userId,
      stored = this.users.get(encodedId)
    return jsonRes(200, {
      user: {
        displayName: "Synthetic User",
        fullName: "Synthetic User",
        locale: "en_US",
        timezone: "America/Los_Angeles",
        ...stored?.profile,
        encodedId,
      },
    })
  }
  private listActivityLogs(c: OperationContext): Response {
    const session = this.session(c, "activity")
    if ("response" in session) return session.response
    const q = c.url.searchParams,
      after = q.get("afterDate"),
      before = q.get("beforeDate"),
      sort = q.get("sort")
    if ((after === null) === (before === null))
      return validation("afterDate", "Exactly one of afterDate or beforeDate is required.")
    const anchorName = after === null ? "beforeDate" : "afterDate",
      anchor = (after ?? before) as string,
      parts = DATE_TIME.exec(anchor)
    if (!parts?.[1] || !validDate(parts[1]))
      return validation(anchorName, `${anchorName} must be yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss.`)
    const key = `${parts[1]}T${parts[2] ?? "00:00:00"}`
    if (sort !== (after === null ? "desc" : "asc"))
      return validation(
        "sort",
        `sort must be ${after === null ? "desc with beforeDate" : "asc with afterDate"}.`,
      )
    const integer = (name: string, min: number, max: number) => {
      const raw = q.get(name)
      if (raw === null || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
        return undefined
      return Number(raw)
    }
    const limit = integer("limit", 1, 100),
      offset = integer("offset", 0, Number.MAX_SAFE_INTEGER)
    if (limit === undefined) return validation("limit", "limit must be an integer from 1 to 100.")
    if (offset === undefined) return validation("offset", "offset must be a non-negative integer.")
    const local = (log: ActivityLogEntry) => String(log.startTime).slice(0, 19)
    const rows = this.activityLogs
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.userId === session.grant.userId)
      .map((r) => r.log)
      .filter((log) => (after === null ? local(log) < key : local(log) >= key))
      .sort(
        (a, b) =>
          (local(a) < local(b) ? -1 : local(a) > local(b) ? 1 : a.logId - b.logId) *
          (after === null ? -1 : 1),
      )
    const link = (at: number) => {
      const next = new URLSearchParams({
        [anchorName]: anchor,
        offset: String(at),
        limit: String(limit),
        sort: sort as string,
      })
      return `${c.url.origin}${c.url.pathname}?${next}`
    }
    const slice = rows.slice(offset, offset + limit)
    return jsonRes(200, {
      activities: slice,
      pagination: {
        [anchorName]: anchor,
        limit,
        next: offset + limit < rows.length ? link(offset + limit) : "",
        offset,
        previous: offset > 0 ? link(Math.max(0, offset - limit)) : "",
        sort,
      },
    })
  }
  private dailySummary(c: OperationContext): Response {
    const session = this.session(c, "activity")
    if ("response" in session) return session.response
    const date = this.day(c.params.date ?? "")
    if (!date) return validation("date", "date must be yyyy-MM-dd.")
    const stored = this.dailySummaries.get(`${session.grant.userId}:${date}`)
    return jsonRes(200, {
      activities: stored?.activities ?? [],
      goals: { ...DEFAULT_GOALS, ...stored?.goals },
      summary: { ...DEFAULT_SUMMARY, ...stored?.summary },
    })
  }
  private sleepByDate(c: OperationContext): Response {
    const session = this.session(c, "sleep")
    if ("response" in session) return session.response
    const date = this.day(c.params.date ?? "")
    if (!date) return validation("date", "date must be yyyy-MM-dd.")
    const sleep = this.sleepLogs
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.userId === session.grant.userId)
      .map((r) => r.log)
      // A log belongs to the day it ended on, so one that began yesterday evening is included.
      .filter((log) => (log.dateOfSleep ?? String(log.endTime).slice(0, 10)) === date)
      .sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0))
    const stageSummaries = sleep
      .map((log) => (isRecord(log.levels) ? log.levels.summary : undefined))
      .filter(isRecord)
    const stage = (name: string) =>
      stageSummaries.reduce(
        (sum, s) => sum + minutes(isRecord(s[name]) ? s[name].minutes : undefined),
        0,
      )
    return jsonRes(200, {
      sleep,
      summary: {
        ...(stageSummaries.length > 0
          ? {
              stages: {
                deep: stage("deep"),
                light: stage("light"),
                rem: stage("rem"),
                wake: stage("wake"),
              },
            }
          : {}),
        totalMinutesAsleep: sleep.reduce((sum, log) => sum + minutes(log.minutesAsleep), 0),
        totalSleepRecords: sleep.length,
        totalTimeInBed: sleep.reduce((sum, log) => sum + minutes(log.timeInBed), 0),
      },
    })
  }
}
