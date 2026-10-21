import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  basicAuth,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { SuuntoRuntime, SuuntoRuntimeOptions } from "./runtime.js"
export { createRuntime, SUUNTO_PRESETS } from "./runtime.js"

export const SUUNTO_NAMESPACE = "suunto"
/** The access token seeded for the first user, so the first request needs no OAuth round trip. */
export const DEFAULT_ACCESS_TOKEN = "mock_suunto_token"
export const DEFAULT_REFRESH_TOKEN = "mock_suunto_refresh"
export const DEFAULT_USER: User = {
  subject: "00000000-0000-4000-8000-000000000001",
  username: "mock_user",
}
export const DEFAULT_CLIENT: Client = {
  clientId: "mock_client",
  clientSecret: "mock_client_secret",
  redirectUris: [],
}
const DAY_MS = 86_400_000
/** Epoch values from here up are read as milliseconds, below it as seconds (`since`). */
const MILLISECONDS_FROM = 1e11

export type User = { subject: string; username: string }
/** An OAuth app. An empty `redirectUris` accepts any redirect URI. */
export type Client = { clientId: string; clientSecret: string; redirectUris: string[] }
export type Settings = {
  /** The gateway's subscription key; `null` accepts data requests without one. */
  subscriptionKey: string | null
  /** Access-token lifetime on the mock clock (`expires_in`). Default 86400. */
  accessTokenTtlSeconds: number
  /** Authorization-code lifetime. Default 600. */
  codeTtlSeconds: number
  /** What the consent page does: approve, deny (`access_denied`) or fail (`server_error`). */
  consent: "approve" | "deny" | "error"
  /** The username consent approves as; `null` is the first user. */
  consentUser: string | null
  /** The `scope` the token response reports. */
  scope: string
  /** Whether a refresh issues a new refresh token and spends the old one. Default false. */
  rotateRefreshTokens: boolean
  /** The longest window the 24/7 routes accept, in days. Default 28. */
  maxWindowDays: number
}
export const DEFAULT_SETTINGS: Settings = {
  subscriptionKey: null,
  accessTokenTtlSeconds: 86_400,
  codeTtlSeconds: 600,
  consent: "approve",
  consentUser: null,
  scope: "workout",
  rotateRefreshTokens: false,
  maxWindowDays: 28,
}
export type Grant = {
  accessToken: string
  subject: string
  clientId: string | null
  expiresAt: number
}
export type RefreshGrant = {
  token: string
  subject: string
  clientId: string | null
  revoked: boolean
}
export type AuthorizationCode = {
  code: string
  clientId: string
  redirectUri: string
  subject: string
  expiresAt: number
}
/** The fields every workout carries; anything else is passed through as seeded. */
export type WorkoutFields = {
  workoutId: number
  activityId: number
  /** Epoch milliseconds. */
  startTime: number
  /** Epoch milliseconds. */
  stopTime: number
  /** Seconds. */
  totalTime: number
  [field: string]: unknown
}
export type Workout = {
  subject: string
  workoutKey: string
  /** Epoch milliseconds; `filter-by-modification-time` compares `since` with it. */
  modifiedAt: number
  workout: WorkoutFields
}
/** A workout to seed: `subject` defaults to the first user, `modifiedAt` to `stopTime`. */
export type SeedWorkout = WorkoutFields & { subject?: string; modifiedAt?: number }
export type Sample = { subject: string; timestamp: number; entryData: Record<string, unknown> }
export type SeedSample = {
  subject?: string
  /** Epoch milliseconds. */
  timestamp: number
  entryData: Record<string, unknown>
}
export type DailyStatistic = {
  subject: string
  name: string
  aggregation: string
  source: string
  /** `TimeISO8601` as the response reports it. */
  time: string
  value: number
}
export type SeedDailyStatistic = Partial<
  Pick<DailyStatistic, "subject" | "aggregation" | "source">
> &
  Pick<DailyStatistic, "name" | "time" | "value">
export type SuuntoAPIOptions = APIOptions & {
  users?: User[]
  clients?: Client[]
  workouts?: SeedWorkout[]
  sleepSamples?: SeedSample[]
  activitySamples?: SeedSample[]
  dailyStatistics?: SeedDailyStatistic[]
  settings?: Partial<Settings>
}

/** Azure API Management style gateway rejection: `{statusCode, message}`. */
export const gatewayError = (status: number, message: string) =>
  jsonRes(status, { statusCode: status, message })
/** The API's own error: `{error, code}` (the consumer reads `code` as the status). */
export const apiError = (status: number, message: string) =>
  jsonRes(status, { error: message, code: status, payload: null })
/** OAuth error: `{error, error_description}`. */
export const oauthError = (status: number, error: string, description: string) =>
  jsonRes(status, { error, error_description: description })

const MISSING_KEY =
  "Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API."
const INVALID_KEY =
  "Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription."
const BAD_TOKEN = "Unauthorized. Access token is missing or invalid."

const base64url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
/** A JWT with a deterministic stand-in signature: consumers read the claims and never verify it. */
const jwt = (claims: Record<string, unknown>) => {
  const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`
  return `${head}.${opaqueToken(head, 43)}`
}

/** The token a request carries, with or without the `Bearer ` word (Suunto's own curl example omits it). */
export const accessToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")?.trim()
  if (!header) return undefined
  return header.replace(/^Bearer\s+/i, "").trim() || undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

/** A non-negative integer query value, `undefined` when absent, `null` when malformed. */
const integerParam = (value: string | null): number | undefined | null => {
  if (value === null || value === "") return undefined
  return /^\d+$/.test(value) ? Number(value) : null
}

/** `YYYY-MM-DDTHH:MM:SS` (or a date, or with an offset) as epoch milliseconds; no offset means UTC. */
export const parseDate = (value: string): number | undefined => {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value.trim(),
    )
  if (!match) return undefined
  const zone = match[3] ?? "Z"
  const time = Date.parse(
    `${match[1]}T${match[2] ?? "00:00:00"}${/^z$/i.test(zone) ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`,
  )
  return Number.isNaN(time) ? undefined : time
}

const workoutProblem = (workout: Record<string, unknown>): string | undefined => {
  for (const field of ["workoutId", "activityId"])
    if (!Number.isInteger(workout[field])) return `${field} must be an integer`
  for (const field of ["startTime", "stopTime", "totalTime"])
    if (!finite(workout[field])) return `${field} must be a number`
  return undefined
}

/**
 * Stateful emulator of the Suunto Cloud API: users with OAuth tokens (JWTs carrying `sub` and
 * `user`), workouts, and 24/7 sleep, activity and daily-statistics samples, behind a gateway
 * that checks the subscription key before it looks at the token.
 */
export class SuuntoAPI implements FetchAPI {
  readonly app: Hono
  readonly users: Collection<User>
  readonly clients: Collection<Client>
  readonly codes: Collection<AuthorizationCode>
  readonly grants: Collection<Grant>
  readonly refreshGrants: Collection<RefreshGrant>
  readonly workouts: Collection<Workout>
  readonly sleepSamples: Collection<Sample>
  readonly activitySamples: Collection<Sample>
  readonly dailyStatistics: Collection<DailyStatistic>
  readonly settings: Collection<Settings>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: {
    users: User[]
    clients: Client[]
    workouts: SeedWorkout[]
    sleepSamples: SeedSample[]
    activitySamples: SeedSample[]
    dailyStatistics: SeedDailyStatistic[]
    settings: Partial<Settings>
  }

  constructor(options: SuuntoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? SUUNTO_NAMESPACE
    this.now = options.now ?? Date.now
    this.users = new Collection(sqlite, namespace, "users")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.grants = new Collection(sqlite, namespace, "grants")
    this.refreshGrants = new Collection(sqlite, namespace, "refresh_grants")
    this.workouts = new Collection(sqlite, namespace, "workouts")
    this.sleepSamples = new Collection(sqlite, namespace, "sleep_samples")
    this.activitySamples = new Collection(sqlite, namespace, "activity_samples")
    this.dailyStatistics = new Collection(sqlite, namespace, "daily_statistics")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.fixtures = structuredClone({
      users: options.users ?? [DEFAULT_USER],
      clients: options.clients ?? [DEFAULT_CLIENT],
      workouts: options.workouts ?? [],
      sleepSamples: options.sleepSamples ?? [],
      activitySamples: options.activitySamples ?? [],
      dailyStatistics: options.dailyStatistics ?? [],
      settings: options.settings ?? {},
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => gatewayError(404, "Resource not found"),
      onError: (error) => {
        throw error
      },
      before: (context) => this.gateway(context),
      handlers: defineOperations<SupportedOperationId>({
        Authorize: (c) => this.authorize(c),
        OAuthToken: (c) => this.token(c),
        ListWorkouts: (c) => this.listWorkouts(c),
        GetWorkout: (c) => this.getWorkout(c),
        ListSleepSamples: (c) => this.listSamples(c, this.sleepSamples),
        ListActivitySamples: (c) => this.listSamples(c, this.activitySamples),
        ListDailyActivityStatistics: (c) => this.listStatistics(c),
      }),
    })
    this.app = this.service.app
  }

  private seed() {
    if (this.initialized.has("seed")) return
    this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.fixtures.settings })
    for (const user of this.fixtures.users) this.users.insert(user.subject, user)
    for (const client of this.fixtures.clients) this.clients.insert(client.clientId, client)
    const first = this.fixtures.users[0]
    if (first) {
      this.grants.insert(DEFAULT_ACCESS_TOKEN, {
        accessToken: DEFAULT_ACCESS_TOKEN,
        subject: first.subject,
        clientId: this.fixtures.clients[0]?.clientId ?? null,
        expiresAt: 4_102_444_800_000,
      })
      this.refreshGrants.insert(DEFAULT_REFRESH_TOKEN, {
        token: DEFAULT_REFRESH_TOKEN,
        subject: first.subject,
        clientId: this.fixtures.clients[0]?.clientId ?? null,
        revoked: false,
      })
    }
    for (const workout of this.fixtures.workouts) this.seedWorkout(workout)
    for (const sample of this.fixtures.sleepSamples) this.seedSample("sleep", sample)
    for (const sample of this.fixtures.activitySamples) this.seedSample("activity", sample)
    for (const stat of this.fixtures.dailyStatistics) this.seedStatistic(stat)
    this.initialized.insert("seed", { value: true })
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** The subject seeds without one belong to: the first user. */
  private defaultSubject(): string {
    return this.users.list({ order: "oldest" })[0]?.value.subject ?? ""
  }

  /** Add a workout; throws a message naming the field when a required one is missing. */
  seedWorkout(seed: SeedWorkout): Workout {
    const { subject, modifiedAt, ...fields } = seed
    const problem = workoutProblem(fields)
    if (problem) throw new Error(`workout ${String(fields.workoutId)}: ${problem}`)
    const workout: Workout = {
      subject: subject ?? this.defaultSubject(),
      workoutKey:
        typeof fields.workoutKey === "string" ? fields.workoutKey : String(fields.workoutId),
      modifiedAt: modifiedAt ?? fields.stopTime,
      workout: fields,
    }
    this.workouts.insert(`${workout.subject}:${workout.workoutKey}`, workout)
    return workout
  }

  /** Add a 24/7 sample; a second one at the same timestamp for the same user replaces it. */
  seedSample(kind: "sleep" | "activity", seed: SeedSample): Sample {
    if (!finite(seed.timestamp) || !isRecord(seed.entryData))
      throw new Error("sample: timestamp (number) and entryData (object) are required")
    const sample = { subject: seed.subject ?? this.defaultSubject(), ...seed }
    ;(kind === "sleep" ? this.sleepSamples : this.activitySamples).insert(
      `${sample.subject}:${sample.timestamp}`,
      sample,
    )
    return sample
  }

  /** Add a daily-statistics sample. */
  seedStatistic(seed: SeedDailyStatistic): DailyStatistic {
    if (typeof seed.name !== "string" || parseDate(seed.time) === undefined || !finite(seed.value))
      throw new Error("statistic: name, time (YYYY-MM-DDTHH:MM:SS) and value (number) are required")
    const stat = {
      subject: this.defaultSubject(),
      aggregation: "Sum",
      source: "Suunto",
      ...seed,
    }
    this.dailyStatistics.insert(`${stat.subject}:${stat.name}:${stat.source}:${stat.time}`, stat)
    return stat
  }

  /** The user a consent approves as. */
  consentingUser(): User | undefined {
    const username = this.current().consentUser
    const users = this.users.list({ order: "oldest" }).map((r) => r.value)
    return username === null ? users[0] : users.find((u) => u.username === username)
  }

  /**
   * Mint an access and refresh token for a user: JWTs whose payload carries `sub` (the subject id)
   * and `user` (the Suunto username). `keepRefresh` reuses an existing refresh token.
   */
  issueTokens(user: User, clientId: string | null, keepRefresh?: string) {
    const settings = this.current()
    const issuedAt = Math.floor(this.now() / 1000)
    const claims = (kind: string, ttl?: number) => ({
      sub: user.subject,
      user: user.username,
      ...(clientId ? { client_id: clientId } : {}),
      scope: settings.scope,
      typ: kind,
      jti: this.ids.next("jti_", 16),
      iat: issuedAt,
      ...(ttl === undefined ? {} : { exp: issuedAt + ttl }),
    })
    const access = jwt(claims("access", settings.accessTokenTtlSeconds))
    this.grants.insert(access, {
      accessToken: access,
      subject: user.subject,
      clientId,
      expiresAt: this.now() + settings.accessTokenTtlSeconds * 1000,
    })
    const refresh = keepRefresh ?? jwt(claims("refresh"))
    if (!keepRefresh)
      this.refreshGrants.insert(refresh, {
        token: refresh,
        subject: user.subject,
        clientId,
        revoked: false,
      })
    return { access, refresh }
  }

  /** Mint a one-time authorization code (what the consent page does). */
  issueCode(user: User, clientId: string, redirectUri: string): string {
    const code = this.ids.next("code_", 24)
    this.codes.insert(code, {
      code,
      clientId,
      redirectUri,
      subject: user.subject,
      expiresAt: this.now() + this.current().codeTtlSeconds * 1000,
    })
    return code
  }

  /** Expire access tokens now: one by value, or every one when none is named. */
  expireTokens(token?: string): number {
    let expired = 0
    for (const { value } of this.grants.list()) {
      if (token !== undefined && value.accessToken !== token) continue
      this.grants.update(value.accessToken, { ...value, expiresAt: this.now() })
      expired++
    }
    return expired
  }

  /** The gateway: the subscription key is checked first, then the access token. */
  private gateway(context: OperationContext): Response | undefined {
    const id = context.operation.operationId
    if (id === "Authorize" || id === "OAuthToken") return undefined
    const expected = this.current().subscriptionKey
    if (expected !== null) {
      const key =
        context.request.headers.get("ocp-apim-subscription-key") ??
        context.url.searchParams.get("subscription-key")
      if (!key) return gatewayError(401, MISSING_KEY)
      if (key !== expected) return gatewayError(401, INVALID_KEY)
    }
    const grant = this.grants.get(accessToken(context.request) ?? "")
    if (!grant || grant.expiresAt <= this.now() || !this.users.has(grant.subject))
      return gatewayError(401, BAD_TOKEN)
    return undefined
  }

  /** The user a (gateway-checked) request is for. */
  private subject(context: OperationContext): string {
    return (this.grants.get(accessToken(context.request) ?? "") as Grant).subject
  }

  private authorize(context: OperationContext): Response {
    const q = context.url.searchParams
    const clientId = q.get("client_id")
    const redirect = q.get("redirect_uri")
    if (!clientId || !redirect)
      return oauthError(400, "invalid_request", "client_id and redirect_uri are required.")
    const client = this.clients.get(clientId)
    if (!client) return oauthError(400, "unauthorized_client", "Unknown client_id.")
    let target: URL
    try {
      target = new URL(redirect)
    } catch {
      return oauthError(400, "invalid_request", "redirect_uri is not a valid URL.")
    }
    if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirect))
      return oauthError(400, "invalid_request", "redirect_uri is not registered for this client.")
    const state = q.get("state")
    const back = (params: Record<string, string>) => {
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
      if (state !== null) target.searchParams.set("state", state)
      return new Response(null, { status: 302, headers: { location: target.toString() } })
    }
    if (q.get("response_type") !== "code")
      return back({
        error: "unsupported_response_type",
        error_description: "Only response_type=code is supported.",
      })
    const consent = this.current().consent
    if (consent === "deny")
      return back({ error: "access_denied", error_description: "The user denied the request." })
    if (consent === "error")
      return back({ error: "server_error", error_description: "The consent page failed." })
    const user = this.consentingUser()
    if (!user)
      return back({ error: "server_error", error_description: "There is no user to approve as." })
    return back({ code: this.issueCode(user, clientId, redirect) })
  }

  private token(context: OperationContext): Response {
    const basic = basicAuth(context.request)
    const client = basic ? this.clients.get(basic.username) : undefined
    if (!basic || !client || client.clientSecret !== basic.password)
      return oauthError(401, "invalid_client", "Client authentication failed.")
    const form =
      context.body.kind === "form" && isRecord(context.body.value) ? context.body.value : undefined
    if (!form) return oauthError(400, "invalid_request", "Expected a form-encoded body.")
    const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "")
    const grantType = field("grant_type")
    if (!grantType) return oauthError(400, "invalid_request", "grant_type is required.")
    if (grantType === "authorization_code") {
      const code = this.codes.get(field("code"))
      if (
        !code ||
        code.clientId !== client.clientId ||
        code.expiresAt <= this.now() ||
        code.redirectUri !== field("redirect_uri")
      )
        return oauthError(
          400,
          "invalid_grant",
          "Invalid, expired or already used authorization code.",
        )
      this.codes.delete(code.code)
      const user = this.users.get(code.subject)
      return user
        ? this.tokenResponse(user, client.clientId)
        : oauthError(400, "invalid_grant", "The user no longer exists.")
    }
    if (grantType === "refresh_token") {
      const refresh = this.refreshGrants.get(field("refresh_token"))
      if (!refresh || refresh.revoked || (refresh.clientId && refresh.clientId !== client.clientId))
        return oauthError(400, "invalid_grant", "Invalid refresh token.")
      const user = this.users.get(refresh.subject)
      if (!user) return oauthError(400, "invalid_grant", "The user no longer exists.")
      const rotate = this.current().rotateRefreshTokens
      if (rotate) this.refreshGrants.update(refresh.token, { ...refresh, revoked: true })
      return this.tokenResponse(user, client.clientId, rotate ? undefined : refresh.token)
    }
    return oauthError(400, "unsupported_grant_type", `Unsupported grant_type ${grantType}.`)
  }

  private tokenResponse(user: User, clientId: string, keepRefresh?: string): Response {
    const settings = this.current()
    const issued = this.issueTokens(user, clientId, keepRefresh)
    return jsonRes(200, {
      access_token: issued.access,
      token_type: "bearer",
      refresh_token: issued.refresh,
      expires_in: settings.accessTokenTtlSeconds,
      scope: settings.scope,
    })
  }

  private listWorkouts(context: OperationContext): Response {
    const q = context.url.searchParams
    const since = integerParam(q.get("since"))
    const limit = integerParam(q.get("limit"))
    const offset = integerParam(q.get("offset"))
    if (since === null) return apiError(400, "since must be an epoch timestamp")
    if (limit === null || limit === 0) return apiError(400, "limit must be a positive integer")
    if (offset === null) return apiError(400, "offset must be a non-negative integer")
    const filter = q.get("filter-by-modification-time")?.toLowerCase()
    if (filter !== undefined && filter !== "true" && filter !== "false")
      return apiError(400, "filter-by-modification-time must be true or false")
    const sinceMs = since === undefined ? 0 : since < MILLISECONDS_FROM ? since * 1000 : since
    const subject = this.subject(context)
    const timeOf = (w: Workout) =>
      filter === "true" ? (w.modifiedAt ?? w.workout.stopTime) : w.workout.startTime
    const rows = this.workouts
      .list({ order: "oldest", where: (w) => w.subject === subject && timeOf(w) > sinceMs })
      .map((r) => r.value)
      .sort((a, b) => timeOf(a) - timeOf(b) || a.workout.workoutId - b.workout.workoutId)
    return jsonRes(200, {
      error: null,
      payload: rows
        .slice(offset ?? 0, (offset ?? 0) + (limit ?? 100))
        .map((w) => this.publicWorkout(w)),
    })
  }

  private getWorkout(context: OperationContext): Response {
    const workout = this.workouts.get(`${this.subject(context)}:${context.params.workoutKey ?? ""}`)
    if (!workout) return apiError(404, "Workout not found")
    return jsonRes(200, { error: null, payload: this.publicWorkout(workout) })
  }

  private publicWorkout(workout: Workout) {
    return { ...workout.workout, workoutKey: workout.workoutKey }
  }

  /** `from` and `to` (epoch ms) or `startdate` and `enddate`, validated against the window limit. */
  private window(context: OperationContext, dates: boolean): [number, number] | Response {
    const q = context.url.searchParams
    const names = dates ? (["startdate", "enddate"] as const) : (["from", "to"] as const)
    const parsed = names.map((name) => {
      const raw = q.get(name)
      if (raw === null || raw === "") return `${name} is required`
      const value = dates ? parseDate(raw) : integerParam(raw)
      return value === undefined || value === null
        ? `${name} must be ${dates ? "YYYY-MM-DDTHH:MM:SS" : "epoch milliseconds"}`
        : value
    })
    const problem = parsed.find((p) => typeof p === "string")
    if (problem !== undefined) return apiError(400, problem as string)
    const [from, to] = parsed as [number, number]
    if (to < from) return apiError(400, `${names[1]} must not be before ${names[0]}`)
    const days = this.current().maxWindowDays
    if (to - from > days * DAY_MS)
      return apiError(400, `The time range must not be longer than ${days} days`)
    return [from, to]
  }

  private listSamples(context: OperationContext, collection: Collection<Sample>): Response {
    const range = this.window(context, false)
    if (range instanceof Response) return range
    const subject = this.subject(context)
    const [from, to] = range
    return jsonRes(
      200,
      collection
        .list({
          where: (s) => s.subject === subject && s.timestamp >= from && s.timestamp < to,
        })
        .map((r) => ({ timestamp: r.value.timestamp, entryData: r.value.entryData }))
        .sort((a, b) => a.timestamp - b.timestamp),
    )
  }

  private listStatistics(context: OperationContext): Response {
    const range = this.window(context, true)
    if (range instanceof Response) return range
    const subject = this.subject(context)
    const [from, to] = range
    const rows = this.dailyStatistics
      .list({
        order: "oldest",
        where: (s) => {
          const time = parseDate(s.time)
          return s.subject === subject && time !== undefined && time >= from && time < to
        },
      })
      .map((r) => r.value)
      .sort((a, b) => (parseDate(a.time) ?? 0) - (parseDate(b.time) ?? 0))
    const names = new Map<
      string,
      { Name: string; Aggregation: string; sources: Map<string, DailyStatistic[]> }
    >()
    for (const row of rows) {
      const entry = names.get(row.name) ?? {
        Name: row.name,
        Aggregation: row.aggregation,
        sources: new Map(),
      }
      entry.sources.set(row.source, [...(entry.sources.get(row.source) ?? []), row])
      names.set(row.name, entry)
    }
    return jsonRes(
      200,
      [...names.values()].map((entry) => ({
        Name: entry.Name,
        Aggregation: entry.Aggregation,
        Sources: [...entry.sources].map(([Name, samples]) => ({
          Name,
          Samples: samples.map((s) => ({ Value: s.value, TimeISO8601: s.time })),
        })),
      })),
    )
  }
}
