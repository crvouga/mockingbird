import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  basicAuth,
  bearerToken,
  bodyIssues,
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
export type { PolarRuntime, PolarRuntimeOptions } from "./runtime.js"
export { createRuntime, POLAR_PRESETS } from "./runtime.js"

export const POLAR_NAMESPACE = "polar"
/** The only scope AccessLink defines. */
export const POLAR_SCOPE = "accesslink.read_all"
/** The `expires_in` every token response carries (the reference example). Tokens never expire. */
export const EXPIRES_IN = 31535999
/** Exercises older than this are not returned, whenever they were uploaded. */
export const EXERCISE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** An authorization code is good for this long on the emulator clock. */
export const CODE_TTL_MS = 10 * 60 * 1000

export type Client = { id: string; secret: string; redirectUris?: string[] }
/** A Polar Flow account. Registration is separate: see `Registration`. */
export type User = {
  xUserId: number
  firstName?: string
  lastName?: string
  birthdate?: string
  gender?: string
  weight?: number
  height?: number
}
/** A user registered with a client (`POST /v3/users`). Times are ISO 8601 strings. */
export type RegistrationSeed = {
  clientId?: string
  xUserId: number
  memberId: string
  registeredAt: string
}
export type Registration = {
  clientId: string
  xUserId: number
  memberId: string
  registeredAt: number
}
export type TokenGrant = { token: string; clientId: string; xUserId: number; revoked: boolean }
export type OAuthCode = {
  code: string
  clientId: string
  xUserId: number
  redirectUri: string | null
  expiresAt: number
}
/**
 * An exercise as a fixture: the public item (`id`, `start_time`, ... as AccessLink returns it)
 * plus the owner and the upload time. `device`, `sport`, `start_time_utc_offset` and `duration`
 * default when omitted, so a minimal `{xUserId, id, upload_time, start_time}` still parses.
 * `samples`, `heart_rate_zones` and `route` are returned only when asked for.
 */
export type ExerciseSeed = {
  xUserId: number
  id: string
  upload_time: string
  start_time: string
  [field: string]: unknown
}
export type ExerciseRow = {
  id: string
  xUserId: number
  uploadTime: number
  data: Record<string, unknown>
}
export type ConsentMode = "approve" | "deny" | "error"
/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** What the consent page does. Default `approve`. */
  consent: ConsentMode
  /** Who consents. Default: the first user. */
  consentUser: number | null
}
export const DEFAULT_SETTINGS: Settings = { consent: "approve", consentUser: null }

export type PolarAPIOptions = APIOptions & {
  clients?: Client[]
  users?: User[]
  registrations?: RegistrationSeed[]
  exercises?: ExerciseSeed[]
  tokens?: TokenGrant[]
  codes?: OAuthCode[]
  settings?: Partial<Settings>
}

const oauthError = (error: string, description: string) =>
  jsonRes(400, { error, error_description: description })
const ERROR_TYPES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  415: "Unsupported Media Type",
}
const REGISTER_HINT = "User must be registered with the client before exercises are available."

const isoOf = (field: string, value: string): number => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO 8601 date-time: ${value}`)
  return ms
}

const FLAGS = ["samples", "zones", "route"] as const
const EXTRA_BY_FLAG = { samples: "samples", zones: "heart_rate_zones", route: "route" } as const

export class PolarAPI implements FetchAPI {
  readonly app: Hono
  readonly clients: Collection<Client>
  readonly users: Collection<User>
  readonly registrations: Collection<Registration>
  readonly exercises: Collection<ExerciseRow>
  readonly tokens: Collection<TokenGrant>
  readonly codes: Collection<OAuthCode>
  private readonly settingsRow: Collection<Settings>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: {
    clients: Client[]
    users: User[]
    registrations: RegistrationSeed[]
    exercises: ExerciseSeed[]
    tokens: TokenGrant[]
    codes: OAuthCode[]
    settings: Settings
  }

  constructor(options: PolarAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? POLAR_NAMESPACE
    this.now = options.now ?? Date.now
    this.clients = new Collection(sqlite, namespace, "clients")
    this.users = new Collection(sqlite, namespace, "users")
    this.registrations = new Collection(sqlite, namespace, "registrations")
    this.exercises = new Collection(sqlite, namespace, "exercises")
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.settingsRow = new Collection(sqlite, namespace, "settings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.fixtures = structuredClone({
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      users: options.users ?? [{ xUserId: 1001 }],
      registrations: options.registrations ?? [],
      exercises: options.exercises ?? [],
      tokens: options.tokens ?? [
        { token: "mock_polar_token", clientId: "mock_client", xUserId: 1001, revoked: false },
      ],
      codes: options.codes ?? [],
      settings: { ...DEFAULT_SETTINGS, ...options.settings },
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => this.apiError(404, "Not Found"),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        Authorize: (c) => this.authorize(c),
        OAuthToken: (c) => this.exchange(c),
        RegisterUser: (c) => this.register(c),
        ListExercises: (c) => this.listExercises(c),
        GetExercise: (c) => this.getExercise(c),
      }),
    })
    this.app = this.service.app
  }

  private seed() {
    if (this.initialized.has("seed")) return
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const u of this.fixtures.users) this.users.insert(String(u.xUserId), u)
    for (const r of this.fixtures.registrations) this.addRegistration(r)
    for (const e of this.fixtures.exercises) this.addExercise(e)
    for (const t of this.fixtures.tokens) this.tokens.insert(t.token, t)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    this.settingsRow.insert("current", this.fixtures.settings)
    this.initialized.insert("seed", { value: true })
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }

  settings(): Settings {
    return this.settingsRow.get("current") ?? DEFAULT_SETTINGS
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch }
    this.settingsRow.update("current", next)
    return next
  }

  addUser(user: User): User {
    this.users.insert(String(user.xUserId), user)
    return user
  }

  /** Register a user with a client at a given time (`clientId` defaults to the first client). */
  addRegistration(seed: RegistrationSeed): Registration {
    const registration: Registration = {
      clientId: seed.clientId ?? this.clients.list({ order: "oldest" })[0]?.value.id ?? "",
      xUserId: seed.xUserId,
      memberId: seed.memberId,
      registeredAt: isoOf("registeredAt", seed.registeredAt),
    }
    this.registrations.insert(`${registration.clientId}:${registration.xUserId}`, registration)
    return registration
  }

  addExercise(seed: ExerciseSeed): ExerciseRow {
    const { xUserId, ...data } = seed
    const uploadTime = isoOf("upload_time", seed.upload_time)
    isoOf("start_time", seed.start_time)
    const row: ExerciseRow = { id: seed.id, xUserId, uploadTime, data }
    this.exercises.insert(seed.id, row)
    return row
  }

  /** Mark an access token revoked: every API call with it answers 401 from then on. */
  revoke(token: string): boolean {
    const grant = this.tokens.get(token)
    if (!grant) return false
    this.tokens.update(token, { ...grant, revoked: true })
    return true
  }

  private apiError(status: number, message: string, headers?: Record<string, string>) {
    return jsonRes(
      status,
      {
        error: {
          timestamp: new Date(this.now()).toISOString(),
          status,
          errorType: ERROR_TYPES[status] ?? "Error",
          message,
        },
      },
      headers,
    )
  }

  /** The grant behind a bearer token, or the 401 to answer with. */
  private authenticate(request: Request): TokenGrant | Response {
    const grant = this.tokens.get(bearerToken(request) ?? "")
    if (!grant || grant.revoked)
      return this.apiError(401, "Access token is missing, invalid or revoked.")
    return grant
  }

  private authorize(c: OperationContext): Response {
    const query = c.url.searchParams
    const client = this.clients.get(query.get("client_id") ?? "")
    if (!client) return oauthError("invalid_client", "Unknown client_id.")
    const redirect = query.get("redirect_uri") ?? client.redirectUris?.[0]
    if (
      !redirect ||
      !URL.canParse(redirect) ||
      (client.redirectUris && !client.redirectUris.includes(redirect))
    )
      return oauthError("invalid_request", "redirect_uri is missing or not registered.")
    const back = new URL(redirect)
    const state = query.get("state")
    const fail = (error: string, description: string) => {
      back.searchParams.set("error", error)
      back.searchParams.set("error_description", description)
      if (state !== null) back.searchParams.set("state", state)
      return new Response(null, { status: 302, headers: { location: back.toString() } })
    }
    if (query.get("response_type") !== "code")
      return fail("unsupported_response_type", "response_type must be code.")
    const scope = query.get("scope")
    if (scope !== null && scope !== POLAR_SCOPE)
      return fail("invalid_scope", `The only scope is ${POLAR_SCOPE}.`)
    const settings = this.settings()
    if (settings.consent === "deny") return fail("access_denied", "The user denied access.")
    if (settings.consent === "error")
      return fail("server_error", "The consent page failed to complete.")
    const xUserId =
      settings.consentUser ?? this.users.list({ order: "oldest" })[0]?.value.xUserId ?? 0
    if (!this.users.has(String(xUserId))) return fail("server_error", `Unknown user ${xUserId}.`)
    const code = this.ids.next("polar_code")
    this.codes.insert(code, {
      code,
      clientId: client.id,
      xUserId,
      redirectUri: query.get("redirect_uri"),
      expiresAt: this.now() + CODE_TTL_MS,
    })
    back.searchParams.set("code", code)
    if (state !== null) back.searchParams.set("state", state)
    return new Response(null, { status: 302, headers: { location: back.toString() } })
  }

  private exchange(c: OperationContext): Response {
    const basic = basicAuth(c.request)
    const client = basic ? this.clients.get(basic.username) : undefined
    if (!client || client.secret !== basic?.password)
      return oauthError("invalid_client", "Client authentication failed.")
    if (c.body.kind !== "form")
      return oauthError("invalid_request", "Expected an application/x-www-form-urlencoded body.")
    const form = new URLSearchParams(c.body.value as Record<string, string>)
    // The reference allows only authorization_code; it names no error for any other grant, so
    // refresh_token (which AccessLink has no concept of) is invalid_request. Best guess.
    if (form.get("grant_type") !== "authorization_code")
      return oauthError("invalid_request", "grant_type must be authorization_code.")
    const code = this.codes.get(form.get("code") ?? "")
    if (!code || code.clientId !== client.id || code.expiresAt <= this.now())
      return oauthError("invalid_grant", "The authorization code is invalid, used or expired.")
    const redirect = form.get("redirect_uri")
    if (redirect !== null && code.redirectUri !== null && redirect !== code.redirectUri)
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request.")
    this.codes.delete(code.code)
    const token = this.ids.next("polar_access")
    this.tokens.insert(token, {
      token,
      clientId: client.id,
      xUserId: code.xUserId,
      revoked: false,
    })
    return jsonRes(200, {
      access_token: token,
      token_type: "bearer",
      expires_in: EXPIRES_IN,
      x_user_id: code.xUserId,
    })
  }

  private register(c: OperationContext): Response {
    const grant = this.authenticate(c.request)
    if (grant instanceof Response) return grant
    const issues = bodyIssues(c)
    const first = issues[0]
    if (first)
      return first.kind === "media_type"
        ? this.apiError(415, first.message)
        : this.apiError(400, `${first.path || "body"}: ${first.message}`.trim())
    const input = (c.body.kind === "json" ? c.body.value : {}) as Record<string, unknown>
    const memberId = String(input["member-id"])
    const key = `${grant.clientId}:${grant.xUserId}`
    if (this.registrations.has(key)) return this.apiError(409, "User is already registered.")
    const taken = this.registrations
      .list()
      .some((r) => r.value.clientId === grant.clientId && r.value.memberId === memberId)
    if (taken) return this.apiError(409, "member-id is already in use.")
    const registration: Registration = {
      clientId: grant.clientId,
      xUserId: grant.xUserId,
      memberId,
      registeredAt: this.now(),
    }
    this.registrations.insert(key, registration)
    const user = this.users.get(String(grant.xUserId))
    return jsonRes(200, {
      "polar-user-id": grant.xUserId,
      "member-id": memberId,
      "registration-date": new Date(registration.registeredAt).toISOString(),
      "first-name": user?.firstName ?? "Synthetic",
      "last-name": user?.lastName ?? "User",
      birthdate: user?.birthdate ?? "1985-09-06",
      gender: user?.gender ?? "MALE",
      weight: user?.weight ?? 66.0,
      height: user?.height ?? 170.0,
      "extra-info": [],
    })
  }

  /** The caller's registration, or the error to answer with: 401, or 403 when unregistered. */
  private registered(c: OperationContext): { grant: TokenGrant; since: number } | Response {
    const grant = this.authenticate(c.request)
    if (grant instanceof Response) return grant
    const registration = this.registrations.get(`${grant.clientId}:${grant.xUserId}`)
    if (!registration) return this.apiError(403, REGISTER_HINT)
    return { grant, since: Math.max(registration.registeredAt, this.now() - EXERCISE_WINDOW_MS) }
  }

  /** `samples`, `zones` and `route` default to false and must read true or false. */
  private flags(c: OperationContext): Record<(typeof FLAGS)[number], boolean> | Response {
    const out = { samples: false, zones: false, route: false }
    for (const flag of FLAGS) {
      const value = c.url.searchParams.get(flag)
      if (value === null) continue
      if (value !== "true" && value !== "false")
        return this.apiError(400, `${flag} must be true or false.`)
      out[flag] = value === "true"
    }
    return out
  }

  private view(row: ExerciseRow, flags: Record<(typeof FLAGS)[number], boolean>) {
    const { samples, heart_rate_zones, route, ...base } = row.data
    const extras: Record<string, unknown> = { samples, heart_rate_zones, route }
    return {
      device: "Polar Vantage V",
      device_id: "1111AAAA",
      start_time_utc_offset: 0,
      duration: "PT30M",
      calories: 300,
      distance: 5000.0,
      heart_rate: { average: 140, maximum: 170 },
      sport: "RUNNING",
      detailed_sport_info: "RUNNING",
      has_route: false,
      ...base,
      id: row.id,
      polar_user: `https://www.polaraccesslink.com/v3/users/${row.xUserId}`,
      ...Object.fromEntries(
        FLAGS.filter((f) => flags[f]).map((f) => [
          EXTRA_BY_FLAG[f],
          extras[EXTRA_BY_FLAG[f]] ?? [],
        ]),
      ),
    }
  }

  private listExercises(c: OperationContext): Response {
    const caller = this.registered(c)
    if (caller instanceof Response) return caller
    const flags = this.flags(c)
    if (flags instanceof Response) return flags
    const rows = this.exercises
      .list({
        order: "oldest",
        where: (r) => r.xUserId === caller.grant.xUserId && r.uploadTime >= caller.since,
      })
      .map((r) => r.value)
      .sort((a, b) => a.uploadTime - b.uploadTime)
    return jsonRes(
      200,
      rows.map((r) => this.view(r, flags)),
    )
  }

  private getExercise(c: OperationContext): Response {
    const caller = this.registered(c)
    if (caller instanceof Response) return caller
    const flags = this.flags(c)
    if (flags instanceof Response) return flags
    const row = this.exercises.get(c.params.id ?? "")
    if (!row || row.xUserId !== caller.grant.xUserId || row.uploadTime < caller.since)
      return this.apiError(404, "Exercise not found.")
    return jsonRes(200, this.view(row, flags))
  }
}
