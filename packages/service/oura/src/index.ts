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
export type { OuraRuntime, OuraRuntimeOptions } from "./runtime.js"
export { createRuntime, OURA_PRESETS } from "./runtime.js"
export const OURA_NAMESPACE = "oura"
export const COLLECTION_SCOPES = {
  workout: "workout",
  sleep: "daily",
  heartrate: "heartrate",
  daily_activity: "daily",
  daily_spo2: "spo2",
  daily_readiness: "daily",
  daily_sleep: "daily",
  personal_info: "personal",
} as const
/** The scopes Oura documents; a request that omits `scope` is granted all of them. */
export const KNOWN_SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "tag",
  "session",
  "spo2",
] as const
export type CollectionName = keyof typeof COLLECTION_SCOPES
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
export type Client = {
  id: string
  secret: string
  /** Exact-match redirect URIs. Omitted: any absolute http(s) `redirect_uri` is accepted. */
  redirectUris?: string[]
  /** Scopes the client may request. Omitted: the scopes Oura documents (`KNOWN_SCOPES`). */
  scopes?: string[]
}
/**
 * What `GET /oauth/authorize` does for a client (row id = client id, `*` = every client without
 * a row of its own). The emulator has no consent page; this row is the user's answer.
 */
export type Consent = {
  id: string
  /** `approve` mints a code, `deny` redirects `access_denied`, `error` redirects `error` (default `server_error`). */
  decision: "approve" | "deny" | "error"
  /** The seeded user the code is issued for. Default `synthetic-user`. */
  userId?: string
  /** Lifetime of the code in seconds. Default 600. */
  codeTtlSeconds?: number
  error?: string
  errorDescription?: string
}
export type DataRecord = {
  key: string
  userId: string
  collection: CollectionName
  data: Record<string, unknown>
}
export type OuraAPIOptions = APIOptions & {
  grants?: Grant[]
  clients?: Client[]
  codes?: OAuthCode[]
  consents?: Consent[]
  records?: DataRecord[]
  pageSize?: number
  tokenTtlSeconds?: number
}
const unauthorized = () =>
  jsonRes(401, {
    detail:
      "The access token provided is expired, revoked, malformed, or invalid for other reasons.",
  })
const oauthError = (error: string, description: string) =>
  jsonRes(400, { status: 400, error, error_description: description })
const isWebUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
const redirect = (target: URL) =>
  new Response(null, { status: 302, headers: { location: target.toString() } })
export class OuraAPI implements FetchAPI {
  readonly app: Hono
  readonly grants: Collection<Grant>
  readonly clients: Collection<Client>
  readonly codes: Collection<OAuthCode>
  readonly consents: Collection<Consent>
  readonly records: Collection<DataRecord>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: Required<
    Pick<OuraAPIOptions, "grants" | "clients" | "codes" | "consents" | "records">
  >
  private readonly pageSize: number
  private readonly ttl: number
  constructor(options: OuraAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? OURA_NAMESPACE
    this.now = options.now ?? Date.now
    this.grants = new Collection(sqlite, namespace, "grants")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.consents = new Collection(sqlite, namespace, "consents")
    this.records = new Collection(sqlite, namespace, "records")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.pageSize = options.pageSize ?? 100
    this.ttl = options.tokenTtlSeconds ?? 86400
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1)
      throw new Error("pageSize must be positive")
    this.fixtures = structuredClone({
      grants: options.grants ?? [
        {
          token: "mock_oura_token",
          refreshToken: "mock_oura_refresh",
          clientId: "mock_client",
          userId: "synthetic-user",
          scopes: ["daily", "workout", "heartrate", "spo2"],
          expiresAt: 4102444800000,
        },
      ],
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      codes: options.codes ?? [],
      consents: options.consents ?? [],
      records: options.records ?? [],
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { detail: "Not Found" }),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthAuthorize: (c) => this.authorize(c),
        OAuthToken: (c) => this.exchange(c),
        GetPersonalInfo: (c) => this.personalInfo(c),
        ListWorkout: (c) => this.list(c, "workout"),
        ListSleep: (c) => this.list(c, "sleep"),
        ListHeartrate: (c) => this.list(c, "heartrate"),
        ListDailyActivity: (c) => this.list(c, "daily_activity"),
        ListDailySpo2: (c) => this.list(c, "daily_spo2"),
        ListDailyReadiness: (c) => this.list(c, "daily_readiness"),
        ListDailySleep: (c) => this.list(c, "daily_sleep"),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const g of this.fixtures.grants) this.grants.insert(g.token, g)
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    for (const c of this.fixtures.consents) this.consents.insert(c.id, c)
    for (const r of this.fixtures.records) this.records.insert(r.key, r)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  private authorize(c: OperationContext): Response {
    const query = new URL(c.request.url).searchParams
    const clientId = query.get("client_id") ?? ""
    const failure = (status: number, error: string, description: string) =>
      jsonRes(status, { status, error, error_description: description })
    if (!clientId) return failure(400, "invalid_request", "Missing required parameter client_id.")
    const client = this.clients.get(clientId)
    if (!client) return failure(401, "invalid_client", "Client authentication failed.")
    // Optional: a client with exactly one registered redirect URI falls back to it.
    const sent = query.get("redirect_uri") || undefined,
      redirectUri = sent ?? (client.redirectUris?.length === 1 ? client.redirectUris[0] : undefined)
    if (!redirectUri)
      return failure(400, "invalid_request", "Missing required parameter redirect_uri.")
    // Never redirect to a URI the client did not register: answer in place instead.
    if (client.redirectUris ? !client.redirectUris.includes(redirectUri) : !isWebUrl(redirectUri))
      return failure(400, "invalid_request", "The redirect_uri is not registered for the client.")
    const state = query.get("state")
    const bounce = (error: string, description: string) => {
      const target = new URL(redirectUri)
      target.searchParams.set("error", error)
      target.searchParams.set("error_description", description)
      if (state !== null) target.searchParams.set("state", state)
      return redirect(target)
    }
    const responseType = query.get("response_type")
    if (!responseType) return bounce("invalid_request", "Missing required parameter response_type.")
    if (responseType !== "code")
      return bounce("unsupported_response_type", "Only response_type=code is supported.")
    const allowed: readonly string[] = client.scopes ?? KNOWN_SCOPES,
      requested = query.get("scope")
    // Oura: "If left blank, the application will request all available scopes."
    const scopes = requested?.trim()
      ? [...new Set(requested.split(/\s+/).filter(Boolean))]
      : [...allowed]
    const unknown = scopes.find((s) => !allowed.includes(s))
    if (unknown !== undefined)
      return bounce("invalid_scope", `The scope ${unknown} is not allowed.`)
    const challenge = query.get("code_challenge") ?? undefined
    if (challenge !== undefined && query.get("code_challenge_method") !== "S256")
      return bounce("invalid_request", "Only code_challenge_method=S256 is supported.")
    const consent = this.consents.get(clientId) ?? this.consents.get("*")
    if (consent?.decision === "deny")
      return bounce(
        consent.error ?? "access_denied",
        consent.errorDescription ?? "The resource owner denied the request.",
      )
    if (consent?.decision === "error")
      return bounce(
        consent.error ?? "server_error",
        consent.errorDescription ?? "The authorization server encountered an error.",
      )
    const code = this.ids.next("mock_code")
    this.codes.insert(code, {
      code,
      clientId,
      userId: consent?.userId ?? "synthetic-user",
      scopes,
      // Only a redirect_uri the caller sent binds the code; the token exchange must then repeat it.
      ...(sent ? { redirectUri: sent } : {}),
      ...(challenge ? { challenge } : {}),
      expiresAt: this.now() + (consent?.codeTtlSeconds ?? 600) * 1000,
    })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    if (state !== null) target.searchParams.set("state", state)
    return redirect(target)
  }
  private personalInfo(c: OperationContext): Response {
    const grant = this.grants.get(bearerToken(c.request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return unauthorized()
    if (!grant.scopes.includes(COLLECTION_SCOPES.personal_info))
      return jsonRes(403, { detail: "Access forbidden." })
    const row = this.records
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find((r) => r.collection === "personal_info" && r.userId === grant.userId)
    return row ? jsonRes(200, row.data) : jsonRes(404, { detail: "Not Found" })
  }
  private async exchange(c: OperationContext): Promise<Response> {
    const body = new URLSearchParams(
        c.body.kind === "form" ? (c.body.value as Record<string, string>) : {},
      ),
      basic = basicAuth(c.request)
    const clientId = basic?.username ?? body.get("client_id") ?? "",
      client = this.clients.get(clientId)
    if (!client || client.secret !== (basic?.password ?? body.get("client_secret")))
      return oauthError("invalid_client", "Invalid client_id.")
    if (!c.request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      return oauthError("invalid_request", "Expected form encoded body.")
    let userId: string, scopes: string[]
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
      if (!previous) return oauthError("invalid_grant", "Invalid refresh_token.")
      userId = previous.userId
      scopes = previous.scopes
      this.grants.update(previous.token, { ...previous, refreshToken: "" })
    } else if (body.get("grant_type") === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "")
      if (
        !code ||
        code.clientId !== clientId ||
        code.expiresAt <= this.now() ||
        code.redirectUri !== (body.get("redirect_uri") ?? undefined)
      )
        return oauthError("invalid_grant", "Invalid authorization code.")
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
          return oauthError("invalid_grant", "Invalid code_verifier.")
      }
      userId = code.userId
      scopes = code.scopes
      // PKCE hashing yielded: re-check before the synchronous claim to reject a concurrent replay.
      if (!this.codes.has(code.code) || code.expiresAt <= this.now())
        return oauthError("invalid_grant", "Authorization code already used or expired.")
      this.codes.delete(code.code)
    } else return oauthError("unsupported_grant_type", "Unsupported grant_type.")
    const token = this.ids.next("mock_access"),
      refreshToken = this.ids.next("mock_refresh")
    this.grants.insert(token, {
      token,
      refreshToken,
      clientId,
      userId,
      scopes,
      expiresAt: this.now() + this.ttl * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: this.ttl,
      token_type: "bearer",
    })
  }
  private list(c: OperationContext, collection: CollectionName): Response {
    const grant = this.grants.get(bearerToken(c.request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return unauthorized()
    if (!grant.scopes.includes(COLLECTION_SCOPES[collection]))
      return jsonRes(403, { detail: "Access forbidden." })
    const query = new URL(c.request.url).searchParams,
      timed = collection === "heartrate"
    const from = query.get(timed ? "start_datetime" : "start_date"),
      to = query.get(timed ? "end_datetime" : "end_date")
    const valid = (s: string) =>
      Number.isFinite(Date.parse(s)) && (timed ? /T/.test(s) : /^\d{4}-\d{2}-\d{2}(T|$)/.test(s))
    if (
      (from && !valid(from)) ||
      (to && !valid(to)) ||
      (from && to && Date.parse(from) > Date.parse(to))
    )
      return jsonRes(400, { detail: "Invalid date range." })
    const rows = this.records
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.userId === grant.userId && r.collection === collection)
      .filter((r) => {
        const date = String(r.data[timed ? "timestamp" : "day"] ?? ""),
          time = Date.parse(date)
        return (!from || time >= Date.parse(from)) && (!to || time <= Date.parse(to))
      })
    const cursor = query.get("next_token"),
      offset = cursor ? rows.findIndex((r) => r.key === cursor) + 1 : 0
    if (cursor && offset === 0) return jsonRes(400, { detail: "Invalid next_token." })
    const page = rows.slice(offset, offset + this.pageSize)
    return jsonRes(200, {
      data: page.map((r) => r.data),
      next_token: offset + page.length < rows.length ? page.at(-1)?.key : null,
    })
  }
}
