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
export type { WhoopRuntime, WhoopRuntimeOptions } from "./runtime.js"
export { createRuntime, WHOOP_PRESETS } from "./runtime.js"
export const WHOOP_NAMESPACE = "whoop"
export const COLLECTION_SCOPES = {
  workout: "read:workout",
  sleep: "read:sleep",
  recovery: "read:recovery",
  cycle: "read:cycles",
  profile: "read:profile",
} as const
/** Every scope WHOOP documents; `offline` is the one that makes the token response carry a refresh token. */
export const KNOWN_SCOPES = [
  "offline",
  "read:recovery",
  "read:cycles",
  "read:workout",
  "read:sleep",
  "read:profile",
  "read:body_measurement",
] as const
/** WHOOP's authorization server (Ory Hydra) rejects a `state` shorter than this. */
export const MIN_STATE_LENGTH = 8
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
  /** Scopes the client may request. Omitted: the scopes WHOOP documents (`KNOWN_SCOPES`). */
  scopes?: string[]
}
/**
 * What `GET /oauth/oauth2/auth` does for a client (row id = client id, `*` = every client without
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
export type WhoopAPIOptions = APIOptions & {
  grants?: Grant[]
  clients?: Client[]
  codes?: OAuthCode[]
  consents?: Consent[]
  records?: DataRecord[]
  pageSize?: number
  tokenTtlSeconds?: number
}
const unauthorized = () => jsonRes(401, { message: "Unauthorized" })
const oauthError = (error: string, description: string) =>
  jsonRes(400, { error, error_description: description })
const isWebUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
const redirect = (target: URL) =>
  new Response(null, { status: 302, headers: { location: target.toString() } })
export class WhoopAPI implements FetchAPI {
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
    Pick<WhoopAPIOptions, "grants" | "clients" | "codes" | "consents" | "records">
  >
  private readonly pageSize: number
  private readonly ttl: number
  constructor(options: WhoopAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? WHOOP_NAMESPACE
    this.now = options.now ?? Date.now
    this.grants = new Collection(sqlite, namespace, "grants")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.consents = new Collection(sqlite, namespace, "consents")
    this.records = new Collection(sqlite, namespace, "records")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.pageSize = options.pageSize ?? 10
    this.ttl = options.tokenTtlSeconds ?? 3600
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1)
      throw new Error("pageSize must be positive")
    this.fixtures = structuredClone({
      grants: options.grants ?? [
        {
          token: "mock_whoop_token",
          refreshToken: "mock_whoop_refresh",
          clientId: "mock_client",
          userId: "synthetic-user",
          scopes: ["read:cycles", "read:recovery", "read:workout", "read:sleep", "offline"],
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
        GetProfileBasic: (c) => this.profile(c),
        ListWorkout: (c) => this.list(c, "workout"),
        ListSleep: (c) => this.list(c, "sleep"),
        ListRecovery: (c) => this.list(c, "recovery"),
        ListCycle: (c) => this.list(c, "cycle"),
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
      jsonRes(status, { error, error_description: description })
    if (!clientId) return failure(400, "invalid_request", "Missing required parameter client_id.")
    const client = this.clients.get(clientId)
    if (!client) return failure(401, "invalid_client", "Client authentication failed.")
    const redirectUri = query.get("redirect_uri") ?? ""
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
    const scopes = [...new Set((query.get("scope") ?? "").split(/\s+/).filter(Boolean))],
      allowed: readonly string[] = client.scopes ?? KNOWN_SCOPES
    const unknown = scopes.find((s) => !allowed.includes(s))
    if (unknown !== undefined)
      return bounce("invalid_scope", `The scope ${unknown} is not allowed.`)
    if ((state ?? "").length < MIN_STATE_LENGTH)
      return bounce(
        "invalid_state",
        `Parameter state must be at least ${MIN_STATE_LENGTH} characters long.`,
      )
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
      redirectUri,
      ...(challenge ? { challenge } : {}),
      expiresAt: this.now() + (consent?.codeTtlSeconds ?? 600) * 1000,
    })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    target.searchParams.set("state", state ?? "")
    return redirect(target)
  }
  private profile(c: OperationContext): Response {
    const grant = this.grants.get(bearerToken(c.request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return unauthorized()
    if (!grant.scopes.includes(COLLECTION_SCOPES.profile))
      return jsonRes(403, { detail: "Access forbidden." })
    const row = this.records
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find((r) => r.collection === "profile" && r.userId === grant.userId)
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
      this.grants.delete(previous.token)
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
      if (!this.codes.has(code.code) || code.expiresAt <= this.now())
        return oauthError("invalid_grant", "Authorization code already used.")
      this.codes.delete(code.code)
    } else return oauthError("unsupported_grant_type", "Unsupported grant_type.")
    const token = this.ids.next("mock_access"),
      refreshToken = this.ids.next("mock_refresh")
    this.grants.insert(token, {
      token,
      refreshToken: scopes.includes("offline") ? refreshToken : "",
      clientId,
      userId,
      scopes,
      expiresAt: this.now() + this.ttl * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      ...(scopes.includes("offline") ? { refresh_token: refreshToken } : {}),
      scope: scopes.join(" "),
      expires_in: this.ttl,
      token_type: "bearer",
    })
  }
  private list(c: OperationContext, collection: CollectionName): Response {
    const grant = this.grants.get(bearerToken(c.request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return unauthorized()
    if (!grant.scopes.includes(COLLECTION_SCOPES[collection]))
      return jsonRes(403, { detail: "Access forbidden." })
    const query = new URL(c.request.url).searchParams
    const from = query.get("start"),
      to = query.get("end") ?? new Date(this.now()).toISOString()
    const limit = Number(query.get("limit") ?? this.pageSize)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25 ||
      (from && !Number.isFinite(Date.parse(from))) ||
      !Number.isFinite(Date.parse(to))
    )
      return jsonRes(400, { message: "Invalid collection parameters" })
    const all = this.records
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.userId === grant.userId)
    const startTime = (row: DataRecord) => {
      // Recovery has no start/end/id. Its related sleep supplies its time window.
      const data =
        collection === "recovery"
          ? all.find((r) => r.collection === "sleep" && r.data.id === row.data.sleep_id)?.data
          : row.data
      return Date.parse(String(data?.start ?? ""))
    }
    const rows = all
      .filter((r) => r.collection === collection)
      .filter(
        (r) =>
          Number.isFinite(startTime(r)) &&
          (!from || startTime(r) >= Date.parse(from)) &&
          startTime(r) < Date.parse(to),
      )
      .sort((a, b) => startTime(b) - startTime(a))
    const cursor = query.get("nextToken"),
      offset = cursor ? rows.findIndex((r) => r.key === cursor) + 1 : 0
    if (cursor && offset === 0) return jsonRes(400, { message: "Invalid nextToken" })
    const page = rows.slice(offset, offset + limit)
    return jsonRes(200, {
      records: page.map((r) => r.data),
      ...(offset + page.length < rows.length ? { next_token: page.at(-1)?.key } : {}),
    })
  }
}
